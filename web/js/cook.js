// Cook mode: easy step-by-step instructions written by Gemini from a
// recipe's original method. Ingredient amounts in the steps are marked
// {{like this}} at the recipe's own yield, so the app can scale them to any
// number of servings without asking Gemini again.
import { S } from './gemini.js';

export const COOK_VERSION = 1;

const SYSTEM = `You rewrite a recipe's original method as clear, easy steps for someone cooking from a phone.
Rules:
- Use only what the original steps and ingredient list say. Never add ingredients, temperatures, times, tools or techniques that aren't there, and don't drop any.
- Keep every temperature, time and amount exactly as the original gives it: same numbers, same units, no conversions.
- One action per step, in the original order. Short, plain sentences that start with a verb. Split long steps; don't merge separate actions.
- Wrap each ingredient amount in double braces, as the original gives it for the original yield, for example "Whisk in {{2 cups}} chicken broth" or "Add {{1 (15 oz) can}} black beans". Put the unit inside the braces. Only ingredient amounts: never temperatures, times or pan sizes.
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
  const out = await gemini.json(prompt, SCHEMA, { system: SYSTEM, temperature: 0.1 });
  const steps = (out.steps || [])
    .map((s) => ({
      text: String(s.text || '').trim(),
      timerMinutes: Number(s.timerMinutes) > 0 ? Math.round(Number(s.timerMinutes) * 10) / 10 : null,
      timerLabel: Number(s.timerMinutes) > 0 ? String(s.timerLabel || '').trim().slice(0, 40) || 'Timer' : null,
    }))
    .filter((s) => s.text);
  if (!steps.length) throw new Error('Gemini did not return any steps.');
  const cook = {
    v: COOK_VERSION,
    prep: (out.prep || []).map((p) => String(p).trim()).filter(Boolean),
    steps,
    warnings: [],
    model: gemini.model || null,
    generatedAt: now.toISOString(),
  };
  const missing = missingTemperatures(instructions, cook);
  if (missing.length) {
    cook.warnings.push(`The original mentions ${missing.join(', ')}, which isn't in these steps. Check the original before cooking.`);
  }
  return cook;
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
