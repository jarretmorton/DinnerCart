// Ingredient resolver: recipe lines -> Fred Meyer products + package counts.
//
//   1. Gemini normalizes each line into {name, searchTerm, quantity, unit}.
//   2. Pantry staples, optional and non-buyable lines are set aside.
//   3. Same-name items are merged across recipes.
//   4. Each item is searched at the saved store (via the relay), plus a
//      search for the household's preferred version (e.g. "organic baby
//      spinach") and for the household's usual product, when there is one.
//   5. Gemini picks the best candidate, following the household's shopping
//      preferences; package count is computed from the product size when
//      the units allow, otherwise Gemini's count is used.
//
// Shared by the web app and eval/run.mjs so the eval scores the real code.
import { S } from './gemini.js';
import { ALL_UNITS, normalizeUnit, packagesNeeded, summarizeNeeds } from './units.js';
import { chunk, mapLimit, tokens } from './util.js';

const NORMALIZE_SYSTEM = `You turn recipe ingredient lines into grocery shopping entries for a US Fred Meyer (Kroger) store.

For every line return one entry per item to buy (usually one; "salt and pepper" is two). Fields:
- line: the line id you were given.
- name: the generic grocery item, lowercase, singular. Drop preparation words (chopped, minced, softened, divided, room temperature, to taste, for serving, plus any note in parentheses that is about preparation). KEEP words that change which product to buy: "unsalted butter", "low-sodium chicken broth", "boneless skinless chicken thighs", "extra-virgin olive oil", "fresh cilantro", "dried oregano", "ground cumin", "canned diced tomatoes", "shredded mozzarella", "heavy cream". Use the identical name for the identical item across lines.
- searchTerm: what a shopper would type into the store's search box, 1-5 words, e.g. "yellow onion", "diced tomatoes", "boneless skinless chicken thighs", "ground cumin".
- quantity: the amount as written on the line (do not scale). Fractions as decimals; for ranges use the larger number. null if no amount ("to taste", "for frying").
- unit: one of ${ALL_UNITS.join(', ')}; or null. Use "count" for whole things ("2 eggs", "1 onion", "3 limes"). "1 (15 oz) can black beans" -> quantity 1, unit "can". "8 oz cream cheese" -> 8 "oz". "1 cup shredded cheddar" -> 1 "cup". "1 lb ground beef" -> 1 "lb". "2 cloves garlic" -> 2 "clove". "1 stick butter" -> 1 "stick".
- optional: true if the line says optional, for garnish, or for serving.
- skip: true for things nobody buys (water, ice, "hot water") and for lines that are not ingredients (section headings like "For the sauce:", references like "see notes").
- pantryMatch: if the household's pantry list (given below) already covers this item, the pantry entry exactly as written; otherwise null. Only match the same product: "kosher salt" matches "salt", "freshly ground black pepper" matches "black pepper", but "bell pepper" does not match "black pepper" and "garlic powder" does not match "garlic".
- preferredSearch: if one of the household's shopping preferences (given below) asks for a particular version of this item (organic, a brand, a fat level...), a 1-6 word store search for that version, e.g. "organic baby spinach", "tillamook cheddar cheese", "2% milk". null when no preference applies, when the preference only rules things out ("no store-brand coffee"), or when searchTerm already finds it. Never let a preference change what the recipe asks for: a recipe's "whole milk" stays whole milk.`;

const NORMALIZE_SCHEMA = S.obj({
  items: S.arr(S.obj({
    line: S.str(),
    name: S.str(),
    searchTerm: S.str(),
    quantity: S.nullable(S.num()),
    unit: S.nullable(S.str()),
    optional: S.bool(),
    skip: S.bool(),
    pantryMatch: S.nullable(S.str()),
    preferredSearch: S.nullable(S.str()),
  })),
});

