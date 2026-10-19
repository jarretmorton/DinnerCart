import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookText, formatNumber, generateCook, missingIngredients, missingTemperatures, parseNumber, scaleAmount, splitAmounts } from '../web/js/cook.js';

test('parseNumber and formatNumber handle fractions', () => {
  assert.equal(parseNumber('1 1/2'), 1.5);
  assert.equal(parseNumber('1½'), 1.5);
  assert.equal(parseNumber('3/4'), 0.75);
  assert.equal(parseNumber('⅓'), 1 / 3);
  assert.equal(parseNumber('.5'), 0.5);
  assert.equal(formatNumber(1.5), '1½');
  assert.equal(formatNumber(0.25), '¼');
  assert.equal(formatNumber(2 / 3), '⅔');
  assert.equal(formatNumber(3), '3');
  assert.equal(formatNumber(2.98), '3');
  assert.equal(formatNumber(2.43), '2.4');
  assert.equal(formatNumber(22.4), '22');
});

test('scaleAmount scales the leading amount and fixes the unit', () => {
  assert.equal(scaleAmount('2 cups', 1.5), '3 cups');
  assert.equal(scaleAmount('1 cup', 2), '2 cups');
  assert.equal(scaleAmount('2 cups', 0.5), '1 cup');
  assert.equal(scaleAmount('1 1/2 tablespoons', 2), '3 tablespoons');
  assert.equal(scaleAmount('2-3 cloves', 2), '4-6 cloves');
  assert.equal(scaleAmount('1 (15 oz) can', 2), '2 (15 oz) cans');
  assert.equal(scaleAmount('½ tsp', 0.5), '¼ tsp');
  assert.equal(scaleAmount('1 lb chicken thighs', 1.5), '1½ lb chicken thighs');
  assert.equal(scaleAmount('a pinch', 2), 'a pinch', 'no number: unchanged');
  assert.equal(scaleAmount('2 cups', 1), '2 cups');
});

test('splitAmounts and cookText', () => {
  assert.deepEqual(splitAmounts('Whisk in {{2 cups}} broth.'), [{ text: 'Whisk in ' }, { amount: '2 cups' }, { text: ' broth.' }]);
  assert.equal(cookText('Add {{1 cup}} rice and {{2 cups}} water.', 2), 'Add 2 cups rice and 4 cups water.');
  assert.equal(cookText('Bake at 400°F for 20 minutes.', 2), 'Bake at 400°F for 20 minutes.', 'temps and times never scale');
});

test('missingTemperatures flags temperatures the rewrite dropped', () => {
  const cook = { prep: ['Preheat the oven to 425°F.'], steps: [{ text: 'Bake 20 minutes.' }] };
  assert.deepEqual(missingTemperatures(['Preheat oven to 425 degrees F.', 'Bake 20 minutes.'], cook), []);
  assert.deepEqual(missingTemperatures(['Preheat to 425°F.', 'Fry in oil heated to 350°.'], cook), ['350°']);
});

test('generateCook: prompt carries the original steps; output is cleaned and checked', async () => {
  let seen;
  const gemini = {
    model: 'gemini-flash-latest',
    json: async (prompt, schema, opts) => {
      seen = { prompt, opts };
      return {
        prep: ['Preheat the oven to 400°F.', ' '],
        steps: [
          { text: 'Toss {{1 lb}} potatoes with {{2 tbsp}} oil.', timerMinutes: null, timerLabel: null },
          { text: 'Roast until golden, 25 to 30 minutes.', timerMinutes: 25, timerLabel: 'Roast potatoes' },
          { text: '', timerMinutes: null, timerLabel: null },
        ],
      };
    },
  };
  const recipe = { name: 'Roast potatoes', servings: 4, ingredients: ['1 lb potatoes', '2 tbsp olive oil'] };
  const cook = await generateCook(gemini, recipe, ['Heat oven to 400°F.', 'Toss potatoes with oil; roast 25-30 minutes.', 'Finish under a 500° broiler.'], { now: new Date('2026-10-19T12:00:00Z') });
  assert.match(seen.prompt, /Original steps:\n1\. Heat oven to 400°F\./);
  assert.match(seen.prompt, /Yield: 4 servings/);
  assert.equal(seen.opts.temperature, 0.1);
  assert.equal(cook.steps.length, 2, 'empty step dropped');
  assert.deepEqual(cook.prep, ['Preheat the oven to 400°F.']);
  assert.deepEqual(cook.steps[1], { text: 'Roast until golden, 25 to 30 minutes.', timerMinutes: 25, timerLabel: 'Roast potatoes' });
  assert.equal(cook.steps[0].timerLabel, null);
  assert.match(cook.warnings[0], /500°/);
  assert.equal(cook.model, 'gemini-flash-latest');
  assert.equal(cook.generatedAt, '2026-10-19T12:00:00.000Z');
  await assert.rejects(generateCook(gemini, recipe, []), /no steps/);
});

