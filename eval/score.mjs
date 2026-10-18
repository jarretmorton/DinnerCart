// Scoring rules for the resolver eval. Kept separate from run.mjs so the
// rules themselves are unit tested.
import { tokens } from '../web/js/util.js';

// A word matches a description token when the token starts with it, so
// "onion" matches "onions" and "jalape" matches "jalapeno".
const hasWord = (toks, word) => toks.some((t) => t.startsWith(word.toLowerCase()));

export function productMatches(product, expect) {
  if (!product) return { ok: false, why: 'no product chosen' };
  if (expect.upcs?.length) {
    return expect.upcs.includes(product.upc)
      ? { ok: true, why: 'UPC match' }
      : { ok: false, why: `UPC ${product.upc} not in accepted list` };
  }
  const toks = tokens(`${product.brand || ''} ${product.description}`);
  const missing = (expect.all || []).filter((w) => !hasWord(toks, w));
  if (missing.length) return { ok: false, why: `missing: ${missing.join(', ')}` };
  const banned = (expect.none || []).filter((w) => hasWord(toks, w));
  if (banned.length) return { ok: false, why: `has: ${banned.join(', ')}` };
  return { ok: true, why: 'keywords match' };
}

export function packagesMatch(actual, expected) {
  if (expected == null) return null;
  if (Array.isArray(expected)) return actual >= expected[0] && actual <= expected[1];
  return actual === expected;
}

export function scoreCase(testCase, item) {
  const product = item?.candidates?.[item.choice] || null;
  const match = productMatches(product, testCase.expect);
  return {
    id: testCase.id,
    line: testCase.line,
    product: product ? `${product.description}${product.size ? ` (${product.size})` : ''}` : null,
    upc: product?.upc || null,
    ok: match.ok,
    why: match.why,
    // Did search return any acceptable product? Separates search misses from pick misses.
    searchHit: (item?.candidates || []).some((c) => productMatches(c, testCase.expect).ok),
    packages: item?.packages ?? null,
    packagesSource: item?.packagesSource ?? null,
    packagesOk: product ? packagesMatch(item.packages, testCase.expect.packages) : null,
    name: item?.name ?? null,
    searchTerm: item?.searchTerm ?? null,
  };
}

export function summarize(rows) {
  const n = rows.length;
  const pct = (k) => (n ? rows.filter((r) => r[k]).length / n : 0);
  const pk = rows.filter((r) => r.packagesOk !== null);
  return {
    cases: n,
    productAccuracy: pct('ok'),
    searchRecall: pct('searchHit'),
    packagesAccuracy: pk.length ? pk.filter((r) => r.packagesOk).length / pk.length : null,
  };
}
