// Cook mode: easy step-by-step instructions written by Gemini from a
// recipe's original method. Ingredient amounts in the steps are marked
// {{like this}} at the recipe's own yield, so the app can scale them to any
// number of servings without asking Gemini again.
import { S } from './gemini.js';

export const COOK_VERSION = 2;

const SYSTEM = `You rewrite a recipe's original method as clear, easy steps for someone cooking from a phone.
Rules:
- Use only what the original steps and ingredient list say. Never add ingredients, temperatures, times, tools or techniques that aren't there, and don't drop any.
- Keep every temperature, time and amount exactly as the original gives it: same numbers, same units, no conversions.
- One action per step, in the original order. Short, plain sentences that start with a verb. Split long steps; don't merge separate actions.
- Wrap each ingredient amount in double braces, as the original gives it for the original yield, for example "Whisk in {{2 cups}} chicken broth" or "Add {{1 (15 oz) can}} black beans". Put the unit inside the braces. Only ingredient amounts: never temperatures, times or pan sizes.
- Name every ingredient from the list in the prep or steps where the original uses it, the first time with its amount in braces. When the original says "add the remaining ingredients", "the spices" or similar, name each one.
- If a step uses all of an ingredient at once but doesn't say how much, add the amount from the ingredient list in braces.
- prep: what to do before starting, taken from the original: preheating, preparing pans, and simple chopping or measuring the steps rely on. Keep those out of the steps, unless the original does them partway through.
- timerMinutes: when a step involves waiting (bake, simmer, roast, rest, chill, marinate, rise), the time in minutes; for a range, the lower end. timerLabel: 1-3 words for that timer, like "Simmer sauce". Otherwise both null.`;

const SCHEMA = S.obj({
  prep: S.arr(S.str()),
  steps: S.arr(S.obj({
    text: S.str(),
    timerMinutes: S.nullable(S.num('Minutes to wait in this step, or null')),
    timerLabel: S.nullable(S.str('1-3 words, or null')),
  })),
});

// instructions: the original steps (text lines) from the recipe page.
export async function generateCook(gemini, recipe, instructions, { now = new Date() } = {}) {
  if (!instructions?.length) throw new Error('This recipe page has no steps to work from.');
  const yieldText = recipe.yieldText || (recipe.servings ? `${recipe.servings} servings` : 'not stated');
  const prompt = `Recipe: ${recipe.name}\nYield: ${yieldText}\n\nIngredients:\n${recipe.ingredients.map((i) => `- ${i}`).join('\n')}\n\nOriginal steps:\n${instructions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
  // Longer answers than the other prompts, so more time before giving up.
  let cook = toCook(await gemini.json(prompt, SCHEMA, { system: SYSTEM, temperature: 0.1, timeoutMs: 60_000, startTimeoutMs: null }));
  if (!cook) throw new Error('Gemini did not return any steps.');

  // Gemini sometimes drops an ingredient. Point out which and ask once for a
  // revision; anything still missing is flagged on the Cook screen.
  const left = missingIngredients(recipe.ingredients, cook);
  if (left.length) {
    const draft = `Before you start:\n${cook.prep.map((p) => `- ${p}`).join('\n') || '- (nothing)'}\n\nSteps:\n${cook.steps.map((st, i) => `${i + 1}. ${st.text}${st.timerMinutes ? ` [timer: ${st.timerMinutes} min, ${st.timerLabel}]` : ''}`).join('\n')}`;
    const fix = `${prompt}\n\nYour draft:\n${draft}\n\nThese ingredients from the list aren't named in the draft:\n${left.map((i) => `- ${i}`).join('\n')}\n\nRewrite the draft so each of them is named where the original uses it, the first time with its amount in braces. Keep everything else, and follow the same rules. If the original never uses one of them, leave it out.`;
    try {
      const revised = toCook(await gemini.json(fix, SCHEMA, { system: SYSTEM, temperature: 0.1, timeoutMs: 60_000, startTimeoutMs: null }));
      if (revised && missingIngredients(recipe.ingredients, revised).length < left.length) cook = revised;
    } catch { /* keep the first draft; the Cook screen flags what's missing */ }
  }

  Object.assign(cook, { v: COOK_VERSION, warnings: [], model: gemini.model || null, generatedAt: now.toISOString() });
  const missing = missingTemperatures(instructions, cook);
  if (missing.length) {
    cook.warnings.push(`The original mentions ${missing.join(', ')}, which isn't in these steps. Check the original before cooking.`);
  }
  return cook;
}

