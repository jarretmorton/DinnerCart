#!/usr/bin/env node
// Resolver eval: runs eval/cases.json through the real resolver (Gemini +
// relay product search at your Fred Meyer store) and scores the picks.
//
//   GEMINI_API_KEY=... RELAY_URL=https://... RELAY_PASSWORD=... npm run eval
//
// Options:
//   --no-cache     re-query Kroger instead of using eval/.cache/products.json
//   --only=1,5,9   run a subset of case ids
//   --min=0.8      exit 1 if product accuracy is below this
//   --verbose      print every case, not just failures
// Env: GEMINI_MODEL (optional), LOCATION_ID (optional; defaults to the
// household store saved on the relay).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGemini, DEFAULT_MODEL } from '../web/js/gemini.js';
import { createRelay, productSearcher } from '../web/js/relay.js';
import { resolveIngredients } from '../web/js/resolver.js';
import { scoreCase, summarize } from './score.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing env var ${name}. See README → "Resolver eval".`);
    process.exit(2);
  }
  return v;
}

const gemini = createGemini({ apiKey: need('GEMINI_API_KEY'), model: process.env.GEMINI_MODEL || DEFAULT_MODEL });
const relay = createRelay({ url: need('RELAY_URL'), password: need('RELAY_PASSWORD') });

let locationId = process.env.LOCATION_ID;
if (!locationId) {
  locationId = (await relay.prefs()).prefs?.store?.locationId;
  if (!locationId) {
    console.error('No LOCATION_ID set and no store saved on the relay. Pick a store in the app first.');
    process.exit(2);
  }
}

let cases = JSON.parse(await readFile(join(here, 'cases.json'), 'utf8'));
if (args.only) {
  const ids = new Set(String(args.only).split(',').map(Number));
  cases = cases.filter((c) => ids.has(c.id));
}

// Cache Kroger results on disk so reruns measure resolver changes, not
// shifting search results (and don't spend API calls).
const cacheFile = join(here, '.cache', 'products.json');
const useCache = !args['no-cache'];
let cache = {};
if (useCache) {
  try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch { /* first run */ }
}
const live = productSearcher(relay, locationId);
async function searchProducts(terms) {
  const out = {};
  const missing = [];
  for (const t of terms) {
    const k = `${locationId}|${t.toLowerCase()}`;
    if (useCache && Array.isArray(cache[k])) out[t] = cache[k];
    else missing.push(t);
  }
  if (missing.length) {
    const fresh = await live(missing);
    for (const t of missing) {
      out[t] = fresh[t] || [];
      if (Array.isArray(out[t])) cache[`${locationId}|${t.toLowerCase()}`] = out[t];
      else console.error(`! search failed for "${t}": ${out[t].error}`);
    }
  }
  return out;
}

const started = Date.now();
const { items } = await resolveIngredients({
  recipes: [{ name: 'eval', ingredients: cases.map((c) => c.line) }],
  gemini,
  searchProducts,
  pantry: [],
  merge: false,
  onProgress: (t) => console.error(`· ${t}`),
});

const byLine = new Map(items.map((i) => [i.lines[0], i]));
const rows = cases.map((c, i) => scoreCase(c, byLine.get(`1.${i + 1}`)));
const summary = summarize(rows);

for (const r of rows) {
  if (!args.verbose && r.ok && r.packagesOk !== false) continue;
  const mark = r.ok ? (r.packagesOk === false ? '~' : '✓') : '✗';
  console.log(`${mark} #${r.id} ${r.line}`);
  console.log(`    → ${r.product ?? '(none)'}  ×${r.packages ?? '-'} [${r.packagesSource ?? ''}]  ${r.ok ? '' : `(${r.why}${r.searchHit ? '; a correct product WAS in the results' : '; search missed'})`}`);
  if (r.packagesOk === false) console.log('    packages: expected', cases.find((c) => c.id === r.id).expect.packages);
  if (!r.ok) console.log(`    normalized: "${r.name}" searched "${r.searchTerm}"`);
}

const fmt = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
console.log(`\nProduct accuracy ${fmt(summary.productAccuracy)} · search recall ${fmt(summary.searchRecall)} · packages ${fmt(summary.packagesAccuracy)} · ${summary.cases} cases · ${((Date.now() - started) / 1000).toFixed(0)}s · ${gemini.model}`);

await mkdir(join(here, '.cache'), { recursive: true });
if (useCache) await writeFile(cacheFile, JSON.stringify(cache));
await mkdir(join(here, 'results'), { recursive: true });
await writeFile(join(here, 'results', 'latest.json'), JSON.stringify({ at: new Date().toISOString(), model: gemini.model, locationId, summary, rows }, null, 2));

if (args.min && summary.productAccuracy < Number(args.min)) {
  console.error(`Below --min=${args.min}`);
  process.exit(1);
}