const PICK_SYSTEM = `You are shopping at a US Fred Meyer store for recipe ingredients. For each needed item you get numbered product candidates from the store's search. Choose the one to buy.

Rules, in priority order:
1. It must BE the item, not a different product that contains or resembles it: not onion powder for onion, not garlic salt for garlic, not a seasoning mix, frozen meal, snack, or baby food for a fresh ingredient, not flavored/sweetened versions of a plain item ("vanilla almond milk" is wrong for "almond milk").
2. Match the qualifiers in the need: unsalted vs salted, low-sodium, boneless skinless, fresh vs dried vs canned, whole vs ground spice, fat level for milk/yogurt/meat when stated.
3. A candidate marked HOUSEHOLD USUAL is what this household chose for this item before: choose it unless it breaks rule 1 or 2.
4. Follow the household's shopping preferences (listed before the items, if any) wherever they apply: brands, organic, fat levels, things to avoid. They override rules 5 and 6.
5. Otherwise choose the most ordinary version (2% milk is fine; plain over flavored; regular over organic). Prefer in-stock items. Prefer the store brands (Kroger, Simple Truth, Private Selection) or the cheaper option when products are otherwise equivalent.
6. Choose a size that covers the needed amount with the least waste. Don't buy a 5 lb bag for 1 tablespoon if a small package exists; small amounts of spices, oils and condiments: one standard package.
7. Fresh produce: prefer single/loose items for small counts, bags when the recipe needs a lot.

packages = how many units of the chosen product to put in the cart to cover the amount (usually 1). If no candidate is acceptable, use choice -1.
reason = at most 12 words. When the household's usual or a preference decided it, say so ("your usual", "organic, per your preferences").`;

const PICK_SCHEMA = S.obj({
  picks: S.arr(S.obj({
    id: S.str(),
    choice: S.int('candidate number, or -1 if none fit'),
    packages: S.int(),
    reason: S.str(),
  })),
});

export const MAX_CANDIDATES = 8;
const MAX_PREFERRED = 4; // extra candidates from the preferred-version search

// "Household shopping preferences" block for prompts, or ''.
const preferencesBlock = (preferences) => (preferences.length
  ? `Household shopping preferences:\n${preferences.map((p) => `- ${p}`).join('\n')}\n\n`
  : '');

export function itemKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
}

function describeCandidate(p, i) {
  const bits = [`[${i}] ${p.brand && !p.description.includes(p.brand) ? `${p.brand} ` : ''}${p.description}`];
  if (p.size) bits.push(p.size);
  if (p.soldBy === 'WEIGHT') bits.push('sold by weight');
  if (p.price != null) bits.push(`$${(p.promoPrice || p.price).toFixed(2)}${p.promoPrice ? ' (sale)' : ''}`);
  if (p.inStock === false) bits.push('OUT OF STOCK');
  if (p.usual) bits.push('HOUSEHOLD USUAL');
  return bits.join(' | ');
}