function toCook(out) {
  const steps = (out?.steps || [])
    .map((s) => ({
      text: String(s.text || '').trim(),
      timerMinutes: Number(s.timerMinutes) > 0 ? Math.round(Number(s.timerMinutes) * 10) / 10 : null,
      timerLabel: Number(s.timerMinutes) > 0 ? String(s.timerLabel || '').trim().slice(0, 40) || 'Timer' : null,
    }))
    .filter((s) => s.text);
  if (!steps.length) return null;
  return { prep: (out.prep || []).map((p) => String(p).trim()).filter(Boolean), steps };
}

// ---- ingredient check

// Words that describe an ingredient rather than name it ("2 large fresh
// boneless chicken thighs, diced" is "chicken thighs").
const IGNORE = new Set(`cup cups tbsp tbs tablespoon tablespoons tsp teaspoon teaspoons pound pounds lbs ounce ounces fl gram grams kg ml liter liters litre quart quarts pint pints gallon
  can cans jar jars package packages pkg bag bags box boxes bottle bottles container stick sticks slice slices piece pieces clove cloves head heads bunch bunches sprig sprigs stalk stalks
  pinch pinches dash dashes handful handfuls inch inches large small medium whole half
  and the for with into about plus more few some each other such like taste needed optional divided garnish serving servings room temperature
  fresh freshly chopped diced minced sliced grated shredded ground crushed dried peeled seeded cored halved quartered trimmed rinsed drained packed sifted
  finely roughly coarsely thinly thick thin extra virgin boneless skinless kosher unsalted salted low sodium reduced fat lean cooked uncooked raw frozen thawed
  softened melted cold warm hot hard soft ripe good quality store bought homemade plain organic all purpose`.split(/\s+/));

