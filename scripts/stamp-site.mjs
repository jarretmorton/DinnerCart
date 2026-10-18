#!/usr/bin/env node
// Copy the static site and add ?v=<id> to every local script, stylesheet and
// module import, so each deploy gets fresh URLs. Otherwise browsers can mix
// a new index.html with cached old JS (GitHub Pages caches for 10 minutes)
// and the app breaks.
//
// If RELAY_URL is set, it's also written into js/config.js, so this copy of
// the site points at this repo's relay without anyone typing it in.
//
//   RELAY_URL=https://... node scripts/stamp-site.mjs web _site <id>
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function stamp(text, file, id) {
  const q = `?v=${encodeURIComponent(id)}`;
  if (file.endsWith('.js')) {
    return text.replace(/(\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)(['"])(\.{1,2}\/[^'"?]+\.js)\2/gm, `$1$2$3${q}$2`);
  }
  if (file.endsWith('.html')) {
    return text.replace(/\b(src|href)="(?![a-z]+:|\/\/|#)([^"?]+\.(?:js|css))"/g, `$1="$2${q}"`);
  }
  return text;
}

export function setRelayUrl(text, relayUrl) {
  const url = String(relayUrl || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s'"]+$/i.test(url)) throw new Error(`RELAY_URL doesn't look like a web address: ${url}`);
  return text.replace(/^export const DEFAULT_RELAY_URL = .*$/m, `export const DEFAULT_RELAY_URL = ${JSON.stringify(url)};`);
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    out.push(...(entry.isDirectory() ? await walk(p) : [p]));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [src, dest, id] = process.argv.slice(2);
  if (!src || !dest || !id) {
    console.error('usage: stamp-site.mjs <src> <dest> <id>');
    process.exit(2);
  }
  await cp(src, dest, { recursive: true });
  const config = join(dest, 'js', 'config.js');
  for (const file of await walk(dest)) {
    if (!/\.(js|html)$/.test(file)) continue;
    const before = await readFile(file, 'utf8');
    let after = stamp(before, file, id);
    if (file === config) after = setRelayUrl(after, process.env.RELAY_URL);
    if (after !== before) await writeFile(file, after);
  }
  console.log(`stamped ${dest} with ${id}${process.env.RELAY_URL ? `, relay ${process.env.RELAY_URL}` : ', no relay URL built in'}`);
}
