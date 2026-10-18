// Recipe search: Gemini writes queries, the relay searches Brave and parses
// pages, the browser filters on structured fields, Gemini ranks survivors.
import { S } from './gemini.js';
import { mapLimit } from './util.js';

export function describeCriteria(c) {
  const parts = [];
  if (c.wants) parts.push(`Looking for: ${c.wants}`);
  if (c.cuisine) parts.push(`Cuisine: ${c.cuisine}`);
  if (c.diets?.length) parts.push(`Diet: ${c.diets.join(', ')}`);
  if (c.maxMinutes) parts.push(`Ready in at most ${c.maxMinutes} minutes total`);
  if (c.servings) parts.push(`Feeds ${c.servings}`);
  if (c.exclude?.length) parts.push(`Must not contain: ${c.exclude.join(', ')}`);
  if (c.minRating) parts.push(`Rated at least ${c.minRating} stars`);
  return parts.join('\n');
}

export async function generateQueries(gemini, criteria) {
  const out = await gemini.json(
    `Write 3 different web search queries that will find free recipe pages (from recipe sites/blogs, not videos or forums) matching:\n${describeCriteria(criteria)}\n\nEach query should include the word "recipe", be 3-8 words, and approach the request from a different angle (e.g. a specific dish, a key ingredient, a style). Don't put time limits or ratings in the query.`,
    S.obj({ queries: S.arr(S.str()) }),
    { temperature: 0.7 },
  );
  return (out.queries || []).map((q) => String(q).trim()).filter(Boolean).slice(0, 3);
}

// Parse pages through the relay in parallel; each page is its own Worker
// request so one slow site doesn't block the rest.
export async function fetchRecipes(relay, urls, { concurrency = 6, onEach = () => {} } = {}) {
  let done = 0;
  const results = await mapLimit(urls, concurrency, async (url) => {
    try {
      const r = await relay.recipe(url);
      return r.recipe ? r.recipe : { failed: url, reason: r.reason };
    } catch (err) {
      return { failed: url, reason: err.message };
    } finally {
      onEach(++done, urls.length);
    }
  });
  return {
    recipes: results.filter((r) => !r.failed),
    failed: results.filter((r) => r.failed),
  };
}

const DIET_CONFLICTS = {
  vegetarian: /\b(chicken|beef|pork|bacon|ham|sausage|turkey|lamb|veal|prosciutto|pancetta|chorizo|salami|pepperoni|anchov|fish|salmon|tuna|cod|tilapia|shrimp|prawn|crab|lobster|scallop|clam|mussel|gelatin)\b/i,
  vegan: /\b(chicken|beef|pork|bacon|ham|sausage|turkey|lamb|fish|salmon|tuna|shrimp|crab|egg|eggs|milk|butter|cream|cheese|yogurt|honey|parmesan|mozzarella|cheddar|ghee|gelatin|mayonnaise)\b/i,
  'gluten-free': /\b(flour|bread|breadcrumbs|panko|pasta|spaghetti|noodles|tortillas?|soy sauce|barley|couscous|crackers|wheat)\b/i,
  'dairy-free': /\b(milk|butter|cream|cheese|yogurt|parmesan|mozzarella|cheddar|ghee|sour cream|ricotta)\b/i,
};
// Words that make a match harmless ("almond milk", "gluten-free flour", "vegan butter").
const DIET_OK = /\b(almond|oat|soy|coconut|cashew|rice|vegan|plant[- ]based|dairy[- ]free|gluten[- ]free|tamari|corn tortillas?|egg[- ]free|non[- ]dairy|peanut butter|cocoa butter|veggie|vegetable broth)\b/i;

export function dietViolations(recipe, diets = []) {
  const hits = [];
  for (const diet of diets) {
    const re = DIET_CONFLICTS[diet];
    if (!re) continue;
    const bad = recipe.ingredients.find((line) => re.test(line) && !DIET_OK.test(line));
    if (bad) hits.push(`${diet}: "${bad}"`);
  }
  return hits;
}

