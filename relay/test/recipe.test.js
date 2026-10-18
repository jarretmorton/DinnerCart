import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, extractJsonLdBlocks, extractRecipe, parseDurationMinutes } from '../src/recipe.js';

const page = (ld) => `<html><head><title>x</title>
<script type="application/ld+json">${typeof ld === 'string' ? ld : JSON.stringify(ld)}</script>
</head><body>hi</body></html>`;

test('parses ISO and loose durations', () => {
  assert.equal(parseDurationMinutes('PT1H30M'), 90);
  assert.equal(parseDurationMinutes('P0DT0H45M'), 45);
  assert.equal(parseDurationMinutes('PT2700S'), 45);
  assert.equal(parseDurationMinutes('45 minutes'), 45);
  assert.equal(parseDurationMinutes('1 hr 10 mins'), 70);
  assert.equal(parseDurationMinutes('PT0S'), null);
  assert.equal(parseDurationMinutes(''), null);
});

test('decodes entities and strips tags', () => {
  assert.equal(cleanText('1 &frac12; cups <b>flour</b>&nbsp;&amp; salt'), '1 ½ cups flour & salt');
  assert.equal(cleanText('Jalape&#241;o &#x2013; diced'), 'Jalapeño – diced');
});

test('extracts a Recipe nested in @graph with typed arrays', () => {
  const html = page({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'page' },
      {
        '@type': ['Recipe', 'NewsArticle'],
        name: 'Weeknight Chili',
        image: [{ '@type': 'ImageObject', url: 'https://img.example/chili.jpg' }],
        author: [{ '@type': 'Person', name: 'Sam' }],
        recipeYield: ['6', '6 servings'],
        prepTime: 'PT15M',
        cookTime: 'PT30M',
        recipeIngredient: ['1 lb ground beef', '1 (15 oz) can kidney beans', '2 tbsp chili powder'],
        recipeInstructions: [{ '@type': 'HowToStep', text: 'Cook it.' }],
        aggregateRating: { ratingValue: '4.7', ratingCount: '1,234' },
        nutrition: { calories: '420 kcal', proteinContent: '30 g' },
        recipeCuisine: 'Tex-Mex',
        keywords: 'chili, beef, easy',
        suitableForDiet: 'https://schema.org/GlutenFreeDiet',
      },
    ],
  });
  const r = extractRecipe(html, 'https://www.example.com/chili');
  assert.equal(r.name, 'Weeknight Chili');
  assert.equal(r.site, 'example.com');
  assert.equal(r.image, 'https://img.example/chili.jpg');
  assert.equal(r.author, 'Sam');
  assert.equal(r.servings, 6);
  assert.equal(r.totalMinutes, 45);
  assert.deepEqual(r.ingredients.length, 3);
  assert.equal(r.rating.value, 4.7);
  assert.equal(r.rating.count, 1234);
  assert.equal(r.nutrition.caloriesNumber, 420);
  assert.deepEqual(r.cuisine, ['Tex-Mex']);
  assert.deepEqual(r.keywords, ['chili', 'beef', 'easy']);
  assert.deepEqual(r.diet, ['GlutenFree']);
  assert.equal('recipeInstructions' in r, false);
});

test('tolerates sloppy JSON and comment wrappers', () => {
  const sloppy = `<!--{"@type":"Recipe","name":"Soup","recipeIngredient":["1 cup
broth","salt",],}-->`;
  const r = extractRecipe(page(sloppy), 'https://soup.example/a');
  assert.equal(r.name, 'Soup');
  assert.deepEqual(r.ingredients, ['1 cup broth', 'salt']);
});

test('returns null when there is no recipe markup', () => {
  assert.equal(extractRecipe('<html><body>No recipe</body></html>', 'https://x.example'), null);
  assert.equal(extractRecipe(page({ '@type': 'Article', name: 'News' }), 'https://x.example'), null);
  assert.equal(extractRecipe(page({ '@type': 'Recipe', name: 'Empty', recipeIngredient: [] }), 'https://x.example'), null);
});

test('picks the recipe with the most ingredients and normalizes 10-point ratings', () => {
  const html = page([
    { '@type': 'Recipe', name: 'Sauce', recipeIngredient: ['a'] },
    { '@type': 'http://schema.org/Recipe', name: 'Main', recipeIngredient: ['a', 'b', 'c'], aggregateRating: { ratingValue: 9, bestRating: 10, reviewCount: 12 } },
  ]);
  const r = extractRecipe(html, 'https://x.example/r');
  assert.equal(r.name, 'Main');
  assert.equal(r.rating.value, 4.5);
  assert.equal(r.rating.count, 12);
});

test('handles multiple ld+json blocks, ignoring unparseable ones', () => {
  const html = `<script type="application/ld+json">{bad json</script>
  <script type='application/ld+json' class="yoast">{"@type":"Recipe","name":"Tacos","recipeIngredient":["tortillas"]}</script>`;
  assert.equal(extractJsonLdBlocks(html).length, 1);
  assert.equal(extractRecipe(html, 'https://t.example').name, 'Tacos');
});
