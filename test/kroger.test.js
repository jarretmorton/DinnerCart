import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findStores, productSearcher } from '../web/js/kroger.js';

test('product search goes through the relay in chunks, with per-term errors', async () => {
  const calls = [];
  const relay = {
    products: async (terms, locationId) => {
      calls.push({ terms, locationId });
      return {
        results: Object.fromEntries(terms.map((t) => [t, t === 'eggs' ? [] : [{ upc: `u-${t}` }]])),
        errors: terms.includes('eggs') ? { eggs: 'Kroger /products returned 500' } : {},
      };
    },
  };
  const terms = Array.from({ length: 16 }, (_, i) => `item ${i}`).concat('eggs');
  const out = await productSearcher(relay, '701')(terms);
  assert.deepEqual(calls.map((c) => c.terms.length), [15, 2], 'at most 15 terms per relay request');
  assert.equal(calls[0].locationId, '701');
  assert.equal(out['item 3'][0].upc, 'u-item 3');
  assert.deepEqual(out.eggs, { error: 'Kroger /products returned 500' });
});

test('store lookup goes through the relay and checks the ZIP first', async () => {
  const relay = { locations: async (zip) => ({ locations: [{ locationId: '9', name: `Fred Meyer near ${zip}` }] }) };
  assert.equal((await findStores(relay, '97214'))[0].name, 'Fred Meyer near 97214');
  await assert.rejects(findStores(relay, '972'), /5-digit/);
});
