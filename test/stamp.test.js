import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp } from '../scripts/stamp-site.mjs';

test('stamps local module imports, scripts and stylesheets only', () => {
  const js = `import { a } from './a.js';\nimport * as b from "../b.js";\nimport './side.js';\nconst c = await import('./c.js');\nimport x from 'https://cdn.example/x.js';\nconst s = "from './not-an-import'";`;
  assert.equal(stamp(js, 'app.js', 'abc'), `import { a } from './a.js?v=abc';\nimport * as b from "../b.js?v=abc";\nimport './side.js?v=abc';\nconst c = await import('./c.js?v=abc');\nimport x from 'https://cdn.example/x.js';\nconst s = "from './not-an-import'";`);
  const html = `<link rel="stylesheet" href="styles.css"><script type="module" src="js/app.js"></script><a href="#find">x</a><script src="https://cdn.example/lib.js"></script>`;
  assert.equal(stamp(html, 'index.html', 'abc'), `<link rel="stylesheet" href="styles.css?v=abc"><script type="module" src="js/app.js?v=abc"></script><a href="#find">x</a><script src="https://cdn.example/lib.js"></script>`);
});
