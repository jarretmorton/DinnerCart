// Extract and normalize schema.org/Recipe JSON-LD from a recipe page.
// Pure functions (no Worker APIs) so they can be unit tested in Node.
//
// The original method (recipeInstructions) comes back as `instructions`, a
// list of plain-text steps. It is only used to write the app's easy Cook
// steps; the shared library never stores it (see store.js).

const LD_SCRIPT_RE = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;

export function extractJsonLdBlocks(html) {
  const blocks = [];
  for (const m of html.matchAll(LD_SCRIPT_RE)) {
    const parsed = parseLooseJson(m[1]);
    if (parsed !== undefined) blocks.push(parsed);
  }
  return blocks;
}

function parseLooseJson(raw) {
  let text = raw.trim()
    .replace(/^<!--/, '').replace(/-->$/, '')
    .replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, '').replace(/\/\*\s*\]\]>\s*\*\/$/, '')
    .trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // Some sites leave raw newlines/tabs inside strings, or trailing commas.
    try {
      text = text.replace(/[\u0000-\u001F]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
}

function isRecipeType(type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((t) => typeof t === 'string' && /(^|[/:])Recipe$/.test(t));
}

export function findRecipeNodes(data, out = [], depth = 0) {
  if (!data || typeof data !== 'object' || depth > 8) return out;
  if (Array.isArray(data)) {
    for (const d of data) findRecipeNodes(d, out, depth + 1);
    return out;
  }
  if (isRecipeType(data['@type'])) out.push(data);
  for (const key of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    if (data[key] && typeof data[key] === 'object') findRecipeNodes(data[key], out, depth + 1);
  }
  return out;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', frac12: '½', frac14: '¼', frac34: '¾', deg: '°', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', eacute: 'é', egrave: 'è', ntilde: 'ñ' };

export function cleanText(value) {
  if (value == null) return '';
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, code) => {
      if (code[0] === '#') {
        const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// "PT1H30M" -> 90, "P0DT0H45M" -> 45, "45 minutes" -> 45.
export function parseDurationMinutes(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value > 0 ? Math.round(value) : null;
  const s = String(value).trim();
  const iso = s.match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (iso && (iso[1] || iso[2] || iso[3] || iso[4])) {
    const [, d = 0, h = 0, m = 0, sec = 0] = iso;
    const total = Math.round(+d * 1440 + +h * 60 + +m + +sec / 60);
    return total > 0 ? total : null;
  }
  let total = 0;
  const hours = s.match(/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i);
  const mins = s.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/i);
  if (hours) total += +hours[1] * 60;
  if (mins) total += +mins[1];
  return total > 0 ? Math.round(total) : null;
}

function firstNumber(value) {
  const m = String(value ?? '').replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textList(v) {
  return asArray(v)
    .flatMap((x) => (typeof x === 'string' ? x.split(',') : [x?.name ?? x]))
    .map(cleanText)
    .filter(Boolean);
}

const MAX_STEPS = 80;

// recipeInstructions comes as a string (maybe HTML or line breaks), a list
// of strings, HowToStep objects, or HowToSections of steps. Flatten to text
// lines; a section's name becomes its own line ("For the sauce:").
export function parseInstructions(value, out = [], depth = 0) {
  if (value == null || depth > 4) return out;
  if (typeof value === 'string') {
    for (const part of value.split(/<\/?(?:li|p|br|ol|ul|div)\b[^>]*>|\n+/i)) {
      const line = cleanText(part).replace(/^(?:step\s*)?\d{1,2}[.):]\s+/i, '');
      if (line) out.push(line);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) parseInstructions(v, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    const steps = value.itemListElement ?? value.steps;
    if (steps) {
      const name = cleanText(value.name);
      if (name) out.push(/[:.]$/.test(name) ? name : `${name}:`);
      return parseInstructions(steps, out, depth + 1);
    }
    const text = cleanText(value.text) || cleanText(value.name) || cleanText(value.description);
    if (text) parseInstructions(text, out, depth + 1);
  }
  return out;
}

function pickImage(image) {
  for (const img of asArray(image)) {
    if (typeof img === 'string' && img) return img;
    if (img && typeof img === 'object') {
      const url = img.url || img.contentUrl || img['@id'];
      if (typeof url === 'string' && /^https?:/.test(url)) return url;
    }
  }
  return null;
}

function pickAuthor(author) {
  const names = asArray(author).map((a) => cleanText(typeof a === 'string' ? a : a?.name)).filter(Boolean);
  return names.length ? names.join(', ') : null;
}

function parseServings(recipeYield) {
  for (const y of asArray(recipeYield)) {
    const n = firstNumber(y);
    if (n && n > 0 && n < 200) return n;
  }
  return null;
}

function parseRating(rating) {
  if (!rating || typeof rating !== 'object') return null;
  const value = firstNumber(rating.ratingValue);
  if (value == null) return null;
  const best = firstNumber(rating.bestRating) || 5;
  const count = firstNumber(rating.ratingCount) ?? firstNumber(rating.reviewCount);
  // Normalize everything to a 5-point scale.
  return { value: Math.round((value / best) * 5 * 100) / 100, count: count ?? null };
}

function parseNutrition(n) {
  if (!n || typeof n !== 'object') return null;
  const out = {};
  for (const key of ['calories', 'proteinContent', 'fatContent', 'carbohydrateContent', 'fiberContent', 'sugarContent', 'sodiumContent', 'servingSize']) {
    if (n[key] != null && n[key] !== '') out[key] = cleanText(n[key]);
  }
  if (!Object.keys(out).length) return null;
  out.caloriesNumber = firstNumber(out.calories);
  return out;
}

export function normalizeRecipe(node, url) {
  const ingredients = asArray(node.recipeIngredient ?? node.ingredients)
    .flatMap((x) => (typeof x === 'string' ? [x] : [x?.text ?? x?.name]))
    .map(cleanText)
    .filter(Boolean);
  const prepMinutes = parseDurationMinutes(node.prepTime);
  const cookMinutes = parseDurationMinutes(node.cookTime);
  let totalMinutes = parseDurationMinutes(node.totalTime);
  if (totalMinutes == null && (prepMinutes || cookMinutes)) totalMinutes = (prepMinutes || 0) + (cookMinutes || 0);
  let site = null;
  try { site = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  return {
    url,
    name: cleanText(node.name) || cleanText(node.headline) || 'Untitled recipe',
    description: cleanText(node.description).slice(0, 400) || null,
    image: pickImage(node.image),
    author: pickAuthor(node.author),
    site,
    ingredients,
    instructions: parseInstructions(node.recipeInstructions).map((s) => s.slice(0, 1500)).slice(0, MAX_STEPS),
    totalMinutes,
    prepMinutes,
    cookMinutes,
    servings: parseServings(node.recipeYield),
    yieldText: asArray(node.recipeYield).map(cleanText).filter(Boolean)[0] || null,
    rating: parseRating(node.aggregateRating),
    nutrition: parseNutrition(node.nutrition),
    cuisine: textList(node.recipeCuisine),
    category: textList(node.recipeCategory),
    keywords: textList(node.keywords).slice(0, 20),
    diet: asArray(node.suitableForDiet)
      .map((d) => String(d?.['@id'] ?? d).split('/').pop().replace(/Diet$/, ''))
      .filter(Boolean),
  };
}

// Returns the best Recipe on the page, or null if there is no usable markup.
export function extractRecipe(html, url) {
  const nodes = findRecipeNodes(extractJsonLdBlocks(html));
  const recipes = nodes.map((n) => normalizeRecipe(n, url)).filter((r) => r.ingredients.length > 0);
  if (!recipes.length) return null;
  recipes.sort((a, b) => b.ingredients.length - a.ingredients.length);
  return recipes[0];
}
