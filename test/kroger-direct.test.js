import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { findStores, lastDirectProblem, lastSearchRoute, productSearcher, resetDirectSearch } from '../web/js/kroger.js';

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
    seen.push({ url: new URL(url), init });
    return jsonRes({ data: [product('111', `Kroger ${new URL(url).searchParams.get('filter.term')}`)] });
  };
  const out = await productSearcher(relay, '701', { fetchImpl })(['yellow onion', 'milk!!']);
  assert.equal(out['yellow onion'][0].description, 'Kroger yellow onion');
  assert.equal(out['yellow onion'][0].price, 1.5, 'normalized like the relay does');
  assert.equal(seen[0].url.searchParams.get('filter.locationId'), '701');
  assert.equal(seen[1].url.searchParams.get('filter.term'), 'milk', 'term cleaned');
  assert.equal(seen[0].url.searchParams.get('access_token'), 't1', 'key in the web address');
  assert.equal(seen[0].init, undefined, 'no headers, so no CORS preflight');
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

test('Kroger unreachable from the browser: falls back to the relay and explains why', async () => {
  const relay = fakeRelay();
  let directCalls = 0;
  const fetchImpl = async () => { directCalls++; throw new TypeError('Failed to fetch'); };
  const search = productSearcher(relay, '701', { fetchImpl });
  const out = await search(['milk']);
  assert.equal(out.milk[0].description, 'relay milk');
  assert.match(lastDirectProblem(), /couldn't reach Kroger \(Failed to fetch\)/);
  await search(['eggs']);
  assert.equal(directCalls, 1, 'no more direct attempts after the device couldn\'t reach Kroger');
  assert.equal(lastSearchRoute(), 'relay');
});

test('Kroger rejects even a fresh key: stop trying direct', async () => {
  const relay = fakeRelay();
  let directCalls = 0;
  const fetchImpl = async () => { directCalls++; return new Response('{}', { status: 401 }); };
  const search = productSearcher(relay, '701', { fetchImpl });
  const out = await search(['milk']);
  assert.equal(out.milk[0].description, 'relay milk');
  assert.match(lastDirectProblem(), /won't accept the search key/);
  assert.equal(lastSearchRoute(), 'relay');
  await search(['eggs']);
  assert.equal(directCalls, 2, 'one retry with a fresh key, then relay only');
});

test('expired token: one refresh and retry', async () => {
  const relay = fakeRelay();
  const auths = [];
  const fetchImpl = async (url) => {
    auths.push(new URL(url).searchParams.get('access_token'));
    return auths.length === 1 ? new Response('', { status: 401 }) : jsonRes({ data: [product('1', 'Milk')] });
  };
  const out = await productSearcher(relay, '701', { fetchImpl })(['milk']);
  assert.equal(out.milk.length, 1);
  assert.deepEqual(auths, ['t1', 't2']);
});

test('relay without the token route: everything goes through the relay', async () => {
  const relay = { ...fakeRelay(), krogerToken: async () => { throw new Error('404'); } };
  const out = await productSearcher(relay, '701', { fetchImpl: async () => { throw new Error('should not call'); } })(['milk']);
  assert.equal(out.milk[0].description, 'relay milk');
});

const location = (locationId, name, chain = 'FRED') => ({ locationId, name, chain, address: { addressLine1: '1 Main St', city: 'Portland', state: 'OR', zipCode: '97214' } });

test('finds stores directly from the phone, keeping the Fred Meyer ones', async () => {
  const relay = { ...fakeRelay(), locations: async () => { throw new Error('relay should not be used'); } };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: new URL(url), init });
    return jsonRes({ data: [location('1', 'Fred Meyer Hawthorne'), location('2', 'QFC Broadway', 'QFC'), location('3', 'Fred Meyer Fuel Center')] });
  };
  const stores = await findStores(relay, '97214', { fetchImpl });
  assert.deepEqual(stores.map((s) => s.locationId), ['1']);
  assert.equal(stores[0].address, '1 Main St, Portland, OR, 97214');
  assert.equal(seen[0].url.pathname, '/v1/locations');
  assert.equal(seen[0].url.searchParams.get('filter.zipCode.near'), '97214');
  assert.equal(seen[0].url.searchParams.get('access_token'), 't1');
  assert.equal(seen[0].init, undefined, 'no headers, so no CORS preflight');
});

test('store lookup falls back to the relay, and reports both failures', async () => {
  const firewall = async () => new Response('<html>Access Denied</html>', { status: 403, headers: { 'content-type': 'text/html' } });
  const relay = { ...fakeRelay(), locations: async () => ({ locations: [{ locationId: '9', name: 'Fred Meyer via relay' }] }) };
  assert.equal((await findStores(relay, '97214', { fetchImpl: firewall }))[0].locationId, '9');
  const down = { ...fakeRelay(), locations: async () => { throw new Error('Kroger /locations was blocked by Kroger\'s firewall (403 Access Denied)'); } };
  await assert.rejects(findStores(down, '97214', { fetchImpl: firewall }), /From this device: Kroger returned 403\. Through the relay: .*firewall/);
  await assert.rejects(findStores(relay, '972', { fetchImpl: firewall }), /5-digit/);
});
