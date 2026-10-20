import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTotal, heuristicPick, resolveIngredients, setPackages } from '../web/js/resolver.js';
import { describeCriteria, filterRecipes, findRecipes, generateQueries, scaleFor, shoppingIngredients } from '../web/js/recipes.js';

// Fake Gemini: answers the normalize prompt from a table keyed by line text,
// and the pick prompt with a provided function.
function fakeGemini({ normalized, pick }) {
  const calls = [];
  return {
    calls,
    async json(prompt, _schema, { system } = {}) {
      calls.push({ prompt, system });
      if (system.startsWith('You turn recipe ingredient lines')) {
        const items = [];
        for (const m of prompt.matchAll(/^(\d+\.\d+): (.*)$/gm)) {
          for (const entry of normalized[m[2]] || []) items.push({ line: m[1], optional: false, skip: false, pantryMatch: null, ...entry });
        }
        return { items };
      }
      const picks = [];
      for (const m of prompt.matchAll(/### id (\d+)\nneed: ([^—]+) —/g)) picks.push({ id: m[1], ...pick(m[2].trim()) });
      return { picks };
    },
  };
}

const product = (upc, description, size, price, extra = {}) => ({ upc, productId: upc, description, size, price, brand: 'Kroger', inStock: true, soldBy: 'UNIT', ...extra });

const CATALOG = {
  'yellow onion': [product('1', 'Onion Powder', '3 oz', 2.5), product('2', 'Yellow Onion', '1 each', 0.99)],
  'black beans': [product('3', 'Kroger® Black Beans', '15 oz', 0.89)],
  'chicken broth': [product('4', 'Kroger® Chicken Broth', '32 fl oz', 1.99)],
  'cilantro': [],
  'fresh cilantro': [product('5', 'Cilantro Bunch', '1 ct', 0.79)],
};

const NORMALIZED = {
  '1 onion, diced': [{ name: 'yellow onion', searchTerm: 'yellow onion', quantity: 1, unit: 'count' }],
  '2 yellow onions': [{ name: 'Yellow Onion', searchTerm: 'yellow onion', quantity: 2, unit: 'counts' }],
  '1 (15 oz) can black beans, drained': [{ name: 'black beans', searchTerm: 'black beans', quantity: 1, unit: 'can' }],
  '4 cups chicken broth': [{ name: 'chicken broth', searchTerm: 'chicken broth', quantity: 4, unit: 'cups' }],
  'Kosher salt and pepper': [
    { name: 'kosher salt', searchTerm: 'kosher salt', quantity: null, unit: null, pantryMatch: 'Salt' },
    { name: 'black pepper', searchTerm: 'black pepper', quantity: null, unit: null, pantryMatch: 'black pepper' },
  ],
  '1/4 cup water': [{ name: 'water', searchTerm: 'water', quantity: 0.25, unit: 'cup', skip: true }],
  'Cilantro, for garnish': [{ name: 'cilantro', searchTerm: 'cilantro', quantity: null, unit: null, optional: true }],
  '1 bunch cilantro': [{ name: 'fresh cilantro', searchTerm: 'cilantro', quantity: 1, unit: 'bunch' }],
};

test('end-to-end resolve: normalize, pantry, merge, search, pick, packages', async () => {
  const gemini = fakeGemini({
    normalized: NORMALIZED,
    pick: (name) => (name === 'yellow onion' ? { choice: 1, packages: 9, reason: 'fresh onion' } : { choice: 0, packages: 1, reason: 'ok' }),
  });
  const searched = [];
  const searchProducts = async (terms) => {
    searched.push(terms);
    return Object.fromEntries(terms.map((t) => [t, CATALOG[t] || []]));
  };
  const { items, skipped } = await resolveIngredients({
    recipes: [
      { name: 'Chili', ingredients: ['1 onion, diced', '1 (15 oz) can black beans, drained', 'Kosher salt and pepper', '1/4 cup water'], scale: 2 },
      { name: 'Soup', ingredients: ['2 yellow onions', '4 cups chicken broth', 'Cilantro, for garnish', '1 bunch cilantro'], scale: 1 },
    ],
    pantry: ['Salt', 'black pepper', 'olive oil'],
    gemini,
    searchProducts,
  });

  assert.deepEqual(skipped.map((s) => s.reason).sort(), ['not needed', 'optional', 'pantry: Salt', 'pantry: black pepper']);

  const byName = Object.fromEntries(items.map((i) => [i.name.toLowerCase(), i]));
  assert.deepEqual(Object.keys(byName).sort(), ['black beans', 'chicken broth', 'fresh cilantro', 'yellow onion']);

  const onion = byName['yellow onion'];
  assert.deepEqual(onion.recipes, ['Chili', 'Soup']);
  assert.deepEqual(onion.needs.map((n) => [n.qty, n.unit]), [[2, 'count'], [2, 'count']], 'Chili scaled ×2, units normalized');
  assert.equal(onion.candidates[onion.choice].upc, '2');
  assert.equal(onion.packages, 4, 'computed from "1 each", not Gemini\'s 9');
  assert.equal(onion.packagesSource, 'computed');

  assert.equal(byName['black beans'].packages, 2, '1 can × scale 2');
  assert.equal(byName['chicken broth'].packages, 1, '4 cups ≈ 32 fl oz');

  const cilantro = byName['fresh cilantro'];
  assert.equal(cilantro.candidates[0].upc, '5', 'term "cilantro" found nothing, retried with item name');
  assert.equal(cilantro.packages, 1);
  assert.equal(searched.length, 2);

  assert.equal(Math.round(estimateTotal(items) * 100) / 100, Math.round((0.99 * 4 + 0.89 * 2 + 1.99 + 0.79) * 100) / 100);
});

test('merge:false keeps every line separate (eval mode)', async () => {
  const gemini = fakeGemini({ normalized: NORMALIZED, pick: () => ({ choice: 0, packages: 1, reason: '' }) });
  const { items } = await resolveIngredients({
    recipes: [{ name: 'eval', ingredients: ['1 onion, diced', '2 yellow onions'] }],
    gemini,
    searchProducts: async (terms) => Object.fromEntries(terms.map((t) => [t, CATALOG[t] || []])),
    merge: false,
  });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.key), ['1.1', '1.2']);
});