test('missingIngredients: names, plurals, descriptors, shared words, and/or', () => {
  const ingredients = [
    '1 1/2 lb boneless skinless chicken thighs, trimmed', '2 cups broccoli florets', '2 tbsp extra-virgin olive oil',
    '1 tbsp toasted sesame oil', 'Salt and pepper, to taste', '1 (15 oz) can black beans, drained and rinsed',
    'Juice of 1 lemon', '2 green onions, sliced', 'For the sauce:', '1/4 cup butter or margarine', '2 tomatoes', '1 cup all-purpose flour',
  ];
  const cook = { prep: ['Preheat the oven.'], steps: [
    { text: 'Toss {{1 1/2 lb}} chicken and the broccoli with {{2 tbsp}} olive oil, salt and pepper.' },
    { text: 'Add the beans and the lemon juice.' },
    { text: 'Melt {{1/4 cup}} margarine; stir in the tomato and flour.' },
  ] };
  assert.deepEqual(missingIngredients(ingredients, cook), ['1 tbsp toasted sesame oil', '2 green onions, sliced']);
  cook.steps.push({ text: 'Drizzle with sesame oil and top with green onions.' });
  assert.deepEqual(missingIngredients(ingredients, cook), []);
  assert.deepEqual(missingIngredients(['Salt and pepper'], { prep: [], steps: [{ text: 'Season with salt.' }] }), ['Salt and pepper'], 'both parts needed');
});

test('generateCook asks once more when an ingredient is missing', async () => {
  const prompts = [];
  const drafts = [
    { prep: [], steps: [{ text: 'Cook {{8 oz}} pasta.', timerMinutes: 10, timerLabel: 'Pasta' }, { text: 'Toss with the sauce.', timerMinutes: null, timerLabel: null }] },
    { prep: [], steps: [{ text: 'Cook {{8 oz}} pasta.', timerMinutes: 10, timerLabel: 'Pasta' }, { text: 'Toss with {{1 cup}} pesto and {{1/4 cup}} parmesan.', timerMinutes: null, timerLabel: null }] },
  ];
  const gemini = { model: 'm', json: async (prompt) => { prompts.push(prompt); return drafts[prompts.length - 1]; } };
  const recipe = { name: 'Pesto pasta', servings: 2, ingredients: ['8 oz pasta', '1 cup pesto', '1/4 cup grated parmesan'] };
  const cook = await generateCook(gemini, recipe, ['Cook pasta 10 minutes.', 'Toss with pesto and parmesan.']);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /aren't named in the draft:\n- 1 cup pesto\n- 1\/4 cup grated parmesan/);
  assert.match(prompts[1], /Your draft:[\s\S]*1\. Cook \{\{8 oz\}\} pasta\. \[timer: 10 min, Pasta\]/);
  assert.equal(cook.steps[1].text, 'Toss with {{1 cup}} pesto and {{1/4 cup}} parmesan.');
  assert.equal(cook.v, 2);

  // A revision that isn't better is ignored; nothing complete needs a second call.
  prompts.length = 0;
  drafts[1] = { prep: [], steps: [{ text: 'Serve.' }] };
  const kept = await generateCook(gemini, recipe, ['Cook pasta.', 'Toss.']);
  assert.equal(kept.steps[0].text, 'Cook {{8 oz}} pasta.');
});
