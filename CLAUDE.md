# DinnerCart: notes for Claude

## Always bump the version

Every change that ships, to `web/` or `relay/`, must bump `VERSION` in
`web/js/version.js`. It's shown in the app header, so the
owners can tell which build they have. Use semver: patch for fixes, minor
for features or behavior changes. Mention the new version when reporting
the change.

## Design language: "Tomato & Basil"

- Colors are CSS variables at the top of `web/styles.css`: crisp near-white with
  charcoal text, tomato red (`--accent`) and basil green (`--basil`), plus the
  app icon's lemon (`--lemon`) as an accent. Lemon is too faint as text on white,
  so it's a fill, a border or a small icon, with charcoal text (`--lemon-ink`)
  on it; never darken it into ochre for text. Keep it
  away from cream, brown-tinted text and olive, which read as bakery-café.
  Night mode reuses the same shapes and type
  with its own palette under `prefers-color-scheme: dark`. Use the variables,
  never hard-coded colors, so both modes keep working.
- Type: Fraunces (`--serif`) for the brand, headings, legends and tappable
  labels; Inter (`--sans`) for everything else. Both are self-hosted in `web/fonts/`.
- Shapes: pill buttons and tabs, 18px card radius, 12px fields, dashed
  `--rule` lines as dividers.
- Buttons say what they do by color: green moves you forward, lemon keeps, red
  discards.
  - `go` (basil green) moves you forward: search, pick, cook, match, send,
    check, share, add.
  - `save` (lemon) keeps: Save/Saved on recipes and the Config Saves. Its
    outline is a gold border (`--lemon-edge`) with charcoal text.
  - `drop` (tomato red) removes or disconnects.
  - All go solid (`.on`) the moment they're tapped; `syncButtons()` in
    `app.js` then settles the state-backed ones, so a cancel or failure
    returns to an outline. Solid means done or in effect:
    the search method behind the results, Picked, Saved, Cook when steps exist,
    Match while the list fits the picks, Send until the list changes, a Config
    Save until the form is edited again, Remove while its confirm is up.
  - `clear` is red text with no pill, for Clear results/picks/list, remove and
    the picked-recipe trash.
  - Settings aren't buttons: an on/off setting (like Easy) is a checkbox, in a
    field-shaped `check-field` when it sits among fields.
  - Links and `link` buttons are green. A picked card gets a green outline.
    Disabled buttons fade, except a solid "done" one like Saved.
  - Lemon also marks things worth noticing, not acting on: `.tag` chips (your
    usual, sale), gold rating stars (`--star`), the chosen "It was OK" face.
    The chosen family face is solid in its color (green, lemon, red).
- Icons: line icons from `web/js/icons.js` (`icon('name')`, or
  `data-icon="name"` in HTML). Don't use emoji in the UI; add a new icon in the
  same style instead (24px grid, 1.75 stroke, round caps, currentColor).
  An icon borrowed from an open-source set in that style (e.g. Tabler, MIT) is
  fine; credit it in a comment next to it and in the README's Credits.
- App icon: `web/icon.svg` is the master (also the header logo). If it changes,
  re-render `web/favicon-32.png` (32px), `web/apple-touch-icon.png` (180px)
  and the manifest's `web/icon-192.png` and `web/icon-512.png` from it.

## Before pushing

- `npm test` must pass (no dependencies needed).
- For UI changes, smoke-test the page in a headless browser against mocked
  relay and Gemini responses, since recipe sites, Kroger and workers.dev
  are often unreachable from the sandbox.

## Deploying

Pushing to `main` deploys automatically:
- `web/**` → GitHub Pages (https://jarretmorton.github.io/DinnerCart/)
- `relay/**` → Cloudflare Worker (https://dinnercart-relay.jarret-morton.workers.dev)

Other households run their own fork, so keep the code free of this
household's addresses: the relay URL comes from the `RELAY_URL` repository
variable (stamped into `web/js/config.js`), and the relay's `ALLOWED_ORIGINS`
and `APP_URL` are filled in from the repository name by `deploy-relay.yml`.

See README.md for architecture, setup and the relay API.
