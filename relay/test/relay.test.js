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

test('firewall blocks: one retry, then a readable error; browser token route', async () => {
  const env = makeEnv();
  const akamai = () => new Response('<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>You don\'t have permission to access "http&#58;&#47;&#47;api&#46;kroger" on this server.</BODY></HTML>', { status: 403, headers: { 'content-type': 'text/html' } });
  let calls = 0;
  const fetchImpl = mockFetch([
    ['https://api.kroger.com/v1/connect/oauth2/token', (_u, init) => {
      assert.match(init.headers['user-agent'], /^DinnerCart/);
      return jsonRes({ access_token: 'app-token', expires_in: 1800 });
    }],
    ['https://api.kroger.com/v1/products', (url, init) => {
      assert.match(init.headers['user-agent'], /^DinnerCart/);
      const term = new URL(url).searchParams.get('filter.term');
      if (term === 'once') return ++calls === 1 ? akamai() : jsonRes({ data: [{ productId: '1', upc: '0001', description: 'Ok', items: [{}] }] });
      return akamai();
    }],
  ]);
  const { results, errors } = await kroger.searchProductsMany(env, ['once', 'always', 'third', 'fourth'], '1', { fetchImpl });
  assert.equal(results.once.length, 1, 'one firewall block is retried');
  assert.equal(errors.always, "Kroger /products was blocked by Kroger's firewall (403 Access Denied)");
  const productCalls = () => fetchImpl.calls.filter((c) => c.url.includes('/products')).length;
  const before = productCalls();
  assert.equal(errors.fourth, errors.always, 'after a block the remaining terms are not attempted');
  // Cached: searching "once" again doesn't hit Kroger.
  await kroger.searchProductsMany(env, ['once'], '1', { fetchImpl });
  assert.equal(productCalls(), before, 'product results come from the cache');
  assert.equal(kroger.describeKrogerError('/products', 500, '<html><title>Oops</title></html>'), 'Kroger /products returned 500: Oops');
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
  // Cook steps are kept (cleaned); the original instructions never are.
  const cook = { v: 1, prep: ['Preheat the oven to 400°F.', 7], steps: [{ text: 'Roast {{1 lb}} potatoes.', timerMinutes: '25', timerLabel: 'Roast' }, { text: '' }, { text: 'Serve.', timerMinutes: -3, timerLabel: 'x' }], warnings: [], model: 'm', generatedAt: '2026-10-19T00:00:00Z' };
  const withCook = (await (await handle(req('POST', '/library', { body: { recipe: { ...recipe, name: 'R2', instructions: ['orig'], cook } } }), env)).json()).recipe;
  assert.equal('instructions' in withCook, false);
  assert.deepEqual(withCook.cook.prep, ['Preheat the oven to 400°F.']);
  assert.deepEqual(withCook.cook.steps, [{ text: 'Roast {{1 lb}} potatoes.', timerMinutes: 25, timerLabel: 'Roast' }, { text: 'Serve.', timerMinutes: null, timerLabel: null }]);
  const kept = (await (await handle(req('POST', '/library', { body: { recipe: { ...recipe, name: 'R2' } } }), env)).json()).recipe;
  assert.equal(kept.cook.steps.length, 2, 're-saving without cook keeps the saved steps');
  const noSteps = (await (await handle(req('POST', '/library', { body: { recipe: { ...recipe, name: 'R2', cook: { steps: [] } } } }), env)).json()).recipe;
  assert.equal(noSteps.cook.steps.length, 2, 'empty cook is ignored');
  const evil = await handle(req('POST', '/library', { body: { recipe: { ...recipe, url: 'javascript:alert(1)' } } }), env);
  assert.equal(evil.status, 400);
  await handle(req('DELETE', `/library?id=${list[0].id}`), env);
  list = (await (await handle(req('GET', '/library'), env)).json()).recipes;
  assert.equal(list.length, 0);

  // Sending to the cart saves picked recipes automatically and records the pick.
  const legacy = { url: 'https://x.example/legacy', name: 'Old', ingredients: ['a'] };
  await env.DC_KV.put('library', JSON.stringify([{ ...legacy, id: 'old1', savedAt: '2026-01-01T00:00:00Z' }]));
  const tacos = { url: 'https://x.example/tacos', name: 'Tacos', ingredients: ['tortillas'] };
  let res = await (await handle(req('POST', '/library/picked', { body: { recipes: [tacos, legacy] } }), env)).json();
  const byName = (rs) => Object.fromEntries(rs.map((r) => [r.name, r]));
  let lib = byName(res.recipes);
  assert.ok(lib.Tacos.savedAt, 'picked recipes are saved');
  assert.equal(lib.Tacos.pickedCount, 1);
  assert.ok(lib.Tacos.lastPickedAt);
  assert.equal(lib.Old.pickedCount, 1);
  assert.equal(lib.Old.savedAt, '2026-01-01T00:00:00Z', 'pick keeps the original save date');
  res = await (await handle(req('POST', '/library/picked', { body: { recipes: [tacos] } }), env)).json();
  assert.equal(byName(res.recipes).Tacos.pickedCount, 2);
  const resaved = (await (await handle(req('POST', '/library', { body: { recipe: tacos } }), env)).json()).recipe;
  assert.equal(resaved.pickedCount, 2, 'saving keeps pick history');
  assert.equal(res.recipes.length, 2, 'one list, no duplicates');
  assert.equal((await handle(req('POST', '/library/picked', { body: { recipes: [] } }), env)).status, 400);

  const put = await handle(req('PUT', '/prefs', { body: { prefs: { pantry: [' salt ', '', 'pepper'], modality: 'DELIVERY' } } }), env);
  assert.deepEqual((await put.json()).prefs.pantry, ['salt', 'pepper']);
  const bad = await handle(req('PUT', '/prefs', { body: { prefs: { modality: 'DRONE' } } }), env);
  assert.equal(bad.status, 400);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { minRating: 4.5 } } }), env)).status, 200);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { easy: true, maxMinutes: 15 } } }), env)).status, 200);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { easy: 'yes' } } }), env)).status, 400);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { easyMaxIngredients: 12, easyMaxSteps: 6 } } }), env)).status, 200);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { easyMaxSteps: 0 } } }), env)).status, 400);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { minRating: 9 } } }), env)).status, 400);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { maxMinutes: 30, servings: 4 } } }), env)).status, 200);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { maxMinutes: null } } }), env)).status, 200);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { servings: 2.5 } } }), env)).status, 400);
  const daily = { date: '2026-10-18', ideas: ['miso salmon bowls', 'lazy lasagna soup'] };
  assert.deepEqual((await (await handle(req('PUT', '/prefs', { body: { prefs: { dailyIdeas: daily } } }), env)).json()).prefs.dailyIdeas, daily);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { dailyIdeas: { date: 'today', ideas: [] } } } }), env)).status, 400);
  const lo = await handle(req('PUT', '/prefs', { body: { prefs: { leaveOut: [' mushrooms ', '', 'olives'] } } }), env);
  assert.deepEqual((await lo.json()).prefs.leaveOut, ['mushrooms', 'olives']);
  const sp = await handle(req('PUT', '/prefs', { body: { prefs: { shoppingPrefs: [' organic produce ', '', 'Tillamook cheese'] } } }), env);
  assert.deepEqual((await sp.json()).prefs.shoppingPrefs, ['organic produce', 'Tillamook cheese']);
  assert.equal((await handle(req('PUT', '/prefs', { body: { prefs: { shoppingPrefs: 'organic' } } }), env)).status, 400);
  const got = (await (await handle(req('GET', '/prefs'), env)).json()).prefs;
  assert.equal(got.modality, 'DELIVERY');
});

