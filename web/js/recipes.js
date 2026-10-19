// Recipe search: Gemini writes queries, the relay searches Brave and parses
// pages, the browser filters on structured fields, Gemini ranks survivors.
import { S } from './gemini.js';
import { mapLimit } from './util.js';

export function describeCriteria(c) {
  const parts = [];
  if (c.wants) parts.push(`Looking for: ${c.wants}`);
  if (c.maxMinutes) parts.push(`Ready in at most ${c.maxMinutes} minutes total`);
  if (c.easy) parts.push('Easy: few ingredients, few steps, little prep, nothing fussy (one pan or sheet pan is ideal)');
  if (c.servings) parts.push(`Feeds ${c.servings}`);
  if (c.exclude?.length) parts.push(`Must not contain: ${c.exclude.join(', ')}`);
  if (c.minRating) parts.push(`Rated at least ${c.minRating} stars`);
  return parts.join('\n');
}

// Saved recipes summarized as a taste profile for recommendations.
export function describeTaste(liked) {
  return liked.slice(0, 40).map((r) => {
    const tags = [...(r.cuisine || []), ...(r.category || []), ...(r.keywords || []).slice(0, 6)];
    return `- ${r.name}${tags.length ? ` (${[...new Set(tags)].join(', ')})` : ''}`;
  }).join('\n');
}

const QUERY_RULES = 'Each query should include the word "recipe", be 3-8 words, and approach it from a different angle. Don\'t put time limits or ratings in the query. Target free recipe sites/blogs, not videos or forums.';