const stem = (w) => {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(?:ches|shes|xes|oes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
};
const wordsOf = (text) => text.toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter((w) => w.length >= 3).map(stem);

// "Salt and pepper, to taste" -> [[[salt]], [[pepper]]]: every part must be named;
// "butter or margarine" -> [[[butter], [margarine]]]: any alternative will do.
function namesOf(line) {
  const core = line.toLowerCase().replace(/\([^)]*\)/g, ' ').split(/,|;|\s[-–—]\s/)[0];
  return core.split(/\band\b|&/)
    .map((part) => part.split(/\bor\b|\//).map((alt) => wordsOf(alt).filter((w) => !IGNORE.has(w))).filter((alt) => alt.length))
    .filter((alts) => alts.length);
}

// Ingredient lines the prep and steps never name. A name counts when a word
// only that ingredient has appears ("broccoli" for broccoli florets, "sesame"
// for sesame oil next to olive oil); if all its words are shared with other
// ingredients, all of them must appear.
export function missingIngredients(ingredients = [], cook) {
  const said = new Set(wordsOf([...cook.prep, ...cook.steps.map((s) => s.text)].join(' ')));
  const lines = ingredients.filter((line) => !/:\s*$/.test(line)).map((line) => ({ line, parts: namesOf(line) }));
  const usedBy = new Map(); // word -> how many ingredient lines have it
  for (const { parts } of lines) for (const w of new Set(parts.flat(2))) usedBy.set(w, (usedBy.get(w) || 0) + 1);
  const named = (alt) => {
    const own = alt.filter((w) => usedBy.get(w) === 1);
    return own.length ? own.some((w) => said.has(w)) : alt.every((w) => said.has(w));
  };
  return lines.filter(({ parts }) => parts.length && !parts.every((alts) => alts.some(named))).map(({ line }) => line);
}

// Oven and oil temperatures in the original that the rewrite left out.
export function missingTemperatures(instructions, cook) {
  const source = instructions.join(' ');
  const written = [...cook.prep, ...cook.steps.map((s) => s.text)].join(' ');
  const found = [...source.matchAll(/(\d{2,3})\s*(?:°|º|degrees?\b)\s*([FC]\b)?/gi)].map((m) => [m[1], m[2]?.toUpperCase() || '']);
  const missing = new Map();
  for (const [n, unit] of found) {
    if (!new RegExp(`(^|\\D)${n}(\\D|$)`).test(written)) missing.set(n, `${n}°${unit}`);
  }
  return [...missing.values()];
}

// ---- amounts

const VULGAR = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875 };
const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\s*[¼½¾⅓⅔⅛⅜⅝⅞]|\d+\/\d+|[¼½¾⅓⅔⅛⅜⅝⅞]|\d+(?:\.\d+)?|\.\d+)`;
const LEADING = new RegExp(String.raw`^(\s*)(${NUM})(?:(\s*(?:-|–|to)\s*)(${NUM}))?`);

export function parseNumber(text) {
  const s = text.trim();
  let m = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return +m[1] + m[2] / m[3];
  m = s.match(/^(\d+)\s*([¼½¾⅓⅔⅛⅜⅝⅞])$/);
  if (m) return +m[1] + VULGAR[m[2]];
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return m[2] > 0 ? m[1] / m[2] : null;
  if (VULGAR[s] != null) return VULGAR[s];
  return Number.isFinite(Number(s)) ? Number(s) : null;
}

const FRACTIONS = [[1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞']];

// 1.5 -> "1½", 0.333 -> "⅓", 2.0 -> "2", 2.43 -> "2.4".
export function formatNumber(n) {
  if (n >= 20) return String(Math.round(n));
  let whole = Math.floor(n);
  let frac = n - whole;
  if (frac < 0.04) return String(whole);
  if (frac > 0.96) return String(whole + 1);
  const [value, glyph] = FRACTIONS.reduce((best, f) => (Math.abs(f[0] - frac) < Math.abs(best[0] - frac) ? f : best));
  if (Math.abs(value - frac) <= 0.04) return `${whole || ''}${glyph}`;
  return String(Math.round(n * 10) / 10);
}

const UNIT_PLURALS = {
  cup: 'cups', tablespoon: 'tablespoons', teaspoon: 'teaspoons', pound: 'pounds', ounce: 'ounces', clove: 'cloves',
  can: 'cans', pinch: 'pinches', dash: 'dashes', stick: 'sticks', slice: 'slices', bunch: 'bunches', head: 'heads',
  sprig: 'sprigs', quart: 'quarts', pint: 'pints', gallon: 'gallons', package: 'packages', jar: 'jars', bag: 'bags',
  box: 'boxes', stalk: 'stalks', piece: 'pieces', fillet: 'fillets', breast: 'breasts', thigh: 'thighs', handful: 'handfuls',
  liter: 'liters', litre: 'litres', gram: 'grams', kilogram: 'kilograms', bottle: 'bottles', container: 'containers', sheet: 'sheets',
};
const UNIT_SINGULARS = Object.fromEntries(Object.entries(UNIT_PLURALS).map(([s, p]) => [p, s]));

// Match the unit word (after an optional "(15 oz)") to the new amount.
function fixUnit(rest, value) {
  return rest.replace(/^(\s*(?:\([^)]*\)\s*)?)([A-Za-z]+)\b/, (all, lead, word) => {
    const lower = word.toLowerCase();
    const next = value > 1 ? UNIT_PLURALS[lower] : UNIT_SINGULARS[lower];
    if (!next) return all;
    return lead + (word[0] === word[0].toUpperCase() ? next[0].toUpperCase() + next.slice(1) : next);
  });
}

// Scale the amount at the start of `text` ("1 1/2 cups", "2-3 cloves",
// "1 (15 oz) can"). Text without a leading number is returned as is.
export function scaleAmount(text, factor) {
  if (!factor || Math.abs(factor - 1) < 0.001) return text;
  const m = text.match(LEADING);
  if (!m) return text;
  const a = parseNumber(m[2]);
  const b = m[4] != null ? parseNumber(m[4]) : null;
  if (a == null || (m[4] != null && b == null)) return text;
  const first = formatNumber(a * factor);
  const range = b != null ? `${m[3]}${formatNumber(b * factor)}` : '';
  return `${m[1]}${first}${range}${fixUnit(text.slice(m[0].length), (b ?? a) * factor)}`;
}

// "Whisk in {{2 cups}} broth" -> [{text: 'Whisk in '}, {amount: '2 cups'}, {text: ' broth'}]
export function splitAmounts(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ amount: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

// Plain text with amounts scaled and the braces removed (timer labels, sharing).
export function cookText(text, factor = 1) {
  return splitAmounts(text).map((p) => (p.amount != null ? scaleAmount(p.amount, factor) : p.text)).join('');
}
