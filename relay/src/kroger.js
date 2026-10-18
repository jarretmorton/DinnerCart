// Kroger (Fred Meyer) API: OAuth, product search, store lookup, cart add.
// Docs: https://developer.kroger.com/documentation/public/
import { HttpError, fetchWithTimeout, randomHex } from './http.js';
import { del, getJson, putJson } from './store.js';
import { isAllowedReturnUrl } from './auth.js';
// Shared with the browser, which searches Kroger directly when it can.
import { cleanTerm, normalizeProduct } from '../../web/js/kroger-shared.js';

export { cleanTerm, normalizeProduct };

const USER_SCOPES = 'cart.basic:write';
const APP_SCOPES = 'product.compact';
const USER_KEY = 'kroger:user';
const APP_KEY = 'kroger:app';
const CART_BATCH = 25;
// Kroger's API sits behind a bot firewall (Akamai). Identify ourselves; it
// tends to reject anonymous requests.
const UA = { 'user-agent': 'DinnerCart/1.0 (household grocery list; +https://github.com/jarretmorton/DinnerCart)' };

// The firewall answers with an HTML "Access Denied" page, not Kroger JSON.
const isFirewallBlock = (res) => res.status === 403 && /html/i.test(res.headers.get('content-type') || '');

// One readable line instead of a page of HTML.
export function describeKrogerError(path, status, body) {
  const text = String(body || '');
  if (status === 403 && /access denied/i.test(text)) return `Kroger ${path} was blocked by Kroger's firewall (403 Access Denied)`;
  const title = text.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
  const detail = title || (text.trim().startsWith('<') ? '' : text.replace(/\s+/g, ' ').slice(0, 160));
  return `Kroger ${path} returned ${status}${detail ? `: ${detail}` : ''}`;
}

function base(env) {
  return (env.KROGER_API_BASE || 'https://api.kroger.com/v1').replace(/\/$/, '');
}

function requireCreds(env) {
  if (!env.KROGER_CLIENT_ID || !env.KROGER_CLIENT_SECRET) {
    throw new HttpError(500, 'not_configured', 'KROGER_CLIENT_ID / KROGER_CLIENT_SECRET secrets are not set.');
  }
}

export function redirectUri(requestUrl) {
  return `${new URL(requestUrl).origin}/kroger/oauth/callback`;
}

