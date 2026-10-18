# DinnerCart: notes for Claude

## Always bump the version

Every change that ships, to `web/` or `relay/`, must bump `VERSION` in
`web/js/version.js`. It's shown in the app header, so the
owners can tell which build they have. Use semver: patch for fixes, minor
for features or behavior changes. Mention the new version when reporting
the change.

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