test('usuals: set, replace, forget, validate', async () => {
  const env = makeEnv();
  const get = async () => (await (await handle(req('GET', '/usuals'), env)).json()).usuals;
  assert.deepEqual(await get(), {});
  const put = (key, product) => handle(req('PUT', '/usuals', { body: { key, product } }), env);
  const cheese = { upc: '0004114320050', description: 'Tillamook Medium Cheddar Shredded Cheese', brand: 'Tillamook', size: '8 oz', image: 'https://img.example/t.jpg', price: 4.5, extra: 'x' };
  let res = await (await put('shredded cheddar', cheese)).json();
  assert.deepEqual(Object.keys(res.usuals['shredded cheddar']).sort(), ['at', 'brand', 'description', 'image', 'size', 'upc'], 'only the fields it needs');
  await put('milk', { upc: '0001111041700', description: 'Kroger 2% Milk', image: 'javascript:alert(1)' });
  assert.equal((await get()).milk.image, null);
  await put('milk', { upc: '0001111041600', description: 'Kroger Whole Milk' });
  assert.equal((await get()).milk.description, 'Kroger Whole Milk', 'replaced');
  res = await (await put('milk', null)).json();
  assert.deepEqual(Object.keys(res.usuals), ['shredded cheddar']);
  assert.equal((await put('', cheese)).status, 400);
  assert.equal((await put('eggs', { upc: 'abc', description: 'Eggs' })).status, 400);
  assert.equal((await put('eggs', { upc: '0001111060903' })).status, 400);
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

test('family rating on a saved recipe: set, change, clear, kept on re-save, validated', async () => {
  const env = makeEnv();
  const recipe = { url: 'https://x.example/chili', name: 'Chili', ingredients: ['beans'] };
  const { id } = (await (await handle(req('POST', '/library', { body: { recipe } }), env)).json()).recipe;
  const rate = (rating, rid = id) => handle(req('POST', '/library/rating', { body: { id: rid, rating } }), env);
  let r = (await (await rate('happy')).json()).recipe;
  assert.equal(r.familyRating, 'happy');
  assert.ok(r.ratedAt);
  r = (await (await rate('sad')).json()).recipe;
  assert.equal(r.familyRating, 'sad');
  await handle(req('POST', '/library', { body: { recipe: { ...recipe, name: 'Chili!' } } }), env);
  let list = (await (await handle(req('GET', '/library'), env)).json()).recipes;
  assert.equal(list[0].familyRating, 'sad', 're-saving keeps the rating');
  r = (await (await rate(null)).json()).recipe;
  assert.equal('familyRating' in r, false, 'cleared');
  assert.equal((await rate('great')).status, 400);
  assert.equal((await rate('happy', 'nope')).status, 404);
});