test('bad Gemini picks fall back to the text heuristic; lines Gemini drops still surface', async () => {
  const gemini = fakeGemini({ normalized: NORMALIZED, pick: () => ({ choice: 7, packages: 1, reason: '' }) });
  const { items } = await resolveIngredients({
    recipes: [{ name: 'x', ingredients: ['1 onion, diced', 'a mystery line'] }],
    gemini,
    searchProducts: async (terms) => Object.fromEntries(terms.map((t) => [t, CATALOG[t] || []])),
  });
  const onion = items.find((i) => i.name === 'yellow onion');
  assert.equal(onion.candidates[onion.choice].description, 'Yellow Onion');
  const mystery = items.find((i) => i.name === 'a mystery line');
  assert.equal(mystery.choice, -1);
});

test('heuristicPick prefers matching, in-stock items', () => {
  const item = { name: 'unsalted butter', searchTerm: 'unsalted butter' };
  const c = [
    product('1', 'Salted Butter Sticks', '16 oz', 4),
    product('2', 'Unsalted Butter', '16 oz', 4, { inStock: false }),
    product('3', 'Kroger Unsalted Butter Sticks', '16 oz', 4.5),
  ];
  assert.equal(heuristicPick(item, c), 2);
});

test('setPackages after a swap uses the new product size', () => {
  const item = { needs: [{ qty: 3, unit: 'lb' }], candidates: [product('1', 'Beef', '1 lb', 5), product('2', 'Beef', '3 lb', 13)], choice: 0 };
  assert.equal(setPackages(item).packages, 3);
  item.choice = 1;
  assert.equal(setPackages(item).packages, 1);
});

test('recipe filters and scaling', () => {
  const base = { site: 'a.example', ingredients: ['1 lb chicken thighs', '1 cup rice'], totalMinutes: 40, rating: { value: 4.6 } };
  const recipes = [
    { ...base, name: 'A' },
    { ...base, name: 'A' },
    { ...base, name: 'Slow', totalMinutes: 240 },
    { ...base, name: 'Meh', rating: { value: 3.1 } },
    { ...base, name: 'Unknown time', totalMinutes: null },
    { ...base, name: 'Has rice', site: 'b.example' },
  ];
  const { kept, rejected } = filterRecipes(recipes, { maxMinutes: 60, minRating: 4, exclude: [] });
  assert.deepEqual(kept.map((r) => r.name), ['A', 'Unknown time', 'Has rice']);
  assert.deepEqual(rejected.map((r) => r.reason), ['duplicate', 'takes 240 min', 'rated 3.1']);

  assert.equal(scaleFor({ servings: 6 }, 4), 0.67);
  assert.equal(scaleFor({ servings: null }, 4), 1);
});

