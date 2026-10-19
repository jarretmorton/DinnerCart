// Workers KV helpers. One namespace (binding: DC_KV) holds everything,
// separated by key prefix:
//   kroger:user        Fred Meyer account tokens (shared household cart)
//   kroger:app         client-credentials token for product search
//   oauth:state:<s>    pending OAuth logins (10 minute TTL)
//   brave:<hash>       cached search results (7 days)
//   recipe:<hash>      cached parsed recipes (30 days), or a "none" marker
//   products:<hash>    cached Kroger product searches per store + term (6 hours)
//   library            saved recipe library (one JSON array, with each recipe's Cook steps)
//   prefs              shared household preferences (store, pantry, rating floor, daily ideas, ...)
import { HttpError, sha256Hex } from './http.js';

export const DAY = 86400;

export function kv(env) {
  if (!env.DC_KV) throw new HttpError(500, 'not_configured', 'KV namespace binding DC_KV is missing.');
  return env.DC_KV;
}

export async function getJson(env, key) {
  return (await kv(env).get(key, 'json')) ?? null;
}

export async function putJson(env, key, value, ttlSeconds) {
  const opts = ttlSeconds ? { expirationTtl: Math.max(60, Math.round(ttlSeconds)) } : undefined;
  await kv(env).put(key, JSON.stringify(value), opts);
}

export async function del(env, key) {
  await kv(env).delete(key);
}

export async function urlKey(prefix, url) {
  return `${prefix}:${(await sha256Hex(url)).slice(0, 32)}`;
}

// ---- library ----

const LIBRARY_KEY = 'library';
const LIBRARY_MAX = 500;

// One shared list of saved recipes, whether saved by hand or automatically
// when sent to the Fred Meyer cart. Each entry is a recipe plus:
//   savedAt        when it entered the library
//   lastPickedAt   when it was last sent to the Fred Meyer cart
//   pickedCount    how many times it has been sent
export async function libraryList(env) {
  return (await getJson(env, LIBRARY_KEY)) || [];
}

function checkRecipe(recipe) {
  if (!/^https?:\/\//i.test(recipe?.url || '') || !Array.isArray(recipe.ingredients)) {
    throw new HttpError(400, 'bad_recipe', 'Recipe needs an http(s) url and ingredients.');
  }
}

// Insert or update entries (newest first), keeping what's already known
// about each recipe (saved flag, pick history).
async function libraryUpsert(env, recipes, update) {
  const list = await libraryList(env);
  const out = [];
  for (const recipe of recipes) {
    checkRecipe(recipe);
    const id = (await sha256Hex(recipe.url)).slice(0, 16);
    const i = list.findIndex((r) => r.id === id || r.url === recipe.url);
    const prev = i >= 0 ? list.splice(i, 1)[0] : {};
    const entry = { ...prev, ...stripRecipe(recipe), id, ...update(prev) };
    list.unshift(entry);
    out.push(entry);
  }
  await putJson(env, LIBRARY_KEY, list.slice(0, LIBRARY_MAX));
  return out;
}

export async function librarySave(env, recipe) {
  const [entry] = await libraryUpsert(env, [recipe], (prev) => ({ savedAt: prev.savedAt || new Date().toISOString() }));
  return entry;
}

// Recipes just sent to the Fred Meyer cart are saved automatically.
export async function libraryPicked(env, recipes) {
  if (!Array.isArray(recipes) || !recipes.length || recipes.length > 20) {
    throw new HttpError(400, 'bad_request', 'Send 1-20 recipes.');
  }
  const now = new Date().toISOString();
  return libraryUpsert(env, recipes, (prev) => ({ savedAt: prev.savedAt || now, lastPickedAt: now, pickedCount: (prev.pickedCount || 0) + 1 }));
}

export async function libraryDelete(env, id) {
  const list = await libraryList(env);
  const next = list.filter((r) => r.id !== id);
  if (next.length !== list.length) await putJson(env, LIBRARY_KEY, next);
  return list.length - next.length;
}

// Only keep the fields the app uses. Never the original instructions; the
// app's own easy Cook steps (written by Gemini from them) are kept as `cook`.
const RECIPE_FIELDS = ['url', 'name', 'description', 'image', 'author', 'site', 'ingredients', 'totalMinutes', 'prepMinutes', 'cookMinutes', 'servings', 'yieldText', 'rating', 'nutrition', 'cuisine', 'category', 'keywords', 'diet', 'notes'];

export function stripRecipe(recipe) {
  const out = {};
  for (const f of RECIPE_FIELDS) if (recipe[f] !== undefined) out[f] = recipe[f];
  if (typeof out.notes === 'string') out.notes = out.notes.slice(0, 1000);
  const cook = cleanCook(recipe.cook);
  if (cook) out.cook = cook;
  return out;
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Cook steps: {v, prep: [text], steps: [{text, timerMinutes, timerLabel}], warnings, model, generatedAt}.
// Returns null (dropped) unless it has at least one step.
export function cleanCook(cook) {
  if (!cook || typeof cook !== 'object' || !Array.isArray(cook.steps)) return null;
  const steps = cook.steps.slice(0, 80).map((s) => {
    const text = str(s?.text, 600);
    if (!text) return null;
    const minutes = Number(s.timerMinutes);
    const timed = Number.isFinite(minutes) && minutes > 0 && minutes <= 2880;
    return { text, timerMinutes: timed ? Math.round(minutes * 10) / 10 : null, timerLabel: timed ? str(s.timerLabel, 40) : null };
  }).filter(Boolean);
  if (!steps.length) return null;
  const list = (v, n, max) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);
  return {
    v: Number.isInteger(cook.v) ? cook.v : 1,
    prep: list(cook.prep, 30, 400),
    steps,
    warnings: list(cook.warnings, 5, 300),
    model: str(cook.model, 60),
    generatedAt: str(cook.generatedAt, 40),
  };
}

// ---- prefs ----

const PREF_FIELDS = {
  store: (v) => v === null || (typeof v === 'object' && typeof v.locationId === 'string'),
  pantry: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  leaveOut: (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
  modality: (v) => v === 'PICKUP' || v === 'DELIVERY',
  minRating: (v) => typeof v === 'number' && v >= 0 && v <= 5,
  maxMinutes: (v) => v === null || (Number.isInteger(v) && v > 0 && v <= 600),
  servings: (v) => Number.isInteger(v) && v >= 1 && v <= 40,
  easy: (v) => typeof v === 'boolean',
  // Today's Gemini-written "What sounds good?" ideas, shared by both devices.
  dailyIdeas: (v) => typeof v === 'object' && v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v.date)
    && Array.isArray(v.ideas) && v.ideas.length <= 50 && v.ideas.every((s) => typeof s === 'string' && s.length <= 80),
};

export async function prefsGet(env) {
  return (await getJson(env, 'prefs')) || {};
}

export async function prefsUpdate(env, patch) {
  const current = await prefsGet(env);
  for (const [key, value] of Object.entries(patch || {})) {
    const valid = PREF_FIELDS[key];
    if (!valid) throw new HttpError(400, 'bad_pref', `Unknown preference "${key}".`);
    if (!valid(value)) throw new HttpError(400, 'bad_pref', `Invalid value for "${key}".`);
    current[key] = Array.isArray(value) ? value.map((s) => s.trim()).filter(Boolean).slice(0, 300) : value;
  }
  current.updatedAt = new Date().toISOString();
  await putJson(env, 'prefs', current);
  return current;
}
