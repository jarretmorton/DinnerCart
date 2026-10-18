// Quantity and package-size math for the ingredient resolver.
// Runs in the browser and in Node (eval script, tests).

// Canonical units Gemini is asked to use, with dimension and base factor
// (grams, millilitres, or each).
export const UNITS = {
  g: ['mass', 1],
  kg: ['mass', 1000],
  oz: ['mass', 28.3495],
  lb: ['mass', 453.592],
  ml: ['volume', 1],
  l: ['volume', 1000],
  tsp: ['volume', 4.92892],
  tbsp: ['volume', 14.7868],
  cup: ['volume', 236.588],
  floz: ['volume', 29.5735],
  pint: ['volume', 473.176],
  quart: ['volume', 946.353],
  gallon: ['volume', 3785.41],
  count: ['count', 1],
};

// One of these = one store package, whatever its size.
export const PACKAGE_UNITS = new Set(['can', 'jar', 'bottle', 'package', 'bag', 'box', 'carton', 'container', 'tub', 'loaf']);

// Units that need judgment (Gemini decides packages for these).
export const FUZZY_UNITS = new Set(['clove', 'bunch', 'head', 'sprig', 'pinch', 'dash', 'slice', 'stick', 'stalk', 'piece', 'fillet', 'breast', 'thigh', 'handful']);

export const ALL_UNITS = [...Object.keys(UNITS), ...PACKAGE_UNITS, ...FUZZY_UNITS];

const SIZE_ALIASES = [
  [/^(fl\.?\s*oz|fluid\s*ounces?)$/, 'floz'],
  [/^(oz|ounces?)$/, 'oz'],
  [/^(lbs?|pounds?)$/, 'lb'],
  [/^(g|grams?|gm)$/, 'g'],
  [/^(kg|kilograms?)$/, 'kg'],
  [/^(ml|milliliters?|millilitres?)$/, 'ml'],
  [/^(l|lt|liters?|litres?)$/, 'l'],
  [/^(gal|gallons?)$/, 'gallon'],
  [/^(qt|quarts?)$/, 'quart'],
  [/^(pt|pints?)$/, 'pint'],
  [/^(ct|count|each|ea|pk|pack|pc|pcs)$/, 'count'],
];

const RECIPE_ALIASES = {
  gram: 'g', grams: 'g', kilogram: 'kg', kilograms: 'kg', ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', lbs: 'lb',
  milliliter: 'ml', milliliters: 'ml', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp', t: 'tsp', tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
  cups: 'cup', c: 'cup', 'fl oz': 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz', pints: 'pint', quarts: 'quart', qt: 'quart', gallons: 'gallon', gal: 'gallon',
  each: 'count', whole: 'count', item: 'count', items: 'count', ct: 'count',
};

// Map whatever unit word Gemini returns onto ALL_UNITS (or null).
export function normalizeUnit(unit) {
  if (unit == null) return null;
  const u = String(unit).toLowerCase().trim().replace(/\.$/, '');
  if (ALL_UNITS.includes(u)) return u;
  if (RECIPE_ALIASES[u]) return RECIPE_ALIASES[u];
  const singular = u.replace(/(es|s)$/, '');
  if (ALL_UNITS.includes(singular)) return singular;
  if (ALL_UNITS.includes(u.replace(/s$/, ''))) return u.replace(/s$/, '');
  return null;
}

function aliasUnit(u) {
  const s = u.toLowerCase().replace(/\.$/, '').trim();
  for (const [re, unit] of SIZE_ALIASES) if (re.test(s)) return unit;
  return null;
}

function parseNumber(s) {
  s = s.trim();
  const frac = s.match(/^(\d+)?\s*(\d+)\/(\d+)$/);
  if (frac) return (Number(frac[1] || 0)) + Number(frac[2]) / Number(frac[3]);
  return Number(s);
}

const SIZE_RE = /(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+)\s*(fl\.?\s*oz|fluid\s*ounces?|oz|ounces?|lbs?|pounds?|kg|g|gm|grams?|ml|l|lt|liters?|litres?|gal|gallons?|qt|quarts?|pt|pints?|ct|count|each|ea|pk|pack|pcs?)\b/gi;

// Parse a Kroger size string into base units.
//   "16 oz" -> {dimension:'mass', amount:453.6}
//   "1/2 gal" -> volume, "12 ct" -> count, "6 ct / 12 fl oz" -> 72 fl oz total.
export function parseSize(size) {
  if (!size) return null;
  const parts = [...String(size).matchAll(SIZE_RE)]
    .map((m) => ({ n: parseNumber(m[1]), unit: aliasUnit(m[2]) }))
    .filter((p) => p.unit && p.n > 0);
  if (!parts.length) return null;
  const [first, second] = parts;
  // Multipack: "6 ct / 12 fl oz" or "12 ct / 1 oz".
  if (first.unit === 'count' && second && second.unit !== 'count') {
    const [dimension, factor] = UNITS[second.unit];
    return { dimension, amount: first.n * second.n * factor, count: first.n };
  }
  const [dimension, factor] = UNITS[first.unit];
  return { dimension, amount: first.n * factor };
}

export function toBase(qty, unit) {
  const u = UNITS[unit];
  if (!u || qty == null || !Number.isFinite(qty)) return null;
  return { dimension: u[0], amount: qty * u[1] };
}

// How many packages of `size` cover the needs, or null when it can't be
// computed confidently (mixed dimensions, fuzzy units) and Gemini should decide.
export function packagesNeeded(needs, size) {
  const withQty = needs.filter((n) => n.qty != null && n.qty > 0);
  if (!withQty.length) return 1; // "salt to taste" etc.
  if (withQty.every((n) => PACKAGE_UNITS.has(n.unit))) {
    return clamp(Math.ceil(sum(withQty.map((n) => n.qty)) - 0.01));
  }
  const parsed = parseSize(size);
  if (!parsed) return null;
  let total = 0;
  for (const n of withQty) {
    const b = toBase(n.qty, n.unit);
    if (!b || b.dimension !== parsed.dimension) return null;
    total += b.amount;
  }
  // 5% slack: a recipe asking for 16.5 oz is happy with a 16 oz package.
  return clamp(Math.ceil(total / (parsed.amount * 1.05)));
}

const clamp = (n) => Math.max(1, Math.min(24, n));
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

const LABELS = { floz: 'fl oz', l: 'L', gallon: 'gal', count: '' };
const PLURALIZE = new Set(['cup', 'pint', 'quart', ...PACKAGE_UNITS, ...FUZZY_UNITS]);

export function formatQty(qty, unit) {
  if (qty == null) return '';
  const rounded = Math.round(qty * 100) / 100;
  let label = LABELS[unit] ?? unit ?? '';
  if (rounded > 1 && PLURALIZE.has(unit)) label = /(ch|sh|x|s)$/.test(label) ? `${label}es` : `${label}s`;
  return label ? `${rounded} ${label}` : String(rounded);
}

// Combine needs with the same unit for display: [2 cup, 1 cup, 3 tbsp] -> "3 cups + 3 tbsp".
export function summarizeNeeds(needs) {
  const byUnit = new Map();
  for (const n of needs) {
    if (n.qty == null || n.qty <= 0) continue;
    byUnit.set(n.unit, (byUnit.get(n.unit) || 0) + n.qty);
  }
  const parts = [...byUnit].map(([unit, qty]) => formatQty(qty, unit));
  return parts.length ? parts.join(' + ') : 'some';
}