test('search errors are kept on the item instead of looking like "no products"', async () => {
  const gemini = fakeGemini({ normalized: NORMALIZED, pick: () => ({ choice: 0, packages: 1, reason: '' }) });
  const { items } = await resolveIngredients({
    recipes: [{ name: 'x', ingredients: ['1 onion, diced', '4 cups chicken broth'] }],
    gemini,
    searchProducts: async (terms) => Object.fromEntries(terms.map((t) => [t, t === 'chicken broth' ? { error: 'Kroger /products returned 429' } : CATALOG[t] || []])),
  });
  const broth = items.find((i) => i.name === 'chicken broth');
  assert.equal(broth.choice, -1);
  assert.equal(broth.searchError, 'Kroger /products returned 429');
  assert.equal(broth.reason, 'search failed');
  assert.equal(items.find((i) => i.name === 'yellow onion').searchError, null);
});

test('Gemini falls back to the light model on 429 and stays there', async () => {
  const { createGemini, createModelSwitch } = await import('../web/js/gemini.js');
  const changes = [];
  const sw = createModelSwitch({ strong: 'strong-m', light: 'light-m', onChange: (tier, model, reason) => changes.push([tier, model, reason]) });
  const called = [];
  const fetchImpl = async (url) => {
    const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
    called.push(model);
    if (model === 'strong-m') return new Response('{"error":{"message":"quota"}}', { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
  };
  const g = createGemini({ apiKey: 'k', model: sw, fetchImpl });
  assert.deepEqual(await g.json('p', {}), { ok: true });
  assert.deepEqual(called, ['strong-m', 'light-m'], 'retried immediately on the light model');
  assert.deepEqual(changes, [['light', 'light-m', 'limit']]);
  await g.json('p', {});
  assert.deepEqual(called.slice(2), ['light-m'], 'stays on light');
  sw.set('strong');
  assert.equal(g.model, 'strong-m');
  assert.deepEqual(changes.at(-1), ['strong', 'strong-m', 'manual']);
  // A plain model id still works (eval script) with no switching.
  assert.equal(createGemini({ apiKey: 'k', model: 'x' }).model, 'x');
});

test('recommendations: taste profile in prompts, saved recipes skipped', async () => {
  const { generateQueries, rankRecipes, describeTaste } = await import('../web/js/recipes.js');
  const prompts = [];
  const gemini = { json: async (prompt) => { prompts.push(prompt); return prompt.includes('Candidate recipes') ? { ranking: [{ index: 0, score: 80, reason: 'like your tacos' }] } : { queries: ['a recipe', 'b recipe', 'c recipe', 'd recipe'] }; } };
  const liked = [{ url: 'https://x/tacos', name: 'Fish Tacos', cuisine: ['Mexican'], keywords: ['fish', 'tacos'] }];
  assert.equal(describeTaste(liked), '- Fish Tacos (Mexican, fish, tacos)');

  assert.equal((await generateQueries(gemini, { maxMinutes: 30 }, { liked })).length, 3);
  assert.match(prompts[0], /Fish Tacos/);
  assert.match(prompts[0], /NEW dishes/);
  assert.match(prompts[0], /at most 30 minutes/);
  await generateQueries(gemini, {}, { liked: [] });
  assert.match(prompts[1], /haven't saved any recipes/);
  await generateQueries(gemini, { wants: 'soup' });
  assert.doesNotMatch(prompts[2], /saved/);

  const recipe = { url: 'https://y/enchiladas', name: 'Enchiladas', site: 'y', ingredients: ['tortillas'] };
  const ranked = await rankRecipes(gemini, [recipe], {}, { liked });
  assert.equal(ranked[0].reason, 'like your tacos');
  assert.match(prompts[3], /their taste/);

  const { kept, rejected } = filterRecipes([recipe, { ...recipe, url: 'https://x/tacos', name: 'Fish Tacos' }], { skipUrls: new Set(['https://x/tacos']) });
  assert.deepEqual(kept.map((r) => r.name), ['Enchiladas']);
  assert.equal(rejected[0].reason, 'already in Save');
});

test('daily ideas: prompt uses season and taste, output is cleaned', async () => {
  const { generateIdeas, todayKey } = await import('../web/js/suggestions.js');
  let prompt;
  const reply = ['1. Miso salmon bowls.', 'miso salmon bowls', 'x', '15-minute garlic shrimp', '- one-pan gnocchi', ...Array.from({ length: 10 }, (_, i) => `idea number ${i}`)];
  const gemini = { json: async (p) => { prompt = p; return { ideas: reply }; } };
  const ideas = await generateIdeas(gemini, { liked: [{ name: 'Fish Tacos', cuisine: ['Mexican'] }], now: new Date(2026, 9, 18) });
  assert.match(prompt, /It's October/);
  assert.match(prompt, /Fish Tacos/);
  assert.equal(ideas[0], 'Miso salmon bowls', 'numbering and trailing period stripped');
  assert.equal(ideas.filter((s) => s.toLowerCase() === 'miso salmon bowls').length, 1, 'deduped');
  assert.ok(!ideas.includes('x'), 'too-short dropped');
  assert.ok(ideas.includes('15-minute garlic shrimp'), 'leading numbers that are part of the idea survive');
  assert.ok(ideas.includes('one-pan gnocchi'), 'bullet stripped');
  assert.equal(await generateIdeas({ json: async () => ({ ideas: ['only', 'three', 'ideas'] }) }), null, 'too few -> keep built-in');
  assert.equal(todayKey(new Date(2026, 0, 5)), '2026-01-05');
});

test('Easy: ingredient and step limits, pantry staples not counted, query hint', async () => {
  const base = { site: 's', url: 'u', totalMinutes: 20, rating: null };
  const ok = { ...base, name: 'Ok', ingredients: ['1 tsp kosher salt', '2 tbsp olive oil', ...Array.from({ length: 10 }, (_, i) => `item ${i}`)], instructions: ['For the sauce:', 'a', 'b'] };
  const many = { ...base, name: 'Many', ingredients: Array.from({ length: 11 }, (_, i) => `item ${i}`), instructions: ['a'] };
  const long = { ...base, name: 'Long', ingredients: ['x'], instructions: Array.from({ length: 9 }, (_, i) => `step ${i}`) };
  const unknown = { ...base, name: 'Unknown steps', ingredients: ['x'] };
  assert.equal(shoppingIngredients(ok, ['salt', 'olive oil']).length, 10);
  const { kept, rejected } = filterRecipes([ok, many, long, unknown], { easy: true, pantry: ['salt', 'olive oil'] });
  assert.deepEqual(kept.map((r) => r.name), ['Ok', 'Unknown steps']);
  assert.deepEqual(rejected.map((r) => r.reason), ['11 ingredients (Easy: 10 max)', '9 steps (Easy: 8 max)']);
  assert.equal(filterRecipes([many, long], { easy: false }).kept.length, 2, 'off: no limits');
  const custom = filterRecipes([ok, many, long], { easy: true, pantry: ['salt', 'olive oil'], easyMaxIngredients: 8, easyMaxSteps: 12 });
  assert.deepEqual(custom.rejected.map((r) => r.reason), ['10 ingredients (Easy: 8 max)', '11 ingredients (Easy: 8 max)'], 'household limits from Config');
  assert.match(describeCriteria({ easy: true }), /Easy: few ingredients/);
  let prompt;
  await generateQueries({ json: async (p) => { prompt = p; return { queries: ['easy recipe'] }; } }, { wants: 'tacos', easy: true });
  assert.match(prompt, /put a word like "easy"/);
  await generateQueries({ json: async (p) => { prompt = p; return { queries: ['x recipe'] }; } }, { wants: 'tacos' });
  assert.doesNotMatch(prompt, /put a word like "easy"/);
});

test('Easy applies to Suggest (recommendations) as well as Search', async () => {
  const recipe = (n, ingredients, instructions) => ({ url: `https://x.test/${n}`, name: n, site: 'x.test', ingredients, instructions, totalMinutes: 30, rating: null });
  const pages = {
    'https://x.test/simple': recipe('simple', ['chicken', 'rice', 'lemon'], ['Cook.', 'Serve.']),
    'https://x.test/fussy': recipe('fussy', Array.from({ length: 15 }, (_, i) => `thing ${i}`), ['Cook.']),
  };
  const relay = { search: async () => ({ results: Object.keys(pages).map((url) => ({ url })) }), recipe: async (url) => ({ recipe: pages[url] }) };
  const prompts = [];
  const gemini = { json: async (p) => {
    prompts.push(p);
    return p.includes('Candidate recipes:') ? { ranking: [{ index: 0, score: 90, reason: 'x' }] } : { queries: ['easy chicken recipe'] };
  } };
  const liked = [{ url: 'https://x.test/saved', name: 'Saved tacos', cuisine: ['Mexican'] }];
  const out = await findRecipes({ gemini, relay, criteria: { easy: true, easyMaxIngredients: 10, easyMaxSteps: 8 }, liked });
  assert.match(prompts[0], /Recipes they've saved/, 'suggest mode');
  assert.match(prompts[0], /They want it easy/);
  assert.match(prompts[0], /Easy: few ingredients/);
  assert.deepEqual(out.ranked.map((r) => r.recipe.name), ['simple']);
  assert.deepEqual(out.rejected.map((r) => r.reason), ['15 ingredients (Easy: 10 max)']);
  assert.match(prompts[1], /Easy: few ingredients/, 'ranking knows too');
});

test('New: queries and ranking aim away from saved recipes, still honoring inputs and Easy', async () => {
  const recipe = (n, ingredients) => ({ url: `https://x.test/${n}`, name: n, site: 'x.test', ingredients, instructions: ['Cook.'], totalMinutes: 30, rating: null });
  const pages = {
    'https://x.test/saved': recipe('saved', ['chicken']),
    'https://x.test/laksa': recipe('laksa', ['noodles', 'coconut milk', 'shrimp']),
    'https://x.test/fussy': recipe('fussy', Array.from({ length: 15 }, (_, i) => `thing ${i}`)),
  };
  const relay = { search: async () => ({ results: Object.keys(pages).map((url) => ({ url })) }), recipe: async (url) => ({ recipe: pages[url] }) };
  const prompts = [];
  const gemini = { json: async (p) => {
    prompts.push(p);
    return p.includes('Candidate recipes:') ? { ranking: [{ index: 0, score: 88, reason: 'A Malaysian noodle soup, unlike your Mexican favorites.' }] } : { queries: ['laksa recipe'] };
  } };
  const liked = [{ url: 'https://x.test/saved', name: 'Saved tacos', cuisine: ['Mexican'] }];
  const out = await findRecipes({ gemini, relay, criteria: { wants: 'soup', easy: true, easyMaxIngredients: 10, easyMaxSteps: 8 }, liked, novel: true });
  assert.match(prompts[0], /try something new[\s\S]*Saved tacos/);
  assert.match(prompts[0], /clearly DIFFERENT from what they've saved/);
  assert.match(prompts[0], /Looking for: soup/, 'what they typed still counts');
  assert.match(prompts[0], /They want it easy/);
  assert.match(prompts[1], /clearly unlike what they've saved/);
  assert.deepEqual(out.ranked.map((r) => r.recipe.name), ['laksa']);
  assert.deepEqual(out.rejected.map((r) => r.reason).sort(), ['15 ingredients (Easy: 10 max)', 'already in Save']);

  prompts.length = 0;
  await generateQueries(gemini, {}, { liked: [], novel: true });
  assert.match(prompts[0], /three clearly different cuisines/, 'nothing saved yet');
});

test('shopping preferences and usuals: extra searches, usual first, both in the prompts', async () => {
  const gemini = fakeGemini({
    normalized: {
      '2 cups baby spinach': [{ name: 'baby spinach', searchTerm: 'baby spinach', preferredSearch: 'organic baby spinach', quantity: 2, unit: 'cup' }],
      '1 cup shredded cheddar': [{ name: 'shredded cheddar', searchTerm: 'shredded cheddar', preferredSearch: 'Shredded Cheddar', quantity: 1, unit: 'cup' }],
      '1 cup milk': [{ name: 'milk', searchTerm: 'milk', quantity: 1, unit: 'cup' }],
    },
    pick: (name) => ({ choice: 0, packages: 1, reason: name === 'baby spinach' ? 'organic, per your preferences' : 'your usual' }),
  });
  const CAT = {
    'baby spinach': [product('10', 'Kroger Baby Spinach', '5 oz', 2.5), product('11', 'Simple Truth Organic Baby Spinach', '5 oz', 3.5)],
    'organic baby spinach': [product('11', 'Simple Truth Organic Baby Spinach', '5 oz', 3.5), product('12', 'Earthbound Organic Baby Spinach', '5 oz', 4.5)],
    'shredded cheddar': [product('20', 'Kroger Shredded Cheddar', '8 oz', 2.5)],
    milk: [product('30', 'Kroger 2% Milk', '1 gal', 3.5)],
    'Tillamook Medium Cheddar Shredded Cheese': [product('21', 'Tillamook Medium Cheddar Shredded Cheese', '8 oz', 4.5), product('20', 'Kroger Shredded Cheddar', '8 oz', 2.5)],
    'Organic Valley Whole Milk': [product('31', 'Organic Valley 2% Milk', '1 gal', 6)],
  };
  const searched = [];
  const searchProducts = async (terms) => { searched.push(...terms); return Object.fromEntries(terms.map((t) => [t, CAT[t] || []])); };
  const { items } = await resolveIngredients({
    recipes: [{ name: 'Bowl', ingredients: ['2 cups baby spinach', '1 cup shredded cheddar', '1 cup milk'] }],
    preferences: ['organic produce', 'Tillamook cheese'],
    usuals: {
      'shredded cheddar': { upc: '21', description: 'Tillamook Medium Cheddar Shredded Cheese' },
      milk: { upc: '99', description: 'Organic Valley Whole Milk' },
    },
    gemini,
    searchProducts,
  });
  const by = Object.fromEntries(items.map((i) => [i.name, i]));

  assert.match(gemini.calls[0].prompt, /Household shopping preferences:\norganic produce\nTillamook cheese/);
  assert.match(gemini.calls[1].prompt, /^Household shopping preferences:\n- organic produce\n- Tillamook cheese\n\n### id 0/);
  assert.ok(searched.includes('organic baby spinach'), 'searched for the preferred version');
  assert.equal(by['shredded cheddar'].preferredSearch, null, 'same as the plain search: no extra search');

  // Preferred results join the plain ones, deduped, preferred first.
  assert.deepEqual(by['baby spinach'].candidates.map((c) => c.upc), ['11', '12', '10']);
  assert.equal(by['baby spinach'].reason, 'organic, per your preferences');

  // The usual goes first, marked, and Gemini is told.
  assert.deepEqual(by['shredded cheddar'].candidates.map((c) => [c.upc, Boolean(c.usual)]), [['21', true], ['20', false]]);
  assert.match(gemini.calls[1].prompt, /\[0\] Kroger Tillamook Medium Cheddar Shredded Cheese \| 8 oz \| \$4\.50 \| HOUSEHOLD USUAL/);
  assert.match(gemini.calls[1].system, /HOUSEHOLD USUAL is what this household chose/);

  // A usual this store doesn't carry is noted, not offered.
  assert.deepEqual(by.milk.candidates.map((c) => c.upc), ['30']);
  assert.equal(by.milk.reason, "your usual · your usual isn't at this store");
});

test('no preferences: prompts say so and nothing extra is searched', async () => {
  const gemini = fakeGemini({ normalized: NORMALIZED, pick: () => ({ choice: 0, packages: 1, reason: 'ok' }) });
  const searched = [];
  await resolveIngredients({
    recipes: [{ name: 'Chili', ingredients: ['1 (15 oz) can black beans, drained'] }],
    gemini,
    searchProducts: async (terms) => { searched.push(...terms); return Object.fromEntries(terms.map((t) => [t, CATALOG[t] || []])); },
  });
  assert.match(gemini.calls[0].prompt, /Household shopping preferences:\n\(none\)/);
  assert.match(gemini.calls[1].prompt, /^### id 0/);
  assert.deepEqual(searched, ['black beans']);
});
