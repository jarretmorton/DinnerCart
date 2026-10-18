// Rotating placeholder suggestions for the Find form.

// Creative but easy weeknight ideas for "What sounds good?".
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
