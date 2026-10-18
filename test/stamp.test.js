import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setRelayUrl, stamp } from '../scripts/stamp-site.mjs';

test('stamps local module imports, scripts and stylesheets only', () => {
  const js = `import { a } from './a.js';\nimport * as b from "../b.js";\nimport './side.js';\nconst c = await import('./c.js');\nimport x from 'https://cdn.example/x.js';\nconst s = "from './not-an-import'";`;
  assert.equal(stamp(js, 'app.js', 'abc'), `import { a } from './a.js?v=abc';\nimport * as b from "../b.js?v=abc";\nimport './side.js?v=abc';\nconst c = await import('./c.js?v=abc');\nimport x from 'https://cdn.example/x.js';\nconst s = "from './not-an-import'";`);
  const html = `<link rel="stylesheet" href="styles.css"><script type="module" src="js/app.js"></script><a href="#find">x</a><script src="https://cdn.example/lib.js"></script>`;
  assert.equal(stamp(html, 'index.html', 'abc'), `<link rel="stylesheet" href="styles.css?v=abc"><script type="module" src="js/app.js?v=abc"></script><a href="#find">x</a><script src="https://cdn.example/lib.js"></script>`);
});

test('setRelayUrl builds the relay URL into config.js', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = await readFile(new URL('../web/js/config.js', import.meta.url), 'utf8');
  assert.match(config, /^export const DEFAULT_RELAY_URL = '';$/m, 'empty in the repo');
  assert.match(setRelayUrl(config, 'https://relay.example.workers.dev/'), /^export const DEFAULT_RELAY_URL = "https:\/\/relay.example.workers.dev";$/m);
  assert.match(setRelayUrl(config, ''), /DEFAULT_RELAY_URL = "";/);
  assert.throws(() => setRelayUrl(config, 'relay"; alert(1); "'), /doesn't look like a web address/);
});
