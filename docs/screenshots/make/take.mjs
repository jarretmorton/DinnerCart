// Retakes the README screenshots: the real app against sample data, with the
// relay, Kroger and Gemini mocked here. The food pictures and product
// thumbnails in this folder are illustrations standing in for real photos.
//
//   npm run serve                       # the site on http://localhost:8080
//   node docs/screenshots/make/take.mjs # needs Playwright (npm i -g playwright)
//
// Writes search.png, search-night.png, cook.png and pick.png to docs/screenshots/.
// Set APP_URL to use another address; CHROMIUM to use a specific browser binary.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const requireGlobal = createRequire(`${execSync('npm root -g').toString().trim()}/`);
const { chromium } = (() => { try { return createRequire(import.meta.url)('playwright'); } catch { return requireGlobal('playwright'); } })();

const APP = process.env.APP_URL || 'http://localhost:8080/';
const DIR = new URL('.', import.meta.url).pathname;
const OUT = process.argv[2] || new URL('..', import.meta.url).pathname;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
const json = (body) => ({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const RECIPES = {
  'https://weeknightkitchen.com/lemon-chicken-orzo': {
    name: 'One-Pan Lemon Chicken Orzo', site: 'weeknightkitchen.com', image: 'https://img.test/orzo.png', totalMinutes: 35, servings: 4,
    rating: { value: 4.8, count: 1240 }, nutrition: { caloriesNumber: 520 },
    ingredients: ['1 1/2 lb boneless skinless chicken thighs', '2 lemons', '1 1/2 cups orzo', '3 cups low-sodium chicken broth', '4 cloves garlic, minced', '2 cups baby spinach', '1/2 cup grated parmesan', '2 tbsp olive oil', 'Salt and pepper'],
    instructions: ['Season the chicken with salt and pepper.', 'Heat the oil in a large deep skillet over medium-high heat and brown the chicken, about 4 minutes per side. Remove to a plate.', 'Add the garlic and orzo and toast 2 minutes.', 'Add the broth and the juice of the lemons; bring to a simmer.', 'Return the chicken, cover and simmer 12 minutes, until the orzo is tender.', 'Stir in the spinach, parmesan and lemon zest. Season and serve.'],
  },
  'https://sheetpansuppers.com/crispy-chicken-thighs-potatoes': {
    name: 'Crispy Sheet-Pan Chicken Thighs and Potatoes', site: 'sheetpansuppers.com', image: 'https://img.test/sheetpan.png', totalMinutes: 45, servings: 4,
    rating: { value: 4.7, count: 860 }, nutrition: { caloriesNumber: 610 },
    ingredients: ['2 lb bone-in chicken thighs', '1 1/2 lb baby potatoes', '1 lemon, cut into wedges', '2 sprigs fresh rosemary', '3 tbsp olive oil', '1 tsp kosher salt'],
    instructions: ['Heat the oven to 425°F.', 'Toss everything on a sheet pan.', 'Roast 40 minutes.'],
  },
  'https://simplysoups.com/lemony-chicken-rice-soup': {
    name: 'Lemony Chicken and Rice Soup', site: 'simplysoups.com', image: null, totalMinutes: 40, servings: 6,
    rating: { value: 4.6, count: 410 }, ingredients: ['1 lb chicken breast', '1 cup rice', '8 cups chicken broth', '2 lemons', '2 carrots', '2 celery stalks'], instructions: ['Simmer.'],
  },
  'https://dinnerin30.com/garlic-butter-chicken-bites': {
    name: 'Garlic Butter Chicken Bites', site: 'dinnerin30.com', image: null, totalMinutes: 20, servings: 4,
    rating: { value: 4.5, count: 2300 }, ingredients: ['1 1/2 lb chicken breast', '4 tbsp butter', '6 cloves garlic', '1 tbsp parsley'], instructions: ['Sear.'],
  },
};
for (const [url, r] of Object.entries(RECIPES)) Object.assign(r, { url, yieldText: `${r.servings} servings` });
const REASONS = [
  'Cozy and bright, everything cooks in one pan, and it lands right at 35 minutes.',
  'Crispy skin and roasted potatoes on one pan, hands-off for most of the bake.',
  'A comforting, lemony soup that reheats well for lunches.',
  'Fast and garlicky, but more of a quick sauté than cozy.',
];

// Resolver: how each recipe line becomes a shopping entry.
const LINES = {
  'boneless skinless chicken thighs': ['boneless skinless chicken thighs', 1.5, 'lb'],
  lemons: ['lemon', 2, 'count'], 'lemon, cut': ['lemon', 1, 'count'],
  orzo: ['orzo', 1.5, 'cup'], 'chicken broth': ['low-sodium chicken broth', 3, 'cup'],
  garlic: ['garlic', 4, 'clove'], spinach: ['baby spinach', 2, 'cup'], parmesan: ['grated parmesan', 0.5, 'cup'],
  'bone-in': ['bone-in chicken thighs', 2, 'lb'], potatoes: ['baby potatoes', 1.5, 'lb'], rosemary: ['fresh rosemary', 2, 'sprig'],
};
const PANTRY = { 'olive oil': 'olive oil', 'kosher salt': 'salt' };
function normalize(prompt) {
  const items = [];
  for (const m of prompt.matchAll(/^(\d+\.\d+): (.*)$/gm)) {
    const [, line, text] = m;
    const t = text.toLowerCase();
    if (t.startsWith('salt and pepper')) {
      items.push({ line, name: 'salt', searchTerm: 'salt', quantity: null, unit: null, optional: false, skip: false, pantryMatch: 'salt' });
      items.push({ line, name: 'black pepper', searchTerm: 'black pepper', quantity: null, unit: null, optional: false, skip: false, pantryMatch: 'black pepper' });
      continue;
    }
    const pantry = Object.keys(PANTRY).find((k) => t.includes(k));
    if (pantry) { items.push({ line, name: pantry, searchTerm: pantry, quantity: null, unit: null, optional: false, skip: false, pantryMatch: PANTRY[pantry] }); continue; }
    const key = Object.keys(LINES).find((k) => t.includes(k));
    const [name, quantity, unit] = LINES[key];
    items.push({ line, name, searchTerm: name, quantity, unit, optional: false, skip: false, pantryMatch: null });
  }
  return { items };
}

const product = (upc, description, brand, size, price, aisle, image, promo) => ({
  productId: upc, upc, description, brand, aisleLocations: [{ description: aisle }],
  images: image ? [{ perspective: 'front', sizes: [{ size: 'medium', url: `https://img.test/${image}.png` }] }] : [],
  items: [{ size, price: { regular: price, promo: promo || 0 }, inventory: { stockLevel: 'HIGH' } }],
});
const PRODUCTS = {
  'boneless skinless chicken thighs': [product('0001111096801', 'Simple Truth Organic Boneless Skinless Chicken Thighs', 'Simple Truth Organic', '1.5 lb', 9.99, 'Meat', 'chicken'),
    product('0001111096802', 'Kroger Boneless Skinless Chicken Thighs Family Pack', 'Kroger', '3 lb', 10.47, 'Meat', 'chicken')],
  lemon: [product('0000000004053', 'Fresh Lemon', null, '1 each', 0.79, 'Produce', 'lemon'), product('0001111012345', 'Kroger Lemons Bag', 'Kroger', '2 lb', 4.99, 'Produce', 'lemon')],
  orzo: [product('0007680828008', 'Barilla Orzo Pasta', 'Barilla', '16 oz', 2.29, 'Pasta', 'orzo-box')],
  'low-sodium chicken broth': [product('0001111081234', 'Kroger Low Sodium Chicken Broth', 'Kroger', '32 fl oz', 2.19, 'Soups')],
  garlic: [product('0000000004608', 'Fresh Garlic Bulb', null, '1 each', 0.69, 'Produce')],
  'baby spinach': [product('0001111091010', 'Simple Truth Organic Baby Spinach', 'Simple Truth Organic', '5 oz', 3.49, 'Produce')],
  'grated parmesan': [product('0001111050505', 'Kroger Grated Parmesan Cheese', 'Kroger', '8 oz', 3.99, 'Dairy')],
  'bone-in chicken thighs': [product('0001111096900', 'Kroger Bone-In Chicken Thighs Family Pack', 'Kroger', '3 lb', 6.99, 'Meat', 'bonein', 5.49)],
  'baby potatoes': [product('0082000706001', 'The Little Potato Company Creamer Potatoes', 'The Little Potato Company', '1.5 lb', 3.99, 'Produce')],
};
const PICK_REASONS = { 'boneless skinless chicken thighs': 'size matches', 'bone-in chicken thighs': 'cheapest per pound', lemon: 'loose lemons for a small count' };

const COOK = {
  prep: ['Pat {{1 1/2 lb}} chicken thighs dry and season with salt and pepper.', 'Zest and juice {{2}} lemons.', 'Mince {{4 cloves}} garlic.'],
  steps: [
    { text: 'Heat {{2 tbsp}} olive oil in a large deep skillet over medium-high heat.', timerMinutes: null, timerLabel: null },
    { text: 'Brown the chicken thighs, about 4 minutes per side, then move them to a plate.', timerMinutes: 4, timerLabel: 'Brown chicken' },
    { text: 'Add the garlic and {{1 1/2 cups}} orzo; stir until toasty, about 2 minutes.', timerMinutes: 2, timerLabel: 'Toast orzo' },
    { text: 'Pour in {{3 cups}} chicken broth and the lemon juice; bring to a simmer.', timerMinutes: null, timerLabel: null },
    { text: 'Nestle the chicken back in, cover, and simmer until the orzo is tender, about 12 minutes.', timerMinutes: 12, timerLabel: 'Simmer orzo' },
    { text: 'Stir in {{2 cups}} baby spinach, {{1/2 cup}} parmesan and the lemon zest until the spinach wilts.', timerMinutes: null, timerLabel: null },
    { text: 'Season with salt and pepper to taste and serve.', timerMinutes: null, timerLabel: null },
  ],
};

function gemini(body) {
  const prompt = body.contents[0].parts[0].text;
  const system = body.systemInstruction?.parts[0].text || '';
  if (system.startsWith("You rewrite a recipe's original method")) return COOK;
  if (system.startsWith('You turn recipe')) return normalize(prompt);
  if (system.startsWith('You are shopping')) {
    return { picks: [...prompt.matchAll(/### id (\d+)\nneed: ([^—]+) —/g)].map((m) => ({ id: m[1], choice: 0, packages: 1, reason: PICK_REASONS[m[2].trim()] || 'store brand, right size' })) };
  }
  if (prompt.includes('search queries')) return { queries: ['one-pan chicken orzo recipe', 'cozy chicken soup recipe', 'crispy chicken thighs recipe'] };
  if (prompt.includes('Candidate recipes:')) return { ranking: [0, 1, 2, 3].map((index) => ({ index, score: 95 - index * 7, reason: REASONS[index] })) };
  return { ideas: ['honey garlic salmon', 'creamy tuscan chicken', 'sheet-pan fajitas', 'lemon herb orzo'] };
}

function relay(method, path, body) {
  if (path === '/prefs') return { prefs: { store: { locationId: '70100123', name: 'Fred Meyer Hawthorne', address: '3805 SE Hawthorne Blvd, Portland, OR' }, servings: 4, maxMinutes: 45, pantry: ['salt', 'black pepper', 'olive oil'], leaveOut: ['mushrooms'], minRating: 4 } };
  if (path === '/library') return method === 'GET' ? { recipes: [] } : { recipe: body.recipe };
  if (path === '/kroger/status') return { connected: true };
  if (path === '/search') return { results: Object.keys(RECIPES).map((url) => ({ url, title: RECIPES[url].name })) };
  if (path === '/recipe') return { recipe: RECIPES[body.url] };
  return {};
}

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
await page.route('https://relay.test/**', async (route) => {
  const req = route.request();
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  await route.fulfill(json(relay(req.method(), new URL(req.url()).pathname, req.postData() ? JSON.parse(req.postData()) : null)));
});
await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  await route.fulfill(json({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini(JSON.parse(route.request().postData()))) }] } }] }));
});
await page.route('https://api.kroger.com/**', async (route) => {
  const term = new URL(route.request().url()).searchParams.get('filter.term');
  await route.fulfill(json({ data: PRODUCTS[term] || [] }));
});
await page.route('https://img.test/**', (route) => route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'image/png' }, body: readFileSync(`${DIR}${new URL(route.request().url()).pathname.slice(1)}`) }));

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });
const scrollTo = (sel) => page.evaluate((s) => { const el = document.querySelector(s); window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - document.querySelector('header').offsetHeight - 12); }, sel);