// Hard filters on the parsed fields. Unknown values pass (they're flagged in
// the UI) so sites with partial markup aren't thrown away.
export function filterRecipes(recipes, c) {
  const kept = [];
  const rejected = [];
  const seen = new Set();
  for (const r of recipes) {
    const key = `${r.name.toLowerCase()}|${r.site}`;
    let reason = null;
    if (seen.has(key)) reason = 'duplicate';
    else if (c.maxMinutes && r.totalMinutes && r.totalMinutes > c.maxMinutes) reason = `takes ${r.totalMinutes} min`;
    else if (c.minRating && r.rating?.value && r.rating.value < c.minRating) reason = `rated ${r.rating.value}`;
    else if (c.exclude?.length) {
      const hit = c.exclude.find((x) => r.ingredients.some((line) => line.toLowerCase().includes(x.toLowerCase())));
      if (hit) reason = `contains ${hit}`;
    }
    if (!reason) {
      const v = dietViolations(r, c.diets);
      if (v.length) reason = v[0];
    }
    seen.add(key);
    (reason ? rejected : kept).push(reason ? { recipe: r, reason } : r);
  }
  return { kept, rejected };
}

export async function rankRecipes(gemini, recipes, criteria) {
  if (!recipes.length) return [];
  const list = recipes.map((r, i) => [
    `[${i}] ${r.name} (${r.site})`,
    `time: ${r.totalMinutes ?? '?'} min; serves: ${r.servings ?? '?'}; rating: ${r.rating ? `${r.rating.value} (${r.rating.count ?? '?'} ratings)` : '?'}`,
    `ingredients: ${r.ingredients.slice(0, 25).join('; ')}`,
  ].join('\n')).join('\n\n');
  const out = await gemini.json(
    `A couple is choosing what to cook. Their request:\n${describeCriteria(criteria)}\n\nCandidate recipes:\n${list}\n\nScore each recipe 0-100 for how well it fits the request (fit matters most, then ratings with many reviews, then a reasonable ingredient list). Recipes that clearly break a stated diet or exclusion score below 10. Give a one-sentence reason a person would find useful (what makes it a good or poor fit).`,
    S.obj({ ranking: S.arr(S.obj({ index: S.int(), score: S.int(), reason: S.str() })) }),
  );
  const scored = recipes.map((r) => ({ recipe: r, score: 0, reason: '' }));
  for (const x of out.ranking || []) {
    if (scored[x.index]) Object.assign(scored[x.index], { score: x.score, reason: x.reason });
  }
  return scored.sort((a, b) => b.score - a.score);
}

export async function findRecipes({ gemini, relay, criteria, maxPages = 15, onProgress = () => {} }) {
  onProgress('Writing search queries…');
  const queries = await generateQueries(gemini, criteria);
  if (!queries.length) throw new Error('Gemini did not return any search queries.');

  onProgress(`Searching: ${queries.join(' · ')}`);
  const { results } = await relay.search(queries);
  const urls = results.slice(0, maxPages).map((r) => r.url);
  if (!urls.length) throw new Error('No search results. Try different wording.');

  const { recipes, failed } = await fetchRecipes(relay, urls, {
    onEach: (n, total) => onProgress(`Reading recipe pages… ${n}/${total}`),
  });
  const { kept, rejected } = filterRecipes(recipes, criteria);

  onProgress(`Ranking ${kept.length} recipes…`);
  let ranked;
  try {
    ranked = await rankRecipes(gemini, kept, criteria);
  } catch (err) {
    ranked = kept.map((recipe) => ({ recipe, score: 0, reason: `(not ranked: ${err.message})` }));
  }
  return { queries, ranked, rejected, failed };
}

// Multiplier to bring a recipe to the wanted number of servings.
export function scaleFor(recipe, servings) {
  if (!servings || !recipe.servings) return 1;
  return Math.round((servings / recipe.servings) * 100) / 100;
}
