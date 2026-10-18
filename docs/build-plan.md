# DinnerCart — Build Plan (handoff for Claude Code)

## Goal
Personal web app for two users (Jarret and wife). Enter recipe criteria, find
free recipes via web search, pick recipes, match ingredients to Fred Meyer
products, and add them to a shared Fred Meyer cart. Checkout happens in the
Fred Meyer app.

## Architecture
- Frontend: static site on GitHub Pages (public repo). Plain HTML/JS or a light framework.
- LLM: Gemini Flash (free tier, Google AI Studio), called directly from the browser.
  The key is pasted into the settings page and stored in localStorage (same pattern as Rock ID).
- Relay: Cloudflare Worker. Code lives in /relay in the same repo and
  auto-deploys on push via GitHub Actions + wrangler.
- Relay secrets (Worker secrets, never committed): BRAVE_API_KEY,
  KROGER_CLIENT_ID, KROGER_CLIENT_SECRET, RELAY_PASSWORD.
  Store the Kroger refresh token in Workers KV.

## Why the relay exists
Browsers block web pages from calling services that don't allow it (CORS).
Gemini allows it; Brave and recipe sites don't; Kroger is assumed not to (test it).
The Kroger client secret also can't live in the browser. Relay jobs:
1. Proxy Brave Search queries.
2. Fetch recipe pages and extract schema.org/Recipe JSON-LD.
3. Proxy Kroger product search and PUT /cart/add.
4. Handle Kroger OAuth (authorization code flow, redirect to the Worker URL) and token refresh.
Every request must include RELAY_PASSWORD in a header.

## User workflow
1. User enters criteria (diet, max time, servings, etc.).
2. Browser -> Gemini: generate 2-3 search queries.
3. Browser -> relay -> Brave Search: recipe URLs.
4. Relay fetches the top pages and parses the JSON-LD Recipe (ingredients, totalTime,
   recipeYield, aggregateRating, nutrition). Skip pages that block or lack markup.
5. Browser filters on the structured fields; Gemini ranks the survivors; the user picks recipes.
6. Ingredient resolver: Gemini normalizes each line into a search term + quantity;
   relay -> Kroger product search at the saved Fred Meyer store; choose the UPC and
   package count. Skip items on an editable pantry-staples list. Merge duplicates
   across recipes.
7. Review screen: confirm, swap or remove items.
8. Relay -> Kroger PUT /cart/add (batched). One-time Fred Meyer login via OAuth on first use.

## Known constraints
- The Kroger cart API is write-only: it can add items, but can't read or remove them. Users verify in the Fred Meyer app.
- Kroger cart limit is ~5,000 calls/day.
- Brave: new accounts get ~$5/month of free credit (~1,000 queries). Verify current terms.
- Store recipe URL, ingredients and metadata only; link to the source for instructions.
- The Gemini free tier may use prompts for training. Acceptable here.

## Build order (de-risk first)
1. Kroger: register at developer.kroger.com; get OAuth, product search and cart add
   working end to end through the relay. Note whether Kroger allows browser CORS.
2. Ingredient resolver + eval set: ~50 real recipe lines, each paired with the correct
   Fred Meyer product. Script that scores match accuracy; run it on every change.
3. Recipe search: Brave + JSON-LD extraction in the Worker.
4. UI: criteria input, results, review screen, settings (Gemini key, relay password, store).
5. Saved recipe library (cache parsed recipes so repeat searches cost nothing).

## Out of scope for MVP
Meal planning, price/coupon optimization, nutrition tracking, multiple
households, purchase-history learning.
