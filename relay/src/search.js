// Brave Search proxy and recipe-page fetching.
import { HttpError, fetchWithTimeout } from './http.js';
import { extractRecipe } from './recipe.js';
import { DAY, getJson, putJson, urlKey } from './store.js';

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search';

// Sites that show up for recipe queries but never have usable Recipe markup.
const SKIP_HOSTS = /(^|\.)(youtube\.com|youtu\.be|pinterest\.[a-z.]+|reddit\.com|facebook\.com|instagram\.com|tiktok\.com|amazon\.[a-z.]+|x\.com|twitter\.com|quora\.com|wikipedia\.org)$/i;

export async function braveSearch(env, query, { count = 20, fetchImpl = fetch } = {}) {
  if (!env.BRAVE_API_KEY) throw new HttpError(500, 'not_configured', 'BRAVE_API_KEY secret is not set.');
  const q = String(query || '').trim().slice(0, 300);
  if (!q) return [];

  const cacheKey = await urlKey('brave', `${count}|${q.toLowerCase()}`);
  const cached = await getJson(env, cacheKey);
  if (cached) return cached;

  const url = `${BRAVE_URL}?${new URLSearchParams({ q, count: String(count), safesearch: 'moderate' })}`;
  const res = await fetchWithTimeout(fetchImpl, url, {
    headers: { accept: 'application/json', 'x-subscription-token': env.BRAVE_API_KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new HttpError(502, 'brave_error', `Brave Search returned ${res.status}.`, body.slice(0, 500));
  }
  const data = await res.json();
  const results = (data?.web?.results || [])
    .map((r) => ({ url: r.url, title: r.title, description: r.description, site: hostOf(r.url) }))
    .filter((r) => r.url && r.site && !SKIP_HOSTS.test(r.site));
  await putJson(env, cacheKey, results, 7 * DAY);
  return results;
}

export async function searchMany(env, queries, opts) {
  const list = (Array.isArray(queries) ? queries : []).map(String).filter(Boolean).slice(0, 5);
  if (!list.length) throw new HttpError(400, 'bad_request', 'Provide 1-5 queries.');
  const perQuery = await Promise.all(list.map((q) => braveSearch(env, q, opts)));
  // Interleave results so every query gets representation near the top.
  const seen = new Set();
  const merged = [];
  const maxLen = Math.max(...perQuery.map((r) => r.length));
  for (let i = 0; i < maxLen; i++) {
    perQuery.forEach((results, qi) => {
      const r = results[i];
      if (!r) return;
      const key = canonicalUrl(r.url);
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({ ...r, query: list[qi] });
    });
  }
  return merged;
}

const PAGE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};
const MAX_PAGE_BYTES = 4_000_000;

// Fetch one page and return its parsed recipe, or null. Results (including
// "no recipe here") are cached so repeat searches cost nothing.
export async function fetchRecipe(env, rawUrl, { fetchImpl = fetch, refresh = false } = {}) {
  const url = validatePublicUrl(rawUrl);
  const cacheKey = await urlKey('recipe', canonicalUrl(url));
  if (!refresh) {
    const cached = await getJson(env, cacheKey);
    if (cached) return cached.none ? { recipe: null, reason: cached.reason, cached: true } : { recipe: cached, cached: true };
  }

  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, url, { headers: PAGE_HEADERS, redirect: 'follow' }, 9000);
  } catch (err) {
    return { recipe: null, reason: `fetch failed: ${err.name === 'TimeoutError' ? 'timeout' : err.message}` };
  }
  if (!res.ok) {
    // Don't cache 403/429 for long: often transient bot-blocking.
    const reason = `HTTP ${res.status}`;
    await putJson(env, cacheKey, { none: true, reason }, res.status === 404 ? 30 * DAY : DAY);
    return { recipe: null, reason };
  }
  const type = res.headers.get('content-type') || '';
  if (type && !/html|xml/i.test(type)) return { recipe: null, reason: `not HTML (${type})` };
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_PAGE_BYTES) return { recipe: null, reason: 'page too large' };

  const html = (await res.text()).slice(0, MAX_PAGE_BYTES);
  const recipe = extractRecipe(html, canonicalUrl(url));
  if (!recipe) {
    await putJson(env, cacheKey, { none: true, reason: 'no Recipe markup' }, 7 * DAY);
    return { recipe: null, reason: 'no Recipe markup' };
  }
  await putJson(env, cacheKey, recipe, 30 * DAY);
  return { recipe, cached: false };
}

export function validatePublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new HttpError(400, 'bad_url', 'Invalid URL.'); }
  if (!/^https?:$/.test(u.protocol)) throw new HttpError(400, 'bad_url', 'Only http(s) URLs.');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
      /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(host) || host.includes(':')) {
    throw new HttpError(400, 'bad_url', 'Private addresses are not allowed.');
  }
  return u.toString();
}

// Drop tracking params and fragments so the same recipe caches once.
export function canonicalUrl(raw) {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|src$)/i.test(p)) u.searchParams.delete(p);
    }
    u.hostname = u.hostname.toLowerCase();
    return u.toString();
  } catch {
    return raw;
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}
