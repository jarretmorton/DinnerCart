import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/index.js';
import * as kroger from '../src/kroger.js';
import { fetchRecipe, searchMany, canonicalUrl, validatePublicUrl } from '../src/search.js';
import { jsonRes, makeEnv, mockFetch } from './helpers.js';

const ORIGIN = 'https://example.github.io';
const req = (method, path, { body, password = 'hunter2', origin = ORIGIN } = {}) =>
  new Request(`https://relay.example.workers.dev${path}`, {
    method,
    headers: {
      ...(password ? { 'x-relay-password': password } : {}),
      ...(origin ? { origin } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

beforeEach(() => kroger.resetMemoryToken());

test('rejects requests without the right password', async () => {
  const env = makeEnv();
  for (const password of [null, 'wrong']) {
    const res = await handle(req('GET', '/health', { password }), env);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'bad_password');
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN, 'errors still carry CORS so the browser can read them');
  }
  const ok = await handle(req('GET', '/health'), env);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).configured, { brave: true, kroger: true, kv: true });
});

test('CORS: preflight for allowed origin, nothing for others', async () => {
  const env = makeEnv();
  const pre = await handle(req('OPTIONS', '/search', { password: null }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.match(pre.headers.get('access-control-allow-headers'), /x-relay-password/);
  const evil = await handle(req('OPTIONS', '/search', { password: null, origin: 'https://evil.example' }), env);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('unknown route is 404', async () => {
  const res = await handle(req('GET', '/nope'), makeEnv());
  assert.equal(res.status, 404);
});

test('search merges/dedupes Brave results, skips junk hosts, and caches', async () => {
  const env = makeEnv();
  const brave = (results) => jsonRes({ web: { results } });
  const fetchImpl = mockFetch([
    ['https://api.search.brave.com/', (url) => {
      const q = new URL(url).searchParams.get('q');
      assert.equal(new URL(url).searchParams.get('count'), '20');
      return q === 'a'
        ? brave([{ url: 'https://one.example/r1?utm_source=x', title: '1' }, { url: 'https://www.youtube.com/watch?v=1', title: 'yt' }])
        : brave([{ url: 'https://one.example/r1', title: '1 again' }, { url: 'https://two.example/r2', title: '2' }]);
    }],
  ]);
  const results = await searchMany(env, ['a', 'b'], { fetchImpl });
  assert.deepEqual(results.map((r) => r.url), ['https://one.example/r1?utm_source=x', 'https://two.example/r2']);
  assert.equal(fetchImpl.calls[0].init.headers['x-subscription-token'], 'brave-key');
  await searchMany(env, ['a', 'b'], { fetchImpl });
  assert.equal(fetchImpl.calls.length, 2, 'second search served from KV cache');
});

test('fetchRecipe parses, caches hits and misses', async () => {
  const env = makeEnv();
  const html = `<script type="application/ld+json">{"@type":"Recipe","name":"Pasta","recipeIngredient":["8 oz spaghetti"]}</script>`;
  const fetchImpl = mockFetch([
    ['https://good.example/', () => new Response(html, { headers: { 'content-type': 'text/html' } })],
    ['https://plain.example/', () => new Response('<p>nothing</p>', { headers: { 'content-type': 'text/html' } })],
    ['https://blocked.example/', () => new Response('no', { status: 403 })],
  ]);
  const hit = await fetchRecipe(env, 'https://good.example/pasta#comments', { fetchImpl });
  assert.equal(hit.recipe.name, 'Pasta');
  assert.equal(hit.recipe.url, 'https://good.example/pasta');
  const again = await fetchRecipe(env, 'https://good.example/pasta', { fetchImpl });
  assert.equal(again.cached, true);

  assert.equal((await fetchRecipe(env, 'https://plain.example/x', { fetchImpl })).reason, 'no Recipe markup');
  assert.equal((await fetchRecipe(env, 'https://blocked.example/x', { fetchImpl })).reason, 'HTTP 403');
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal((await fetchRecipe(env, 'https://plain.example/x', { fetchImpl })).cached, true);
});

test('url safety helpers', () => {
  assert.throws(() => validatePublicUrl('file:///etc/passwd'));
  assert.throws(() => validatePublicUrl('http://localhost:8787/x'));
  assert.throws(() => validatePublicUrl('http://192.168.1.1/'));
  assert.throws(() => validatePublicUrl('http://[::1]/'));
  assert.equal(validatePublicUrl('https://Example.com/a'), 'https://example.com/a');
  assert.equal(canonicalUrl('https://a.example/r?utm_medium=x&id=3#top'), 'https://a.example/r?id=3');
});

// ---- Kroger ----

function krogerFetch({ cartStatus = 204, refreshFails = false } = {}) {
  return mockFetch([
    ['https://api.kroger.com/v1/connect/oauth2/token', (_url, init) => {
      const params = new URLSearchParams(init.body);
      assert.equal(init.headers.authorization, `Basic ${btoa('client-id:client-secret')}`);
      const grant = params.get('grant_type');
      if (grant === 'client_credentials') return jsonRes({ access_token: 'app-token', expires_in: 1800 });
      if (grant === 'authorization_code') {
        assert.equal(params.get('redirect_uri'), 'https://relay.example.workers.dev/kroger/oauth/callback');
        return jsonRes({ access_token: 'user-token', refresh_token: 'refresh-1', expires_in: 1800 });
      }
      if (grant === 'refresh_token') {
        if (refreshFails) return jsonRes({ error: 'invalid_grant' }, 400);
        return jsonRes({ access_token: 'user-token-2', refresh_token: 'refresh-2', expires_in: 1800 });
      }
      throw new Error(`grant ${grant}`);
    }],
    ['https://api.kroger.com/v1/products', (url, init) => {
      assert.equal(init.headers.authorization, 'Bearer app-token');
      const u = new URL(url);
      assert.equal(u.searchParams.get('filter.locationId'), '70100123');
      return jsonRes({ data: [{
        productId: '0001111041700', upc: '0001111041700', brand: 'Kroger', description: 'Kroger® 2% Reduced Fat Milk',
        images: [{ perspective: 'front', sizes: [{ size: 'small', url: 's.jpg' }, { size: 'medium', url: 'm.jpg' }] }],
        items: [{ size: '1 gal', soldBy: 'UNIT', price: { regular: 3.49, promo: 0 }, inventory: { stockLevel: 'HIGH' } }],
        aisleLocations: [{ description: 'Dairy' }],
      }] });
    }],
    ['https://api.kroger.com/v1/locations', (url) => {
      assert.equal(new URL(url).searchParams.get('filter.chain'), null, 'no chain filter: Kroger chain codes differ from brand names');
      return jsonRes({ data: [
        { locationId: '70100999', chain: 'QFC', name: 'QFC - Broadway', address: { addressLine1: '1 Main', city: 'Portland', state: 'OR', zipCode: '97214' } },
        { locationId: '70100555', chain: 'FRED', name: 'Fred Meyer Fuel Center - Hawthorne', address: {} },
        { locationId: '70100123', chain: 'FRED', name: 'Fred Meyer - Hawthorne', address: { addressLine1: '3805 SE Hawthorne', city: 'Portland', state: 'OR', zipCode: '97214' } },
      ] });
    }],
    ['https://api.kroger.com/v1/cart/add', (_url, init) => {
      const body = JSON.parse(init.body);
      assert.ok(body.items.every((i) => i.modality === 'PICKUP'));
      return new Response(null, { status: cartStatus });
    }],
  ]);
}

test('product search uses client-credentials token and normalizes products', async () => {
  const env = makeEnv();
  const fetchImpl = krogerFetch();
  const { results } = await kroger.searchProductsMany(env, ['2% milk!!', 'milk'], '70100123', { fetchImpl });
  const p = results['milk'][0];
  assert.deepEqual(
    { upc: p.upc, size: p.size, price: p.price, promoPrice: p.promoPrice, image: p.image, inStock: p.inStock, aisle: p.aisle },
    { upc: '0001111041700', size: '1 gal', price: 3.49, promoPrice: null, image: 'm.jpg', inStock: true, aisle: 'Dairy' },
  );
  const tokenCalls = fetchImpl.calls.filter((c) => c.url.includes('/token'));
  assert.equal(tokenCalls.length, 1, 'app token fetched once and reused');
  assert.equal(new URL(fetchImpl.calls.at(-1).url).searchParams.get('filter.term').length > 0, true);
});

test('cleanTerm enforces Kroger term rules', () => {
  assert.equal(kroger.cleanTerm('extra-virgin olive oil (cold pressed), 500ml'), 'extra-virgin olive oil cold pressed 500ml');
  assert.equal(kroger.cleanTerm('a b c d e f g h i j').split(' ').length, 8);
});

test('locations lookup validates ZIP', async () => {
  const env = makeEnv();
  await assert.rejects(kroger.findLocations(env, 'abc', { fetchImpl: krogerFetch() }), /5-digit/);
  const locs = await kroger.findLocations(env, '97214', { fetchImpl: krogerFetch() });
  assert.deepEqual(locs.map((l) => l.locationId), ['70100123'], 'only Fred Meyer stores, no fuel centers');
  assert.equal(locs[0].address, '3805 SE Hawthorne, Portland, OR, 97214');
  const fallback = await kroger.findLocations(env, '97214', { brand: /nomatch/, fetchImpl: krogerFetch() });
  assert.deepEqual(fallback.map((l) => l.locationId), ['70100999', '70100123'], 'falls back to all nearby stores');
});

test('full OAuth round trip then cart add, with refresh', async () => {
  const env = makeEnv();
  const fetchImpl = krogerFetch();

  await assert.rejects(kroger.addToCart(env, [{ upc: '0001111041700', quantity: 1 }], 'PICKUP', fetchImpl), (e) => e.code === 'kroger_auth_required');

  const authUrl = new URL(await kroger.startOAuth(env, 'https://relay.example.workers.dev/kroger/oauth/start', 'https://example.github.io/DinnerCart/#cart'));
  assert.equal(authUrl.origin + authUrl.pathname, 'https://api.kroger.com/v1/connect/oauth2/authorize');
  assert.equal(authUrl.searchParams.get('scope'), 'cart.basic:write');
  const state = authUrl.searchParams.get('state');

  const cb = await kroger.finishOAuth(env, `https://relay.example.workers.dev/kroger/oauth/callback?code=abc&state=${state}`, fetchImpl);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), 'https://example.github.io/DinnerCart/?kroger=connected#cart');

  const replay = await kroger.finishOAuth(env, `https://relay.example.workers.dev/kroger/oauth/callback?code=abc&state=${state}`, fetchImpl);
  assert.equal(replay.status, 400, 'state is single-use');

  assert.deepEqual((await kroger.userStatus(env)).connected, true);

  const items = Array.from({ length: 30 }, (_, i) => ({ upc: String(1000000 + i), quantity: i === 0 ? 2.6 : 1 }));
  items.push({ upc: 'not-a-upc', quantity: 1 });
  const result = await kroger.addToCart(env, items, 'PICKUP', fetchImpl);
  assert.deepEqual(result, { added: 30, batches: 2 });
  const firstCart = fetchImpl.calls.find((c) => c.url.endsWith('/cart/add'));
  assert.equal(firstCart.init.headers.authorization, 'Bearer user-token');
  assert.equal(JSON.parse(firstCart.init.body).items[0].quantity, 3);

  // Expire the access token: next add refreshes and stores the rotated refresh token.
  const stored = await env.DC_KV.get('kroger:user', 'json');
  await env.DC_KV.put('kroger:user', JSON.stringify({ ...stored, expires_at: Date.now() - 1 }));
  await kroger.addToCart(env, [{ upc: '0001111041700', quantity: 1 }], 'PICKUP', fetchImpl);
  const after = await env.DC_KV.get('kroger:user', 'json');
  assert.equal(after.refresh_token, 'refresh-2');
  assert.equal(fetchImpl.calls.at(-1).init.headers.authorization, 'Bearer user-token-2');
});

test('failed refresh clears tokens and asks to reconnect', async () => {
  const env = makeEnv();
  await env.DC_KV.put('kroger:user', JSON.stringify({ access_token: 'old', refresh_token: 'dead', expires_at: 0 }));
  await assert.rejects(
    kroger.addToCart(env, [{ upc: '0001111041700', quantity: 1 }], 'PICKUP', krogerFetch({ refreshFails: true })),
    (e) => e.code === 'kroger_auth_required',
  );
  assert.equal(await env.DC_KV.get('kroger:user'), null);
});

test('OAuth start refuses foreign return URLs (falls back to APP_URL)', async () => {
  const env = makeEnv();
  const url = new URL(await kroger.startOAuth(env, 'https://relay.example.workers.dev/x', 'https://evil.example/'));
  const pending = await env.DC_KV.get(`oauth:state:${url.searchParams.get('state')}`, 'json');
  assert.equal(pending.returnTo, 'https://example.github.io/DinnerCart/');
});

test('library and prefs round trip through routes', async () => {
  const env = makeEnv();
  const recipe = { url: 'https://x.example/r', name: 'R', ingredients: ['a'], recipeInstructions: ['nope'] };
  const saved = await (await handle(req('POST', '/library', { body: { recipe } }), env)).json();
  assert.ok(saved.recipe.id);
  assert.equal('recipeInstructions' in saved.recipe, false);
  await handle(req('POST', '/library', { body: { recipe: { ...recipe, name: 'R2' } } }), env);
  let list = (await (await handle(req('GET', '/library'), env)).json()).recipes;
  assert.equal(list.length, 1, 'same URL replaces');
  assert.equal(list[0].name, 'R2');
  const evil = await handle(req('POST', '/library', { body: { recipe: { ...recipe, url: 'javascript:alert(1)' } } }), env);
  assert.equal(evil.status, 400);
  await handle(req('DELETE', `/library?id=${list[0].id}`), env);
  list = (await (await handle(req('GET', '/library'), env)).json()).recipes;
  assert.equal(list.length, 0);

  const put = await handle(req('PUT', '/prefs', { body: { prefs: { pantry: [' salt ', '', 'pepper'], modality: 'DELIVERY' } } }), env);
  assert.deepEqual((await put.json()).prefs.pantry, ['salt', 'pepper']);
  const bad = await handle(req('PUT', '/prefs', { body: { prefs: { modality: 'DRONE' } } }), env);
  assert.equal(bad.status, 400);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { minRating: 4.5 } } }), env)).status, 200);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { minRating: 9 } } }), env)).status, 400);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { maxMinutes: 30, servings: 4 } } }), env)).status, 200);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { maxMinutes: null } } }), env)).status, 200);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { servings: 2.5 } } }), env)).status, 400);
  const lo = await handle(req('PUT', '/prefs', { body: { prefs: { leaveOut: [' mushrooms ', '', 'olives'] } } }), env);
  assert.deepEqual((await lo.json()).prefs.leaveOut, ['mushrooms', 'olives']);
  const got = (await (await handle(req('GET', '/prefs'), env)).json()).prefs;
  assert.equal(got.modality, 'DELIVERY');
});

test('product search retries Kroger 429s and reports persistent errors per term', async () => {
  const env = makeEnv();
  let calls = 0;
  const fetchImpl = mockFetch([
    ['https://api.kroger.com/v1/connect/oauth2/token', () => jsonRes({ access_token: 'app-token', expires_in: 1800 })],
    ['https://api.kroger.com/v1/products', (url) => {
      const term = new URL(url).searchParams.get('filter.term');
      if (term === 'flaky') return ++calls === 1 ? new Response('slow down', { status: 429 }) : jsonRes({ data: [{ productId: '1', upc: '0001', description: 'Flaky', items: [{}] }] });
      return new Response('{"errors":{"reason":"nope"}}', { status: 400 });
    }],
  ]);
  const { results, errors } = await kroger.searchProductsMany(env, ['flaky', 'broken'], '70100123', { fetchImpl });
  assert.equal(results.flaky.length, 1, '429 retried and succeeded');
  assert.deepEqual(results.broken, []);
  assert.match(errors.broken, /returned 400: \{"errors"/);
});
