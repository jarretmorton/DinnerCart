# DinnerCart

A personal web app for our household: describe what you feel like eating, get
free recipes from the web, pick a few, and DinnerCart matches the ingredients
to Fred Meyer products and adds them to our shared Fred Meyer cart. Checkout
happens in the Fred Meyer app.

```
 Browser (GitHub Pages, /web)                     Cloudflare Worker (/relay)
 ───────────────────────────                      ──────────────────────────
 criteria ─► Gemini: 3 search queries
          ─────────────────────────────────────► /search  ─► Brave Search
          ─────────────────────────────────────► /recipe  ─► recipe page → JSON-LD
 filter (time, rating, exclusions)                           (cached in KV)
          ─► Gemini: rank, user picks
 ingredients ─► Gemini: normalize lines
          ─────────────────────────────────────► /kroger/products ─► Kroger API
          ─► Gemini: choose product + count
 review screen (swap / remove / qty)
          ─────────────────────────────────────► /kroger/cart ─► PUT /cart/add
```

The relay exists because browsers can't call Brave or recipe sites directly
(CORS), and the Kroger client secret can't live in a public web page. Every
relay request needs the relay password in the `X-Relay-Password` header. The
only exception is the Kroger OAuth callback, which is authenticated by a
single-use `state` value.

## Repository layout

| Path | What |
|---|---|
| `web/` | The static site. Plain HTML and ES modules, no build step. |
| `web/js/resolver.js` | Ingredient resolver (normalize → pantry → merge → search → pick → package count). Shared with the eval. |
| `web/js/units.js` | Unit conversion and Kroger size parsing (`"6 ct / 12 fl oz"`, `"1/2 gal"`…). |
| `web/js/recipes.js` | Query generation, structured filters, Gemini ranking. |
| `relay/` | The Cloudflare Worker: Brave proxy, JSON-LD extraction, Kroger OAuth/products/cart, recipe library, shared prefs. |
| `eval/` | 50 real recipe lines, each with the product it should match, plus the scoring script. |
| `test/`, `relay/test/` | Unit tests (`npm test`, no dependencies). |
| `docs/build-plan.md` | The original build plan. |

## One-time setup

Do these in order. Each step tells you what to save; the GitHub secrets list
at the end collects them all.

### 1. Kroger developer app (do this first; it's the riskiest part)

1. Sign up at <https://developer.kroger.com> and create an application in the **Production** environment.
2. API products: **Cart**, **Locations**, **Products** (scopes `cart.basic:write` and `product.compact`). Profile isn't needed.
3. Redirect URI: `https://dinnercart-relay.<your-subdomain>.workers.dev/kroger/oauth/callback`.
   You'll know the exact Worker URL after the first deploy (step 4). You can edit the URI later.
4. Save the **client ID** and **client secret**.

### 2. Brave Search API

Create an account at <https://api-dashboard.search.brave.com>, subscribe to
the free/credit Search plan (check the current terms; at the time of the plan
new accounts got about $5/month of credit, roughly 1,000 queries), and save the
**API key**. Each recipe search uses up to 3 queries. Results are cached in KV
for 7 days, so repeat searches are free.

### 3. Cloudflare

1. Create a free Cloudflare account.
2. Go to **Storage & Databases → KV → Create namespace**, name it `dinnercart`, and save its **namespace ID**.
3. Go to **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template, and save the **token**.
4. Save your **account ID** (shown on the Workers & Pages overview page).

### 4. GitHub repository settings

**Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | from step 3 |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | from step 3 |
| Secret | `BRAVE_API_KEY` | from step 2 |
| Secret | `KROGER_CLIENT_ID` | from step 1 |
| Secret | `KROGER_CLIENT_SECRET` | from step 1 |
| Secret | `RELAY_PASSWORD` | a long random string, e.g. `openssl rand -base64 24` |
| Secret | `GEMINI_API_KEY` | optional, for the eval workflow (step 5) |
| Variable | `KV_NAMESPACE_ID` | from step 3 |
| Variable | `RELAY_URL` | the Worker URL, after the first deploy (used by the eval workflow) |

**Settings → Pages → Source: GitHub Actions.**

Push to `main`. The *Deploy relay* workflow publishes the Worker and pushes the
four Worker secrets. The *Deploy site* workflow publishes `web/` to
`https://jarretmorton.github.io/DinnerCart/`.

If the site lives somewhere else (a fork, a custom domain), update
`ALLOWED_ORIGINS` and `APP_URL` in `relay/wrangler.toml`. The relay only
answers browsers from those origins.

### 5. Gemini key (each person, on each device)

Get a free key at <https://aistudio.google.com/apikey>. The free tier may use
prompts for training, which is fine for this app. The key is pasted into the
app's Settings page and stored only in that browser's localStorage.

### 6. In the app

1. Open the site → **Settings**. Enter the relay URL, relay password and Gemini key, then **Save**.
2. Press **Check setup**. It checks the relay, the Worker secrets, Gemini, and whether Kroger allows direct browser calls (CORS).
3. Enter your ZIP → **Find stores** → choose your Fred Meyer. This is shared with the household.
4. Under **Household (shared)**, set the search defaults (max time, servings, minimum rating) and edit the pantry staples list. Items on it are never added to the cart.
5. In the same Household section, press **Connect Fred Meyer** and log in once. The refresh token is stored in Workers KV and shared by both of you.

## Using it

