#!/usr/bin/env node
// Copy the static site and add ?v=<id> to every local script, stylesheet and
// module import, so each deploy gets fresh URLs. Otherwise browsers can mix
// a new index.html with cached old JS (GitHub Pages caches for 10 minutes)
// and the app breaks.
//
//   node scripts/stamp-site.mjs web _site <id>
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
  for (const file of await walk(dest)) {
    if (!/\.(js|html)$/.test(file)) continue;
    const before = await readFile(file, 'utf8');
    const after = stamp(before, file, id);
    if (after !== before) await writeFile(file, after);
  }
  console.log(`stamped ${dest} with ${id}`);
}
