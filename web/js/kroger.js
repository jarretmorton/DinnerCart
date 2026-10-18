// Product search from the browser. Kroger's API allows browser (CORS)
// requests, and searching from the phone's own connection avoids the bot
// firewall that sometimes blocks the relay's shared Cloudflare servers.
// The relay supplies a short-lived, search-only token (no cart access) and
// is the fallback whenever a direct search fails.
import { KROGER_API, cleanTerm, normalizeProduct } from './kroger-shared.js';
import { mapLimit } from './util.js';

let token = null;
let directOff = false; // set when the browser can't reach Kroger at all (e.g. CORS)

// How the token is sent. 'header' (Authorization) needs the browser's CORS
// preflight to succeed; if it doesn't, 'query' puts it in the URL, which is
// a "simple" request with no preflight.
let authMode = 'header';
let lastRoute = null; // 'direct' | 'relay' | 'mixed', for "Check setup"
let lastProblem = null; // why direct search last failed, in words
export const lastSearchRoute = () => lastRoute;
export const lastDirectProblem = () => lastProblem;
export const directAuthMode = () => authMode;

export function resetDirectSearch() {
  token = null;
  directOff = false;
  authMode = 'header';
  lastRoute = null;
  lastProblem = null;
}

// Relay-only search: chunks to the relay's limit and returns
// {term: products[]}, or {term: {error}} when that search failed.
export function relaySearcher(relay, locationId) {
  return async (terms) => {
    const out = {};
    for (let i = 0; i < terms.length; i += 15) {
      const { results, errors = {} } = await relay.products(terms.slice(i, i + 15), locationId);
      for (const [term, products] of Object.entries(results)) out[term] = errors[term] ? { error: errors[term] } : products;
    }
    return out;
  };
}

// Direct-first search with per-term fallback to the relay.
export function productSearcher(relay, locationId, { fetchImpl = globalThis.fetch.bind(globalThis), concurrency = 3 } = {}) {
  const viaRelay = relaySearcher(relay, locationId);

  async function getToken(force = false) {
    if (force || !token || token.expires_at < Date.now() + 60_000) token = await relay.krogerToken();
    return token.access_token;
  }

  async function searchOne(term) {
    const t = cleanTerm(term);
    if (t.length < 3) return [];
    const params = new URLSearchParams({ 'filter.term': t, 'filter.limit': '12' });
    if (locationId) params.set('filter.locationId', locationId);
    const url = `${KROGER_API}/products?${params}`;
    const send = async (force) => {
      const tok = await getToken(force);
      if (authMode === 'header') {
        try {
          return await fetchImpl(url, { headers: { accept: 'application/json', authorization: `Bearer ${tok}` } });
        } catch (err) {
          if (!(err instanceof TypeError)) throw err;
          authMode = 'query';
          lastProblem = `the browser wouldn't send the search key as a header (${err.message})`;
        }
      }
      return fetchImpl(`${url}&access_token=${encodeURIComponent(tok)}`);
    };
    let res = await send(false);
    if (res.status === 401) res = await send(true);
    if (!res.ok) {
      // A 401 with the key in the URL means Kroger won't take it that way: stop trying direct.
      if (res.status === 401 && authMode === 'query') directOff = true;
      throw new Error(`Kroger returned ${res.status}${res.status === 401 && authMode === 'query' ? ' (it won\'t accept the key in the web address)' : ''}`);
    }
    return ((await res.json()).data || []).map(normalizeProduct);
  }

  return async (terms) => {
    if (directOff) {
      lastRoute = 'relay';
      return viaRelay(terms);
    }
    try {
      await getToken();
    } catch (err) {
      lastRoute = 'relay';
      lastProblem = `couldn't get a search key from the relay (${err.message})`;
      return viaRelay(terms);
    }
    const out = {};
    const failed = [];
    await mapLimit(terms, concurrency, async (term) => {
      try {
        out[term] = await searchOne(term);
      } catch (err) {
        // TypeError = the browser couldn't reach Kroger at all (CORS/network): stop trying direct.
        if (err instanceof TypeError) directOff = true;
        lastProblem = err instanceof TypeError ? `this device couldn't reach Kroger (${err.message})` : err.message;
        failed.push(term);
      }
    });
    lastRoute = !failed.length ? 'direct' : failed.length === terms.length ? 'relay' : 'mixed';
    if (failed.length) Object.assign(out, await viaRelay(failed));
    return out;
  };
}