// `liked` (saved recipes) switches to recommendation mode: queries for new
// dishes in the same vein, with any filled-in criteria as extra guidance.
export async function generateQueries(gemini, criteria, { liked } = {}) {
  const extra = describeCriteria(criteria);
  let prompt;
  const rules = `${QUERY_RULES}${criteria.easy ? ' They want it easy: put a word like "easy", "simple", "one-pan" or "5-ingredient" in at least two of the queries.' : ''}`;
  if (!liked) {
    prompt = `Write 3 different web search queries that will find free recipe pages matching:\n${extra}\n\n${rules} (e.g. a specific dish, a key ingredient, a style).`;
  } else if (liked.length) {
    prompt = `A couple wants dinner ideas they'll probably like. Recipes they've saved (their taste):\n${describeTaste(liked)}\n${extra ? `\nThey also said:\n${extra}\n` : ''}\nWrite 3 different web search queries for NEW dishes they'd likely enjoy: related in cuisine, flavors or main ingredients to what they've saved, but not the same dishes. Mix it up: one close to their favorites, one from a neighboring cuisine, one a fresh take on an ingredient they use often. ${rules}`;
  } else {
    prompt = `A couple wants dinner ideas. They haven't saved any recipes yet, so suggest popular, well-loved weeknight dinners with variety.${extra ? `\nThey said:\n${extra}` : ''}\n\nWrite 3 different web search queries. ${rules}`;
  }
  const out = await gemini.json(prompt, S.obj({ queries: S.arr(S.str()) }), { temperature: liked ? 0.9 : 0.7 });
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

// Easy: at most this many ingredients (not counting pantry staples) and
// steps, unless the household set its own limits in Config.
export const EASY_MAX_INGREDIENTS = 10;
export const EASY_MAX_STEPS = 8;

const stepCount = (r) => (Array.isArray(r.instructions) ? r.instructions.filter((s) => !/:\s*$/.test(s)).length : null);

// Ingredients that aren't pantry staples ("salt", "olive oil", ...).
export function shoppingIngredients(r, pantry = []) {
  const staples = pantry.map((p) => p.toLowerCase()).filter(Boolean);
  return r.ingredients.filter((line) => {
    const l = line.toLowerCase();
    return !/:\s*$/.test(l) && !staples.some((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(l));
  });
}

// Hard filters on the parsed fields. Unknown values pass (they're flagged in
// the UI) so sites with partial markup aren't thrown away.
export function filterRecipes(recipes, c) {
  const kept = [];
  const rejected = [];
  const seen = new Set();
  const maxIngredients = c.easyMaxIngredients || EASY_MAX_INGREDIENTS;
  const maxSteps = c.easyMaxSteps || EASY_MAX_STEPS;
  for (const r of recipes) {
    const key = `${r.name.toLowerCase()}|${r.site}`;
    let reason = null;
    if (seen.has(key)) reason = 'duplicate';
    else if (c.skipUrls?.has(r.url)) reason = 'already in Save';
    else if (c.maxMinutes && r.totalMinutes && r.totalMinutes > c.maxMinutes) reason = `takes ${r.totalMinutes} min`;
    else if (c.easy && shoppingIngredients(r, c.pantry).length > maxIngredients) reason = `${shoppingIngredients(r, c.pantry).length} ingredients (Easy: ${maxIngredients} max)`;
    else if (c.easy && stepCount(r) > maxSteps) reason = `${stepCount(r)} steps (Easy: ${maxSteps} max)`;
    else if (c.minRating && r.rating?.value && r.rating.value < c.minRating) reason = `rated ${r.rating.value}`;
    else if (c.exclude?.length) {
      const hit = c.exclude.find((x) => r.ingredients.some((line) => line.toLowerCase().includes(x.toLowerCase())));
      if (hit) reason = `contains ${hit}`;
    }
    seen.add(key);
    (reason ? rejected : kept).push(reason ? { recipe: r, reason } : r);
  }
  return { kept, rejected };
}

export async function rankRecipes(gemini, recipes, criteria, { liked } = {}) {
  if (!recipes.length) return [];
  const list = recipes.map((r, i) => [
    `[${i}] ${r.name} (${r.site})`,
    `time: ${r.totalMinutes ?? '?'} min; serves: ${r.servings ?? '?'}; steps: ${stepCount(r) ?? '?'}; rating: ${r.rating ? `${r.rating.value} (${r.rating.count ?? '?'} ratings)` : '?'}`,
    `ingredients: ${r.ingredients.slice(0, 25).join('; ')}`,
  ].join('\n')).join('\n\n');
  const out = await gemini.json(
    liked?.length
      ? `A couple is choosing what to cook. Recipes they've saved (their taste):\n${describeTaste(liked)}\n${describeCriteria(criteria) ? `\nThey also said:\n${describeCriteria(criteria)}\n` : ''}\nCandidate recipes:\n${list}\n\nScore each recipe 0-100 for how likely they are to enjoy it given their taste (and anything they said), favoring variety over near-copies of what they've saved, then ratings with many reviews. Recipes that clearly contain an excluded ingredient score below 10. Give a one-sentence reason that connects it to their taste.`
      : `A couple is choosing what to cook. Their request:\n${describeCriteria(criteria) || 'Anything good for dinner'}\n\nCandidate recipes:\n${list}\n\nScore each recipe 0-100 for how well it fits the request (fit matters most, then ratings with many reviews, then a reasonable ingredient list). Recipes that clearly contain an excluded ingredient score below 10. Give a one-sentence reason a person would find useful (what makes it a good or poor fit).`,
    S.obj({ ranking: S.arr(S.obj({ index: S.int(), score: S.int(), reason: S.str() })) }),
  );
  const scored = recipes.map((r) => ({ recipe: r, score: 0, reason: '' }));
  for (const x of out.ranking || []) {
    if (scored[x.index]) Object.assign(scored[x.index], { score: x.score, reason: x.reason });
  }
  return scored.sort((a, b) => b.score - a.score);
}

// Pass `liked` (saved recipes, possibly empty) for recommendations.
export async function findRecipes({ gemini, relay, criteria, liked, maxPages = 15, onProgress = () => {} }) {
  onProgress(liked ? 'Thinking about what you might like…' : 'Writing search queries…');
  const queries = await generateQueries(gemini, criteria, { liked });
  if (!queries.length) throw new Error('Gemini did not return any search queries.');

  onProgress(`Searching: ${queries.join(' · ')}`);
  const { results } = await relay.search(queries);
  const urls = results.slice(0, maxPages).map((r) => r.url);
  if (!urls.length) throw new Error('No search results. Try different wording.');

  const { recipes, failed } = await fetchRecipes(relay, urls, {
    onEach: (n, total) => onProgress(`Reading recipe pages… ${n}/${total}`),
  });
  const { kept, rejected } = filterRecipes(recipes, { ...criteria, skipUrls: liked ? new Set(liked.map((r) => r.url)) : null });

  onProgress(`Ranking ${kept.length} recipes…`);
  let ranked;
  try {
    ranked = await rankRecipes(gemini, kept, criteria, { liked });
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
