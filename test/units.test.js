import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQty, normalizeUnit, packagesNeeded, parseSize, summarizeNeeds } from '../web/js/units.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 0.5, `${a} ≈ ${b}`);

test('parseSize handles Kroger size strings', () => {
  close(parseSize('16 oz').amount, 453.6);
  assert.equal(parseSize('16 oz').dimension, 'mass');
  close(parseSize('1/2 gal').amount, 1892.7);
  close(parseSize('32 fl oz').amount, 946.4);
  assert.equal(parseSize('32 fl oz').dimension, 'volume');
  assert.deepEqual(parseSize('12 ct'), { dimension: 'count', amount: 12 });
  close(parseSize('6 ct / 12 fl oz').amount, 6 * 12 * 29.57);
  close(parseSize('1.5 lb').amount, 680.4);
  close(parseSize('2 1/2 lb').amount, 1134);
  assert.equal(parseSize('1 each').amount, 1);
  assert.equal(parseSize('family size'), null);
  assert.equal(parseSize(null), null);
});

test('normalizeUnit maps loose unit words', () => {
  assert.equal(normalizeUnit('Tablespoons'), 'tbsp');
  assert.equal(normalizeUnit('cups'), 'cup');
  assert.equal(normalizeUnit('cloves'), 'clove');
  assert.equal(normalizeUnit('packages'), 'package');
  assert.equal(normalizeUnit('boxes'), 'box');
  assert.equal(normalizeUnit('pinches'), 'pinch');
  assert.equal(normalizeUnit('lbs.'), 'lb');
  assert.equal(normalizeUnit('whole'), 'count');
  assert.equal(normalizeUnit('smidgen'), null);
  assert.equal(normalizeUnit(null), null);
});

test('packagesNeeded', () => {
  // Same dimension: ceil with 5% slack.
  assert.equal(packagesNeeded([{ qty: 2, unit: 'lb' }], '16 oz'), 2);
  assert.equal(packagesNeeded([{ qty: 16.5, unit: 'oz' }], '16 oz'), 1);
  assert.equal(packagesNeeded([{ qty: 3, unit: 'cup' }, { qty: 2, unit: 'cup' }], '32 fl oz'), 2);
  assert.equal(packagesNeeded([{ qty: 1, unit: 'tbsp' }], '16 fl oz'), 1);
  assert.equal(packagesNeeded([{ qty: 6, unit: 'count' }], '12 ct'), 1);
  assert.equal(packagesNeeded([{ qty: 3, unit: 'count' }], '1 each'), 3);
  // Package units are one package each.
  assert.equal(packagesNeeded([{ qty: 1, unit: 'can' }, { qty: 2, unit: 'can' }], '15 oz'), 3);
  // Mixed or fuzzy dimensions: let Gemini decide.
  assert.equal(packagesNeeded([{ qty: 2, unit: 'cup' }], '5 lb'), null);
  assert.equal(packagesNeeded([{ qty: 3, unit: 'clove' }], '3 ct'), null);
  assert.equal(packagesNeeded([{ qty: 2, unit: 'count' }], '3 lb'), null);
  // No amounts at all ("salt to taste").
  assert.equal(packagesNeeded([{ qty: null, unit: null }], '26 oz'), 1);
  // Clamp.
  assert.equal(packagesNeeded([{ qty: 100, unit: 'lb' }], '1 lb'), 24);
});

test('formatting', () => {
  assert.equal(formatQty(2, 'cup'), '2 cups');
  assert.equal(formatQty(1, 'cup'), '1 cup');
  assert.equal(formatQty(0.333333, 'tsp'), '0.33 tsp');
  assert.equal(formatQty(3, 'count'), '3');
  assert.equal(formatQty(2, 'pinch'), '2 pinches');
  assert.equal(summarizeNeeds([{ qty: 2, unit: 'cup' }, { qty: 1, unit: 'cup' }, { qty: 3, unit: 'tbsp' }]), '3 cups + 3 tbsp');
  assert.equal(summarizeNeeds([{ qty: null, unit: null }]), 'some');
});
