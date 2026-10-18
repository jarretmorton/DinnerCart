// Rotating placeholder suggestions for the Find form.
import { S } from './gemini.js';
import { describeTaste } from './recipes.js';

// Built-in ideas for "What sounds good?": shown until today's Gemini batch
// arrives, or if Gemini is unavailable.
export const IDEAS = [
  'cozy one-pan chicken thighs',
  'sheet-pan salmon with lemon and veggies',
  '15-minute garlic butter shrimp',
  'crispy chickpea grain bowls',
  'lazy lasagna soup',
  'Thai peanut noodles',
  'taco night with a twist',
  'creamy Tuscan gnocchi',
  'honey garlic pork chops',
  'veggie-packed fried rice',
  'Greek chicken pita bowls',
  'white chicken chili',
  'teriyaki salmon rice bowls',
  'Korean beef bulgogi bowls',
  'pesto pasta with burst tomatoes',
  'breakfast for dinner',
  'BBQ chicken flatbread pizza',
  'coconut curry with whatever veggies',
  'lemony orzo with spinach and feta',
  'smash burgers and crispy potatoes',
  'black bean sweet potato tacos',
  'miso-glazed salmon',
  'chicken shawarma sheet pan',
  'cheesy baked ziti',
  'turkey meatball subs',
  'one-pot chili mac',
  'something cozy for a rainy night',
  'a fun weekend cooking project',
  'big salad that actually fills you up',
  'street-corn chicken bowls',
];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Ask Gemini for a fresh batch of ideas, shaped by the season and the
// household's saved recipes. Returns null if the answer isn't usable.
export async function generateIdeas(gemini, { liked = [], now = new Date() } = {}) {
  const taste = liked.length
    ? `Recipes they've saved (their taste; suggest new things in this spirit, not these dishes):\n${describeTaste(liked)}`
    : 'They haven\'t saved any recipes yet; aim for broad appeal.';
  const out = await gemini.json(
    `Suggest 25 dinner ideas for a couple to type into a recipe search box. It's ${MONTHS[now.getMonth()]}.\n${taste}\n\nEach idea: 2-6 words, lowercase except proper nouns, creative but easy for a weeknight (one-pan, sheet-pan, 30-minute, pantry-friendly and so on). Mix cuisines, proteins and vegetarian options, and lean into what's in season. A few can be moods rather than dishes ("something cozy for a rainy night"). No brand names, no numbering.`,
    S.obj({ ideas: S.arr(S.str()) }),
    { temperature: 1 },
  );
  const seen = new Set();
  const ideas = (out.ideas || [])
    .map((s) => String(s).trim().replace(/^(?:\d+[.)]|[-•*])\s+/, '').replace(/[.!]+$/, ''))
    .filter((s) => s.length >= 3 && s.length <= 60 && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
  return ideas.length >= 8 ? ideas : null;
}

// Local calendar day, so the batch refreshes at local midnight.
export const todayKey = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

// Used for "What to leave out" when the household list is empty.
export const LEAVE_OUT_EXAMPLES = ['mushrooms', 'cilantro', 'olives', 'blue cheese', 'shellfish', 'raisins', 'very spicy'];

const shuffle = (list) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// Cycle `input`'s placeholder through getList() every `ms`. Returns
// current() for the suggestion now showing (without the "e.g." prefix).
export function rotatePlaceholder(input, getList, ms = 3500) {
  let order = [];
  let i = 0;
  let current = '';
  const show = () => {
    const list = getList();
    if (!list.length) return;
    if (i >= order.length || order.length !== list.length || !order.every((x) => list.includes(x))) {
      order = shuffle(list);
      i = 0;
    }
    current = order[i++];
    input.placeholder = `e.g. ${current}`;
  };
  show();
  setInterval(() => {
    // Placeholders are hidden once there's text; don't churn needlessly.
    if (!input.value) show();
  }, ms);
  return { current: () => current, refresh: show };
}