async function tokenRequest(env, params, fetchImpl) {
  requireCreds(env);
  const res = await fetchWithTimeout(fetchImpl, `${base(env)}/connect/oauth2/token`, {
    method: 'POST',
    headers: {
      ...UA,
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${env.KROGER_CLIENT_ID}:${env.KROGER_CLIENT_SECRET}`)}`,
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* keep raw text for the error */ }
  if (!res.ok) {
    const err = new HttpError(502, 'kroger_token_error', `Kroger token request failed (${res.status}).`, data.error_description || data.error || text.slice(0, 300));
    err.upstreamStatus = res.status;
    throw err;
  }
  return data;
}

function withExpiry(tokens) {
  return { ...tokens, expires_at: Date.now() + (Number(tokens.expires_in) || 1800) * 1000 };
}

// ---- app token (client credentials) for product/location search ----

let memoryAppToken = null;

export async function getAppToken(env, fetchImpl = fetch) {
  const fresh = (t) => t && t.expires_at > Date.now() + 60_000;
  if (fresh(memoryAppToken)) return memoryAppToken.access_token;
  let tokens = await getJson(env, APP_KEY);
  if (!fresh(tokens)) {
    tokens = withExpiry(await tokenRequest(env, { grant_type: 'client_credentials', scope: APP_SCOPES }, fetchImpl));
    await putJson(env, APP_KEY, tokens, (tokens.expires_at - Date.now()) / 1000);
  }
  memoryAppToken = tokens;
  return tokens.access_token;
}

// The client-credentials token (product.compact only: read-only product
// data, no cart or account access), so the browser can search directly.
export async function appTokenForBrowser(env, fetchImpl = fetch) {
  const access_token = await getAppToken(env, fetchImpl);
  return { access_token, expires_at: memoryAppToken.expires_at };
}

export function resetMemoryToken() {
  memoryAppToken = null;
}

// ---- user token (authorization code) for cart ----

export async function startOAuth(env, requestUrl, returnTo) {
  requireCreds(env);
  const target = returnTo && isAllowedReturnUrl(returnTo, env) ? returnTo : env.APP_URL;
  if (!target) throw new HttpError(400, 'bad_return', 'returnTo must be an allowed app URL (or set APP_URL).');
  const state = randomHex(24);
  await putJson(env, `oauth:state:${state}`, { returnTo: target }, 600);
  const params = new URLSearchParams({
    scope: USER_SCOPES,
    response_type: 'code',
    client_id: env.KROGER_CLIENT_ID,
    redirect_uri: redirectUri(requestUrl),
    state,
  });
  return `${base(env)}/connect/oauth2/authorize?${params.toString().replace(/\+/g, '%20')}`;
}

// Kroger redirects the browser here. No relay password is possible on this
// request, so the one-time `state` value is what authenticates it.
export async function finishOAuth(env, requestUrl, fetchImpl = fetch) {
  const url = new URL(requestUrl);
  const state = url.searchParams.get('state') || '';
  const pending = state ? await getJson(env, `oauth:state:${state}`) : null;
  if (!pending) return new Response('This login link expired or was already used. Start again from DinnerCart settings.', { status: 400 });
  await del(env, `oauth:state:${state}`);

  const back = new URL(pending.returnTo);
  const code = url.searchParams.get('code');
  if (!code) {
    back.searchParams.set('kroger', 'error');
    back.searchParams.set('reason', url.searchParams.get('error') || 'no_code');
    return Response.redirect(back.toString(), 302);
  }
  try {
    const tokens = await tokenRequest(env, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(requestUrl) }, fetchImpl);
    await putJson(env, USER_KEY, { ...withExpiry(tokens), connected_at: new Date().toISOString() });
    back.searchParams.set('kroger', 'connected');
  } catch (err) {
    console.error('oauth exchange failed', err.message, err.details);
    back.searchParams.set('kroger', 'error');
    back.searchParams.set('reason', 'token_exchange_failed');
  }
  return Response.redirect(back.toString(), 302);
}

const authRequired = () => new HttpError(401, 'kroger_auth_required', 'Connect your Fred Meyer account first (Settings → Connect).');

export async function getUserToken(env, fetchImpl = fetch, { forceRefresh = false } = {}) {
  const stored = await getJson(env, USER_KEY);
  if (!stored?.refresh_token && !stored?.access_token) throw authRequired();
  if (!forceRefresh && stored.expires_at > Date.now() + 60_000) return stored.access_token;
  if (!stored.refresh_token) throw authRequired();
  try {
    const tokens = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: stored.refresh_token }, fetchImpl);
    await putJson(env, USER_KEY, {
      ...withExpiry(tokens),
      refresh_token: tokens.refresh_token || stored.refresh_token,
      connected_at: stored.connected_at,
    });
    return tokens.access_token;
  } catch (err) {
    if (err.upstreamStatus === 400 || err.upstreamStatus === 401) {
      await del(env, USER_KEY);
      throw authRequired();
    }
    throw err;
  }
}

export async function userStatus(env) {
  const stored = await getJson(env, USER_KEY);
  return { connected: Boolean(stored?.refresh_token || stored?.access_token), connectedAt: stored?.connected_at || null };
}

export async function disconnect(env) {
  await del(env, USER_KEY);
}

// ---- API calls ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function krogerGet(env, path, fetchImpl, { retries = 2 } = {}) {
  const send = async () => fetchWithTimeout(fetchImpl, `${base(env)}${path}`, {
    headers: { ...UA, accept: 'application/json', authorization: `Bearer ${await getAppToken(env, fetchImpl)}` },
  });
  let res = await send();
  for (let attempt = 0; ; attempt++) {
    if (res.status === 401 && attempt === 0) {
      resetMemoryToken();
      await del(env, APP_KEY);
    } else if (isFirewallBlock(res) && attempt === 0) {
      await sleep(1200);
    } else if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      // Kroger rate-limits bursts; back off briefly (honoring Retry-After up to 3s).
      const retryAfter = Math.min(3, Number(res.headers.get('retry-after')) || 0);
      await sleep(Math.max(retryAfter * 1000, 400 * 2 ** attempt));
    } else {
      break;
    }
    res = await send();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(502, 'kroger_error', describeKrogerError(path.split('?')[0], res.status, body), body.slice(0, 500));
  }
  return res.json();
}

