import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { productMatches, scoreCase, summarize } from '../eval/score.mjs';

const p = (description, extra = {}) => ({ upc: '1', description, brand: 'Kroger', ...extra });

test('keyword matching uses word prefixes', () => {
  const expect = { all: ['onion'], none: ['powder', 'red'] };
  assert.equal(productMatches(p('Yellow Onions'), expect).ok, true);
  assert.equal(productMatches(p('Onion Powder'), expect).ok, false);
  assert.equal(productMatches(p('Red Onion'), expect).ok, false);
  assert.equal(productMatches(p('Shallots'), expect).why, 'missing: onion');
  // "unsalted" must not be tripped by a "salted" ban, and ® is ignored.
  assert.equal(productMatches(p('Kroger® Unsalted Butter Sticks'), { all: ['unsalted', 'butter'], none: ['salted'] }).ok, true);
  assert.equal(productMatches(p('Jalapeño Peppers'), { all: ['jalape'] }).ok, true);
  assert.equal(productMatches(null, { all: ['x'] }).ok, false);
});

test('UPC lists override keywords', () => {
  assert.equal(productMatches(p('Anything', { upc: '42' }), { upcs: ['42'], all: ['nope'] }).ok, true);
  assert.equal(productMatches(p('Onion', { upc: '43' }), { upcs: ['42'], all: ['onion'] }).ok, false);
});

test('scoreCase separates search misses from pick misses', () => {
  const testCase = { id: 1, line: '1 onion', expect: { all: ['onion'], none: ['powder'], packages: 1 } };
  const item = { candidates: [p('Onion Powder'), p('Yellow Onion')], choice: 0, packages: 1 };
  const row = scoreCase(testCase, item);
  assert.equal(row.ok, false);
  assert.equal(row.searchHit, true);
  const s = summarize([row, scoreCase(testCase, { ...item, choice: 1 })]);
  assert.equal(s.productAccuracy, 0.5);
  assert.equal(s.searchRecall, 1);
  assert.equal(s.packagesAccuracy, 1);
});

test('eval cases file is well-formed', async () => {
  const cases = JSON.parse(await readFile(new URL('../eval/cases.json', import.meta.url), 'utf8'));
  assert.equal(cases.length, 50);
  assert.equal(new Set(cases.map((c) => c.id)).size, 50);
  for (const c of cases) {
    assert.ok(c.line && (c.expect.all?.length || c.expect.upcs?.length), `case ${c.id}`);
    // A banned word must not also be a required one.
    for (const w of c.expect.none || []) assert.ok(!(c.expect.all || []).some((a) => a.startsWith(w)), `case ${c.id}: "${w}" bans a required word`);
  }
});