// Cheap fallback when Gemini can't pick: most query words in the
// description, in stock, cheapest.
export function heuristicPick(item, candidates) {
  const want = new Set(tokens(`${item.name} ${item.searchTerm}`));
  let best = -1;
  let bestScore = -Infinity;
  candidates.forEach((p, i) => {
    const have = tokens(`${p.brand || ''} ${p.description}`);
    const overlap = have.filter((t) => want.has(t)).length;
    const extra = have.length - overlap;
    const score = overlap * 10 - extra - (p.inStock === false ? 50 : 0) - (p.price || 0) * 0.1;
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return best;
}

export async function normalizeLines({ lines, pantry, gemini, preferences = [], concurrency = 2 }) {
  const pantryText = pantry.length ? pantry.join('\n') : '(empty)';
  const prefsText = preferences.length ? preferences.join('\n') : '(none)';
  const batches = chunk(lines, 40);
  const results = await mapLimit(batches, concurrency, async (batch) => {
    const prompt = `Household pantry list:\n${pantryText}\n\nHousehold shopping preferences:\n${prefsText}\n\nIngredient lines:\n${batch.map((l) => `${l.id}: ${l.text}`).join('\n')}`;
    // Match keeps the 30-second limit only (no separate start limit) for now.
    const out = await gemini.json(prompt, NORMALIZE_SCHEMA, { system: NORMALIZE_SYSTEM, startTimeoutMs: null });
    return out.items || [];
  });
  const byId = new Map(lines.map((l) => [l.id, l]));
  const pantryLower = new Map(pantry.map((p) => [p.toLowerCase().trim(), p]));
  const entries = [];
  for (const e of results.flat()) {
    const line = byId.get(String(e.line));
    if (!line || !e.name) continue;
    const unit = normalizeUnit(e.unit);
    const qty = typeof e.quantity === 'number' && e.quantity > 0 ? e.quantity * (line.scale ?? 1) : null;
    const pantryMatch = (e.pantryMatch && pantryLower.get(String(e.pantryMatch).toLowerCase().trim()))
      || pantryLower.get(String(e.name).toLowerCase().trim()) || null;
    entries.push({
      line: line.id,
      text: line.text,
      recipe: line.recipe,
      name: String(e.name).trim(),
      searchTerm: String(e.searchTerm || e.name).trim(),
      preferredSearch: e.preferredSearch && itemKey(e.preferredSearch) !== itemKey(e.searchTerm) ? String(e.preferredSearch).trim() : null,
      qty,
      unit: qty == null ? null : unit,
      optional: Boolean(e.optional),
      skip: Boolean(e.skip),
      pantryMatch,
    });
  }
  // Lines Gemini dropped entirely still get surfaced so nothing silently vanishes.
  const seen = new Set(entries.map((e) => e.line));
  for (const l of lines) {
    if (!seen.has(l.id)) entries.push({ line: l.id, text: l.text, recipe: l.recipe, name: l.text, searchTerm: l.text, qty: null, unit: null, optional: false, skip: false, pantryMatch: null, unparsed: true });
  }
  return entries;
}

export function groupEntries(entries, { merge = true } = {}) {
  const items = [];
  const skipped = [];
  const byKey = new Map();
  for (const e of entries) {
    const reason = e.skip ? 'not needed' : e.pantryMatch ? `pantry: ${e.pantryMatch}` : e.optional ? 'optional' : null;
    const need = { qty: e.qty, unit: e.unit, text: e.text, recipe: e.recipe, line: e.line };
    if (reason) {
      skipped.push({ ...e, reason, needs: [need] });
      continue;
    }
    const key = merge ? itemKey(e.name) : e.line;
    let item = byKey.get(key);
    if (!item) {
      item = { key, name: e.name, searchTerm: e.searchTerm, preferredSearch: e.preferredSearch || null, needs: [], recipes: [], lines: [] };
      byKey.set(key, item);
      items.push(item);
    }
    item.preferredSearch ||= e.preferredSearch || null;
    item.needs.push(need);
    item.lines.push(e.line);
    if (!item.recipes.includes(e.recipe)) item.recipes.push(e.recipe);
  }
  return { items, skipped };
}

// usuals: {itemKey(name): {upc, description, ...}}, the household's usual
// product per item. It's looked up by its description and, when the store
// has it, goes first, marked usual.
export async function findCandidates(items, searchProducts, { usuals = {} } = {}) {
  const usualFor = (item) => usuals[itemKey(item.name)];
  const terms = [...new Set(items.flatMap((i) => [i.searchTerm, i.preferredSearch, usualFor(i)?.description]).filter(Boolean))];
  const found = await searchProducts(terms);
  // A term's value is a product list, or {error} when the search itself failed.
  const listFor = (map, term) => (Array.isArray(map[term]) ? map[term] : []);
  // Retry with the plain item name when the search term found nothing.
  const retry = items.filter((i) => !listFor(found, i.searchTerm).length && itemKey(i.name) !== itemKey(i.searchTerm));
  const retryFound = retry.length ? await searchProducts([...new Set(retry.map((i) => i.name))]) : {};
  for (const item of items) {
    let list = listFor(found, item.searchTerm);
    if (!list.length && listFor(retryFound, item.name).length) list = listFor(retryFound, item.name);
    const usual = usualFor(item);
    const usualProduct = usual && listFor(found, usual.description).find((p) => p.upc === usual.upc);
    item.usualMissing = Boolean(usual && !usualProduct);
    // Usual first, then the preferred version, then the plain search.
    const seen = new Set();
    item.candidates = [
      ...(usualProduct ? [{ ...usualProduct, usual: true }] : []),
      ...(item.preferredSearch ? listFor(found, item.preferredSearch).filter((p) => p.upc).slice(0, MAX_PREFERRED) : []),
      ...list.filter((p) => p.upc).slice(0, MAX_CANDIDATES),
    ].filter((p) => !seen.has(p.upc) && seen.add(p.upc));
    item.searchError = item.candidates.length ? null : (found[item.searchTerm]?.error || retryFound[item.name]?.error || null);
  }
}

export async function pickProducts(items, gemini, { preferences = [], concurrency = 2 } = {}) {
  const withCandidates = items.filter((i) => i.candidates.length);
  await mapLimit(chunk(withCandidates, 12), concurrency, async (batch) => {
    const prompt = preferencesBlock(preferences) + batch.map((item, n) => [
      `### id ${n}`,
      `need: ${item.name} — ${summarizeNeeds(item.needs)}${item.recipes.length > 1 ? ` (combined from ${item.recipes.length} recipes)` : ''}`,
      `recipe text: ${item.needs.map((x) => x.text).join(' / ')}`,
      'candidates:',
      ...item.candidates.map(describeCandidate),
    ].join('\n')).join('\n\n');
    let picks = [];
    try {
      picks = (await gemini.json(prompt, PICK_SCHEMA, { system: PICK_SYSTEM, startTimeoutMs: null })).picks || [];
    } catch (err) {
      batch.forEach((item) => { item.pickError = err.message; });
    }
    batch.forEach((item, n) => {
      const pick = picks.find((p) => String(p.id) === String(n));
      if (pick && Number.isInteger(pick.choice) && pick.choice >= -1 && pick.choice < item.candidates.length) {
        item.choice = pick.choice;
        item.geminiChoice = pick.choice;
        item.geminiPackages = Number.isInteger(pick.packages) && pick.packages > 0 ? pick.packages : null;
        item.reason = pick.reason || '';
      } else {
        item.choice = heuristicPick(item, item.candidates);
        item.reason = 'best text match (AI pick unavailable)';
      }
    });
  });
  for (const item of items) {
    if (!item.candidates.length) {
      item.choice = -1;
      item.reason = item.searchError ? 'search failed' : 'no products found';
    }
    if (item.usualMissing) item.reason = `${item.reason ? `${item.reason} · ` : ''}your usual isn't at this store`;
    setPackages(item);
  }
}

// Recompute the package count for the item's current choice. Also used by the
// UI when the user swaps products.
export function setPackages(item) {
  const product = item.candidates[item.choice];
  if (!product) {
    item.packages = 0;
    item.packagesSource = 'none';
    return item;
  }
  const computed = product.soldBy === 'WEIGHT' ? null : packagesNeeded(item.needs, product.size);
  if (computed != null) {
    item.packages = computed;
    item.packagesSource = 'computed';
  } else if (item.geminiPackages && item.geminiChoice === item.choice) {
    item.packages = item.geminiPackages;
    item.packagesSource = 'ai';
  } else {
    item.packages = 1;
    item.packagesSource = 'default';
  }
  return item;
}

// preferences: the household's shopping preferences, one per line.
// usuals: see findCandidates.
export async function resolveIngredients({ recipes, pantry = [], preferences = [], usuals = {}, gemini, searchProducts, merge = true, onProgress = () => {} }) {
  const lines = recipes.flatMap((r, ri) => r.ingredients.map((text, li) => ({
    id: `${ri + 1}.${li + 1}`,
    text,
    recipe: r.name,
    scale: r.scale ?? 1,
  })));
  if (!lines.length) return { items: [], skipped: [] };

  onProgress(`Reading ${lines.length} ingredient lines…`);
  const entries = await normalizeLines({ lines, pantry, gemini, preferences });
  const { items, skipped } = groupEntries(entries, { merge });

  onProgress(`Searching Fred Meyer for ${items.length} items…`);
  await findCandidates(items, searchProducts, { usuals });

  onProgress('Choosing products…');
  await pickProducts(items, gemini, { preferences });
  return { items, skipped };
}

export function estimateTotal(items) {
  let total = 0;
  for (const item of items) {
    const p = item.candidates?.[item.choice];
    if (p && !item.removed) total += (p.promoPrice || p.price || 0) * (item.packages || 0);
  }
  return total;
}