export async function searchProducts(env, term, locationId, { limit = 12, fetchImpl = fetch } = {}) {
  const t = cleanTerm(term);
  if (t.length < 3) return [];
  const params = new URLSearchParams({ 'filter.term': t, 'filter.limit': String(Math.min(50, limit)) });
  if (locationId) params.set('filter.locationId', locationId);
  const data = await krogerGet(env, `/products?${params}`, fetchImpl);
  return (data.data || []).map(normalizeProduct);
}

export async function searchProductsMany(env, terms, locationId, opts = {}) {
  const list = [...new Set((terms || []).map(String).filter(Boolean))];
  if (list.length > 20) throw new HttpError(400, 'too_many_terms', 'At most 20 terms per request.');
  const results = {};
  const errors = {};
  // Get the token first so the searches below don't each request one.
  if (list.length) await getAppToken(env, opts.fetchImpl);
  // A few at a time: Kroger rate-limits bursts of parallel requests.
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const term = list[next++];
      try {
        results[term] = await searchProducts(env, term, locationId, opts);
      } catch (err) {
        console.error('product search failed', term, err.message);
        errors[term] = err.message;
        results[term] = [];
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return { results, errors };
}

// Kroger's chain codes don't match brand names ("FRED MEYER" finds nothing),
// so search every Kroger-family store nearby and keep the Fred Meyer ones by
// name/chain. If none are nearby, return everything so the user still has a choice.
export async function findLocations(env, zip, { brand = /fred/i, fetchImpl = fetch } = {}) {
  if (!/^\d{5}$/.test(String(zip || ''))) throw new HttpError(400, 'bad_zip', 'Enter a 5-digit ZIP code.');
  const params = new URLSearchParams({ 'filter.zipCode.near': zip, 'filter.limit': '50', 'filter.radiusInMiles': '25' });
  const data = await krogerGet(env, `/locations?${params}`, fetchImpl);
  const all = (data.data || [])
    .filter((l) => !/fuel|gas station/i.test(l.name || ''))
    .map((l) => ({
      locationId: l.locationId,
      chain: l.chain,
      name: l.name,
      address: [l.address?.addressLine1, l.address?.city, l.address?.state, l.address?.zipCode].filter(Boolean).join(', '),
    }));
  const matching = all.filter((l) => brand.test(`${l.chain} ${l.name}`));
  return (matching.length ? matching : all).slice(0, 15);
}

export async function addToCart(env, items, modality = 'PICKUP', fetchImpl = fetch) {
  const clean = (items || [])
    .map((i) => ({ upc: String(i.upc || '').trim(), quantity: Math.max(1, Math.min(99, Math.round(Number(i.quantity) || 1))) }))
    .filter((i) => /^\d{6,14}$/.test(i.upc));
  if (!clean.length) throw new HttpError(400, 'bad_items', 'No valid items (each needs a numeric UPC).');
  const mode = modality === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';

  const batches = [];
  for (let i = 0; i < clean.length; i += CART_BATCH) batches.push(clean.slice(i, i + CART_BATCH));

  let added = 0;
  for (const batch of batches) {
    const send = (token) => fetchWithTimeout(fetchImpl, `${base(env)}/cart/add`, {
      method: 'PUT',
      headers: { ...UA, 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ items: batch.map((b) => ({ ...b, modality: mode })) }),
    });
    let res = await send(await getUserToken(env, fetchImpl));
    if (res.status === 401) res = await send(await getUserToken(env, fetchImpl, { forceRefresh: true }));
    // A firewall block never reached Kroger, so retrying can't double-add.
    if (isFirewallBlock(res)) {
      await sleep(1200);
      res = await send(await getUserToken(env, fetchImpl));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new HttpError(502, 'kroger_cart_error', `${describeKrogerError('cart add', res.status, body)}, after ${added} items were added.`, { added, body: body.slice(0, 500) });
    }
    added += batch.length;
  }
  return { added, batches: batches.length };
}
