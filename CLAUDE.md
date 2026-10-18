# DinnerCart: notes for Claude

## Always bump the version

Every change that ships, to `web/` or `relay/`, must bump `VERSION` in
`web/js/version.js`. It's shown in the app header, so the
owners can tell which build they have. Use semver: patch for fixes, minor
for features or behavior changes. Mention the new version when reporting
the change.

## Design language: "Tomato & Basil"

- Colors are CSS variables at the top of `web/styles.css`: crisp near-white with
  charcoal text, tomato red (`--accent`) and basil green (`--basil`). Keep it
  away from cream, brown-tinted text and olive, which read as bakery-café.
  Night mode reuses the same shapes and type
  with its own palette under `prefers-color-scheme: dark`. Use the variables,
  never hard-coded colors, so both modes keep working.
- Type: Fraunces (`--serif`) for the brand, headings, legends and tappable
  labels; Inter (`--sans`) for everything else. Both are self-hosted in `web/fonts/`.
- Shapes: pill buttons and tabs, 18px card radius, 12px fields, dashed
  `--rule` lines as dividers.
- Icons: line icons from `web/js/icons.js` (`icon('name')`, or
  `data-icon="name"` in HTML). Don't use emoji in the UI; add a new icon in the
  same style instead (24px grid, 1.75 stroke, round caps, currentColor).
- App icon: `web/icon.svg` is the master (also the header logo). If it changes,
  re-render `web/favicon-32.png` (32px) and `web/apple-touch-icon.png` (180px)
  from it.

## Before pushing

- `npm test` must pass (no dependencies needed).
- For UI changes, smoke-test the page in a headless browser against mocked
  relay and Gemini responses, since recipe sites, Kroger and workers.dev
  are often unreachable from the sandbox.

## Deploying

Pushing to `main` deploys automatically:
- `web/**` → GitHub Pages (https://jarretmorton.github.io/DinnerCart/)
- `relay/**` → Cloudflare Worker (https://dinnercart-relay.jarret-morton.workers.dev)

See README.md for architecture, setup and the relay API.