await page.goto(APP);
await page.evaluate(() => localStorage.setItem('dinnercart.settings', JSON.stringify({ relayUrl: 'https://relay.test', relayPassword: 'pw', geminiKey: 'key' })));
await page.reload();
await page.waitForTimeout(800);

// Search
await page.fill('[name=wants]', 'something cozy with chicken');
await page.check('#criteria [name=easy]', { force: true });
await page.click('#search-btn');
await page.waitForSelector('#results .recipe');
await page.click('#results .recipe:nth-child(1) [data-action=toggle-pick]');
await page.click('#results .recipe:nth-child(2) [data-action=toggle-pick]');
await page.evaluate(() => document.activeElement?.blur());
await page.waitForTimeout(300);
await scrollTo('#results');
await page.waitForTimeout(300);
await shot('search');

await page.emulateMedia({ colorScheme: 'dark' });
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await shot('search-night');
await page.emulateMedia({ colorScheme: 'light' });

// Cook
await page.click('#results .recipe:nth-child(1) [data-action=cook]');
await page.waitForSelector('.cook-step');
await page.click('.cook-check:nth-child(1)');
await page.click('.cook-check:nth-child(2)');
await page.click('.cook-check:nth-child(3)');
await page.click('.cook-step:nth-child(1)');
await page.click('.cook-step:nth-child(2) [data-cook=timer]');
await page.waitForTimeout(3200); // let the toast fade and the timer tick
await page.evaluate(() => { const c = document.querySelector('#cook'); c.scrollTop = c.querySelector('h3').offsetTop - c.querySelector('.cook-head').offsetHeight - 8; });
await page.waitForTimeout(300);
await shot('cook');
await page.click('[data-timer]');
await page.click('[data-cook=close]');
await page.waitForTimeout(300);

// Pick
await page.goto(APP + '#cart');
await page.waitForTimeout(300);
await page.click('[data-action=build-cart]');
await page.waitForSelector('#cart .item');
await page.waitForTimeout(500);
await scrollTo('#cart');
await page.waitForTimeout(300);
await shot('pick');

console.log('errors:', errors.length ? errors : 'none');
await browser.close();
