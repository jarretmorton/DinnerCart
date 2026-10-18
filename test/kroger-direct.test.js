import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { directAuthMode, lastDirectProblem, lastSearchRoute, productSearcher, resetDirectSearch } from '../web/js/kroger.js';

const product = (upc, description) => ({ productId: upc, upc, description, items: [{ size: '1 each', price: { regular: 1.5 } }] });
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fakeRelay() {
  const calls = { token: 0, products: [] };
  return {
    calls,
    krogerToken: async () => { calls.token++; return { access_token: `t${calls.token}`, expires_at: Date.now() + 1_800_000 }; },
    products: async (terms) => {
      calls.products.push(terms);
      return { results: Object.fromEntries(terms.map((t) => [t, [{ upc: `relay-${t}`, description: `relay ${t}` }]])), errors: {} };
    },
  };
}

beforeEach(() => resetDirectSearch());

test('searches Kroger directly with the relay token, normalizing products', async () => {
  const relay = fakeRelay();
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: new URL(url), auth: init.headers.authorization });
    return jsonRes({ data: [product('111', `Kroger ${new URL(url).searchParams.get('filter.term')}`)] });
  };
  const out = await productSearcher(relay, '701', { fetchImpl })(['yellow onion', 'milk!!']);
  assert.equal(out['yellow onion'][0].description, 'Kroger yellow onion');
  assert.equal(out['yellow onion'][0].price, 1.5, 'normalized like the relay does');
  assert.equal(seen[0].url.searchParams.get('filter.locationId'), '701');
  assert.equal(seen[1].url.searchParams.get('filter.term'), 'milk', 'term cleaned');
  assert.equal(seen[0].auth, 'Bearer t1');
  assert.equal(relay.calls.token, 1, 'token fetched once');
  assert.deepEqual(relay.calls.products, [], 'relay not used');
  assert.equal(lastSearchRoute(), 'direct');
});

test('a term that fails directly is retried through the relay', async () => {
  const relay = fakeRelay();
  const fetchImpl = async (url) => (new URL(url).searchParams.get('filter.term') === 'eggs'
    ? new Response('<html>Access Denied</html>', { status: 403, headers: { 'content-type': 'text/html' } })
    : jsonRes({ data: [product('1', 'Milk')] }));
  const out = await productSearcher(relay, '701', { fetchImpl })(['milk', 'eggs']);
  assert.equal(out.milk[0].description, 'Milk');
  assert.equal(out.eggs[0].description, 'relay eggs');
  assert.deepEqual(relay.calls.products, [['eggs']]);
  assert.equal(lastSearchRoute(), 'mixed');
});

test('header refused by CORS: retries with the key in the web address', async () => {
  const relay = fakeRelay();
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: new URL(url), auth: init.headers?.authorization });
    if (init.headers?.authorization) throw new TypeError('Failed to fetch');
    return jsonRes({ data: [product('1', 'Milk')] });
  };
  const search = productSearcher(relay, '701', { fetchImpl });
  const out = await search(['milk']);
  assert.equal(out.milk[0].description, 'Milk');
  assert.equal(calls[1].url.searchParams.get('access_token'), 't1');
  assert.equal(directAuthMode(), 'query');
  assert.equal(lastSearchRoute(), 'direct');
  await search(['eggs']);
  assert.equal(calls.length, 3, 'stays in web-address mode, no more header attempts');
  assert.deepEqual(relay.calls.products, []);
});

test('Kroger unreachable from the browser: falls back to the relay and explains why', async () => {
  const relay = fakeRelay();
  let directCalls = 0;
  const fetchImpl = async () => { directCalls++; throw new TypeError('Failed to fetch'); };
  const search = productSearcher(relay, '701', { fetchImpl });
  const out = await search(['milk']);
  assert.equal(out.milk[0].description, 'relay milk');
  assert.match(lastDirectProblem(), /couldn't reach Kroger \(Failed to fetch\)/);
  await search(['eggs']);
  assert.equal(directCalls, 2, 'header try + web-address try, then no more direct attempts');
  assert.equal(lastSearchRoute(), 'relay');
});

test('Kroger rejects the key in the web address: stop trying direct', async () => {
  const relay = fakeRelay();
  const fetchImpl = async (_url, init = {}) => {
    if (init.headers?.authorization) throw new TypeError('Failed to fetch');
    return new Response('{}', { status: 401 });
  };
  const search = productSearcher(relay, '701', { fetchImpl });
  const out = await search(['milk']);
  assert.equal(out.milk[0].description, 'relay milk');
  assert.match(lastDirectProblem(), /won't accept the key in the web address/);
  assert.equal(lastSearchRoute(), 'relay');
});

test('expired token: one refresh and retry', async () => {
  const relay = fakeRelay();
  const auths = [];
  const fetchImpl = async (_url, init) => {
    auths.push(init.headers.authorization);
    return auths.length === 1 ? new Response('', { status: 401 }) : jsonRes({ data: [product('1', 'Milk')] });
  };
  const out = await productSearcher(relay, '701', { fetchImpl })(['milk']);
  assert.equal(out.milk.length, 1);
  assert.deepEqual(auths, ['Bearer t1', 'Bearer t2']);
});

test('relay without the token route: everything goes through the relay', async () => {
  const relay = { ...fakeRelay(), krogerToken: async () => { throw new Error('404'); } };
  const out = await productSearcher(relay, '701', { fetchImpl: async () => { throw new Error('should not call'); } })(['milk']);
  assert.equal(out.milk[0].description, 'relay milk');
});
