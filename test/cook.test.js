import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cookText, formatNumber, generateCook, missingTemperatures, parseNumber, scaleAmount, splitAmounts } from '../web/js/cook.js';

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
