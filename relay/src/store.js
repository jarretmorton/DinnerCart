// Workers KV helpers. One namespace (binding: DC_KV) holds everything,
// separated by key prefix:
//   kroger:user        Fred Meyer account tokens (shared household cart)
//   kroger:app         client-credentials token for product search
//   oauth:state:<s>    pending OAuth logins (10 minute TTL)
//   brave:<hash>       cached search results (7 days)
//   recipe:<hash>      cached parsed recipes (30 days), or a "none" marker
//   library            saved recipe library (one JSON array)
//   prefs              shared household preferences (store, pantry, rating floor, ...)
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

export async function libraryList(env) {
  return (await getJson(env, LIBRARY_KEY)) || [];
}

export async function librarySave(env, recipe) {
  if (!/^https?:\/\//i.test(recipe?.url || '') || !Array.isArray(recipe.ingredients)) {
    throw new HttpError(400, 'bad_recipe', 'Recipe needs an http(s) url and ingredients.');
  }
  const id = (await sha256Hex(recipe.url)).slice(0, 16);
  const list = (await libraryList(env)).filter((r) => r.id !== id);
  const entry = { ...stripRecipe(recipe), id, savedAt: new Date().toISOString() };
  list.unshift(entry);
  await putJson(env, LIBRARY_KEY, list.slice(0, LIBRARY_MAX));
  return entry;
}

export async function libraryDelete(env, id) {
  const list = await libraryList(env);
  const next = list.filter((r) => r.id !== id);
  if (next.length !== list.length) await putJson(env, LIBRARY_KEY, next);
  return list.length - next.length;
}

// Only keep the fields the app uses; never instructions.
const RECIPE_FIELDS = ['url', 'name', 'description', 'image', 'author', 'site', 'ingredients', 'totalMinutes', 'prepMinutes', 'cookMinutes', 'servings', 'yieldText', 'rating', 'nutrition', 'cuisine', 'category', 'keywords', 'diet', 'notes'];

export function stripRecipe(recipe) {
  const out = {};
  for (const f of RECIPE_FIELDS) if (recipe[f] !== undefined) out[f] = recipe[f];
  if (typeof out.notes === 'string') out.notes = out.notes.slice(0, 1000);
  return out;
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