1. **Find**: describe what you want, then set time, servings and what to leave out. The boxes rotate suggestions; tap a box's label to use the idea shown (or, for "What to leave out", your household list from Settings). Recipes rated below the household minimum (Settings, default 4★) are skipped; unrated ones are kept.
   Or press **Recommendations** (no fields needed): Gemini looks at your saved Recipes, plus anything you filled in, and finds new dishes in a similar vein, skipping ones you've already saved.
2. Pick recipes, and save good ones to the shared **Recipes** tab. You can also add any recipe by pasting its link.
3. **Cart**: adjust servings per recipe (quantities scale), then press **Match ingredients**.
4. Review each line: swap to another candidate, search again, change the count, or remove it. Pantry staples, optional garnishes and water are listed under *Not adding*; tap ＋ to add one anyway.
5. Press **Add to Fred Meyer cart**, then open the Fred Meyer app to review and check out.

The Kroger cart API is **write-only**: DinnerCart can add items but can't see
or remove them. If you press *Send again*, the items are added a second time,
and the app asks you to confirm first.

## Development

The app version lives in `web/js/version.js` and shows in the header. Bump it with every change so you can tell whether a browser has the latest build (GitHub Pages can cache for up to 10 minutes).

```sh
npm test                      # unit tests: relay + resolver + units + eval scoring
npm run serve                 # site at http://localhost:8080 (already in ALLOWED_ORIGINS)

cd relay && npm install
cp .dev.vars.example .dev.vars   # fill in keys for local dev
npm run dev                   # Worker at http://localhost:8787 with local KV
```

Point the app's relay URL at `http://localhost:8787` for local testing. For
Kroger OAuth locally, also add `http://localhost:8787/kroger/oauth/callback` as
a redirect URI on the Kroger app.

### Resolver eval

`eval/cases.json` has 50 real recipe lines. Each one names the product it
should resolve to, by required and banned description words (for example,
"onion" but not "powder"/"red"/"green"), or by exact accepted UPCs once you've
confirmed them at your store. Some cases also give the expected package count.

```sh
GEMINI_API_KEY=... RELAY_URL=https://dinnercart-relay.<sub>.workers.dev RELAY_PASSWORD=... npm run eval
npm run eval -- --verbose       # print every case
npm run eval -- --only=3,17     # subset
npm run eval -- --no-cache      # re-query Kroger (otherwise eval/.cache is reused)
npm run eval -- --min=0.85      # fail below 85% product accuracy
```

It reports **product accuracy**, **search recall** (whether any correct product
was in the search results at all, which separates search misses from pick
misses), and **package-count accuracy**. Full results are written to
`eval/results/latest.json`. Run it after every resolver or prompt change. The
*Resolver eval* workflow also runs it on pushes that touch the resolver, once
the secrets are set.

To lock a case to the exact product, add `"upcs": ["0001111041700"]` to its
`expect`.

## Relay API

All routes need `X-Relay-Password`, except the OAuth callback.

| Route | Body / query | Returns |
|---|---|---|
| `GET /health` | | which secrets/bindings are configured |
| `POST /search` | `{queries: [..≤5]}` | merged, de-duplicated Brave results |
| `POST /recipe` | `{url, refresh?}` | `{recipe}` parsed from JSON-LD, or `{recipe: null, reason}` |
| `POST /kroger/products` | `{terms: [..≤20], locationId}` | `{results: {term: [product]}}` |
| `GET /kroger/locations` | `?zip=97214` | nearby Fred Meyer stores |
| `POST /kroger/cart` | `{items: [{upc, quantity}], modality}` | `{added, batches}` (batches of 25) |
| `GET /kroger/status` | | `{connected}` |
| `POST /kroger/oauth/start` | `{returnTo}` | `{url}` to send the browser to |
| `GET /kroger/oauth/callback` | (from Kroger) | redirects back to the app |
| `POST /kroger/disconnect` | | forgets the stored tokens |
| `GET/POST/DELETE /library` | `{recipe}` / `?id=` | shared saved recipes |
| `GET/PUT /prefs` | `{prefs: {store, pantry, leaveOut, modality, minRating, maxMinutes, servings}}` | shared household settings |

Only the URL, ingredients and metadata of recipes are stored, never the
instructions. The app links to the source page instead.

## Known constraints

- The Kroger cart is write-only (see above). It allows about 5,000 cart calls per day, and DinnerCart uses one call per 25 items.
- Pages that block bots or have no `schema.org/Recipe` markup are skipped. They're listed under "couldn't be read" with the reason.
- Free Cloudflare Workers get 10 ms of CPU per request. That's why each recipe page is parsed in its own request.
- The Gemini free tier is rate-limited. Each visit starts on the strong model (`gemini-flash-latest`). When it hits its limit, the app switches to the light model (`gemini-flash-lite-latest`) until you reload. The Strong/Light toggle in Settings shows which model is active and can be switched by hand.

## Build plan status

- [x] Kroger: OAuth (authorization code + refresh), product search, location search, batched cart add through the relay. Finding: Kroger *does* allow browser CORS (a direct call returns HTTP 401, not a CORS error), but the relay is still required because the client secret and the user tokens must not live in the browser.
- [x] Ingredient resolver + 50-line eval set + scoring script.
- [x] Recipe search: Brave + JSON-LD extraction in the Worker.
- [x] UI: criteria, results, review screen, settings (Gemini key, relay password, store, pantry).
- [x] Saved recipe library, plus KV caching of parsed recipes and search results.

Out of scope for the MVP: meal planning, price/coupon optimization, nutrition
tracking, multiple households, purchase-history learning.
