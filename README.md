# DinnerCart

<img width="120" height="120" alt="DinnerCart app icon" src="web/icon.svg"/>

A personal web app for our household: describe what you feel like eating, get
free recipes from the web, pick a few, and DinnerCart matches the ingredients
to Fred Meyer products and adds them to our shared Fred Meyer cart. Checkout
happens in the Fred Meyer app.

- App: <https://jarretmorton.github.io/DinnerCart/>
- Relay: `https://dinnercart-relay.jarret-morton.workers.dev`

Want it for your household? Each household runs its own copy: its own site,
relay, Fred Meyer login, shared recipes and password. It's all free tiers.
See [Run your own DinnerCart](#run-your-own-dinnercart).

<p>
  <img width="250" alt="Search: recipe results with ratings, time and a reason each one fits" src="docs/screenshots/find.png"/>
  <img width="250" alt="Pick: shopping list matched to Fred Meyer products, ready to send" src="docs/screenshots/cart.png"/>
  <img width="250" alt="Search in night mode" src="docs/screenshots/find-night.png"/>
</p>

<sub>Recipe results, the matched shopping list, and night mode. Sample data;
the food pictures are illustrations standing in for recipe and product photos.</sub>

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
| `web/js/app.js` | UI controller: views, events, settings. |
| `web/js/resolver.js` | Ingredient resolver (normalize → pantry → merge → search → pick → package count). Shared with the eval. |
| `web/js/units.js` | Unit conversion and Kroger size parsing (`"6 ct / 12 fl oz"`, `"1/2 gal"`…). |
| `web/js/recipes.js` | Query generation (Search and Recommend), structured filters, Gemini ranking. |
| `web/js/gemini.js` | Gemini client with the strong → light fallback. |
| `web/js/suggestions.js` | Rotating "What sounds good?" ideas and the daily Gemini batch. |
| `web/js/cook.js`, `web/js/cook-view.js` | Cook: easy steps written by Gemini from the recipe's own method, amount scaling, and the Cook screen (ticks, timers, screen stays on). |
| `web/js/library.js` | Save tab grouping (This week / Last week / Last 30 days / Older). |
| `web/js/config.js` | The relay URL, filled in at deploy from the `RELAY_URL` repository variable. |
| `web/js/setup-link.js` | The "Share setup link" that sets up another phone in one tap. |
| `web/js/kroger.js`, `web/js/kroger-shared.js` | Direct-from-browser product search with relay fallback; product formatting shared with the relay. |
| `web/js/icons.js` | The app's line icons. |
| `web/js/version.js` | App version shown in the header. |
| `web/styles.css`, `web/fonts/` | Design tokens and styles (light and night), self-hosted fonts. |
| `scripts/stamp-site.mjs` | Adds a per-deploy `?v=` to every script and stylesheet so browsers never mix old and new files, and builds in the relay URL. |
| `relay/` | The Cloudflare Worker: Brave proxy, JSON-LD extraction, Kroger OAuth/products/cart, recipe library, shared prefs. |
| `eval/` | 50 real recipe lines, each with the product it should match, plus the scoring script. |
| `test/`, `relay/test/` | Unit tests (`npm test`, no dependencies). |
| `docs/build-plan.md` | The original build plan. |
| `CLAUDE.md` | Working rules for Claude Code: version bumps, design language, checks before pushing. |

## Run your own DinnerCart

One person per household does this once, in about 30–45 minutes. Nothing in
the code needs editing: the site and relay work out their addresses from your
GitHub account and repository name.

### 0. Fork

Fork this repository on GitHub (or copy it into a new repository). Keep the
name `DinnerCart` or pick your own. The site will live at
`https://<your-github-name>.github.io/<repo-name>/`.

Then do these in order. Each step tells you what to save; the GitHub settings
table in step 4 collects them all.

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
| Variable | `KV_NAMESPACE_ID` | from step 3 (a secret works too) |
| Variable | `RELAY_URL` | the Worker URL, after the first deploy. Built into the site so nobody has to type it; also used by the eval workflow |
| Variable | `APP_URL` | optional: only if the site isn't at your GitHub Pages address (e.g. a custom domain) |

Also in repository **Settings**:
- **General → Default branch:** `main`. The deploy workflows run on pushes to `main`.
- **Pages → Build and deployment → Source:** GitHub Actions.
- **Environments → `github-pages` → Deployment branches:** must allow `main`. GitHub creates this rule for whichever branch was the default when Pages was turned on.

Push to `main`, or run both workflows from the **Actions** tab. The *Deploy
relay* workflow publishes the Worker, pushes the four Worker secrets, and
points the relay at your site (`https://<owner>.github.io/<repo>/`, or
`APP_URL`). The relay only answers browsers from that site and
`http://localhost:8080`. The *Deploy site* workflow publishes `web/` to your
GitHub Pages address.

The first relay deploy prints the Worker URL. Save it as the `RELAY_URL`
variable, add its `/kroger/oauth/callback` to the Kroger app (step 1), then
run *Deploy site* again from the Actions tab so the site picks it up. After
that, every push to `main` deploys whatever changed.

### 5. Gemini key (each person, on each device)

Get a free key at <https://aistudio.google.com/apikey>. The free tier may use
prompts for training, which is fine for this app. The key is pasted into the
app's Config tab and stored only in that browser's localStorage.

### 6. In the app

1. Open the site → **Config**. Enter the relay password and Gemini key, then **Save**. The relay URL is already built in (leave it blank) if you set `RELAY_URL`.
2. Press **Check setup**. It checks the relay, the Worker secrets, Gemini, and whether Kroger allows direct browser calls (CORS).
3. Under **Household (shared)**, press **Connect Fred Meyer** and log in once. The refresh token is stored in Workers KV and shared by both of you.
4. Enter your ZIP → **Find stores** → choose your Fred Meyer, and choose pickup or delivery.
5. Set the search defaults (max time, servings, minimum rating), your "what to leave out" list, and the pantry staples list. Pantry items are never added to the cart.

Everything under Household is saved on the relay, so both of you share it. The relay URL, password and Gemini key are per device.

### 7. The rest of the household

On a phone that's set up, go to **Config → Share setup link** and send it
to the other phone (it uses the share sheet, or copies the link). Opening it
saves the relay password, plus your Gemini key if you ticked **Include my
Gemini key**, on that phone. Otherwise they add their own key, so each person
uses their own free Gemini quota. The settings travel in the part of the
link after `#`, which browsers never send to any server. The link does carry
the relay password, so only send it within your household.

## Using it

1. **Search**: describe what you want, then set time (15 min to 1 hour, or any time), servings and what to leave out. Turn on **Easy** (lightning) for low-effort dinners: at most 10 ingredients not counting pantry staples, at most 8 steps, with searches and ranking steered toward simple, one-pan dishes; recipes over the limits are listed as skipped with the reason. Easy is separate from time, so an easy one-hour roast still counts. Config can turn Easy on by default. The boxes rotate suggestions ("What sounds good?" ideas are written fresh by Gemini once a day and shared by both of you through the relay, using the light model, the season and your saved recipes; a built-in list covers the gap); tap a box's label to use the idea shown (or, for "What to leave out?", your household list from Config). Recipes rated below the household minimum (Config, default 4★) are skipped; unrated ones are kept.
   Or press **Recommend** (no fields needed): Gemini looks at your saved recipes, plus anything you filled in, and finds new dishes in a similar vein, skipping ones you've already saved.
   **Search** finds recipes for what you typed. **Clear results** empties the results list.
2. On any recipe, **Pick** it for this shop, **Save** it, or **Cook** it. The **Save** tab is one shared list of everything saved, by hand or automatically when sent to Fred Meyer, grouped into **This week** (weeks start Monday), **Last week**, **Last 30 days** and **Older** by when it was last saved or picked. **Pick** it again or **Remove** it from there. You can also add any recipe by pasting its link at the bottom.
   **Cook** opens easy step-by-step instructions: Gemini rewrites the recipe page's own steps into one action per step, keeping every temperature, time and amount as the original gives them, with a "Before you start" list (preheat, chop, measure). Amounts scale to the number of people (your picked servings, the search's, or the household default; change it with − / +). Tap a line to tick it off; steps with a wait (bake, simmer, rest) have a timer button, and the timers ring, vibrate and stay on screen. The screen stays on while Cook is open, and Back closes it. Every ingredient on the list has to be named in the steps: if Gemini leaves one out, the app asks it once more to fit the missing ones in, and anything still missing is listed at the top of Cook (steps written before this check get flagged too). If the original mentions a temperature the rewrite left out, Cook says so as well; the original is linked at the top. Cook always uses the strong Gemini model (the light one only if the strong one is rate limited). **Regenerate cook steps** writes them again and replaces the saved ones; **Start cook over** unticks everything. Steps are written once and kept on the phone; saving a recipe (by hand or by sending it to Fred Meyer) stores its Cook steps in the shared Save list, so both of you get them without asking Gemini again. Pages that don't publish their steps in schema.org markup just link to the original.
3. **Pick**: adjust servings per recipe (quantities scale), then press **Match ingredients**. **Clear picks** empties the picks and shopping list in the app; **Clear list** (next to the send button) empties just the shopping list. Neither touches the Fred Meyer cart.
4. Review each line: swap to another candidate, search again, change the count, or remove it. Pantry staples, optional garnishes and water are listed under *Not adding*; tap + to add one anyway. If a Fred Meyer search fails, the line says why.
5. Press **Add to Fred Meyer cart**, then use the **Fred Meyer cart** link below it to review and check out, and **Fred Meyer orders** to see past and current orders (Kroger's API can't read orders, so this opens Fred Meyer's purchases page). On phones these usually open the Fred Meyer app. The recipes you sent are saved to the shared **Save** tab automatically.

The Kroger cart API is **write-only**: DinnerCart can add items but can't see
or remove them. If you press *Send again*, the items are added a second time,
and the app asks you to confirm first.

## Development

The app version lives in `web/js/version.js` and shows in the header. Bump it with every change so you can tell whether a browser has the latest build. GitHub Pages can cache the page for up to 10 minutes. The deploy stamps every file with the commit, so a page always loads code from its own deploy.

The design language ("Tomato & Basil", with a matching night mode) and the icon rules are written down in `CLAUDE.md`.

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
| `POST /recipe` | `{url, refresh?}` | `{recipe}` parsed from JSON-LD (including the original `instructions`, for Cook), or `{recipe: null, reason}` |
| `POST /kroger/products` | `{terms: [..≤20], locationId}` | `{results: {term: [product]}, errors: {term: message}}` |
| `GET /kroger/locations` | `?zip=97214` | Fred Meyer stores within 25 miles (all Kroger-family stores if there are none) |
| `POST /kroger/cart` | `{items: [{upc, quantity}], modality}` | `{added, batches}` (batches of 25) |
| `GET /kroger/status` | | `{connected, connectedAt}` |
| `GET /kroger/token` | | short-lived search-only token (`product.compact`, no cart access) so the browser can search Kroger directly |
| `POST /kroger/oauth/start` | `{returnTo}` | `{url}` to send the browser to |
| `GET /kroger/oauth/callback` | (from Kroger) | redirects back to the app |
| `POST /kroger/disconnect` | | forgets the stored tokens |
| `GET/POST/DELETE /library` | `{recipe}` / `?id=` | shared recipe library (`savedAt`, `lastPickedAt`, `pickedCount` and Cook steps per recipe) |
| `POST /library/picked` | `{recipes: [..≤20]}` | saves recipes just sent to the cart and records the pick; returns the library |
| `GET/PUT /prefs` | `{prefs: {store, pantry, leaveOut, modality, minRating, maxMinutes, servings, easy, dailyIdeas}}` | shared household settings |

The library stores each recipe's URL, ingredients and metadata, plus the
app's own rewritten Cook steps once someone has opened Cook. It never stores
the original page's instructions, and always links to the source page.

## Known constraints

- The Kroger cart is write-only (see above). It allows about 5,000 cart calls per day, and DinnerCart uses one call per 25 items.
- Kroger's API sits behind a bot firewall that sometimes blocks Cloudflare's shared servers ("403 Access Denied"). So the app searches products **directly from the phone**, using a search-only token from the relay in the web address (Kroger allows browser requests, but refuses the CORS preflight a header would need), and falls back to the relay per item if that fails. **Check setup** shows which path is working and, if direct search fails, why. Relay requests identify the app, run 2 product searches at a time, retry once after a firewall block and then stop for that request, and cache product results for 6 hours.
- Pages that block bots or have no `schema.org/Recipe` markup are skipped. They're listed under "couldn't be read" with the reason.
- Free Cloudflare Workers get 10 ms of CPU per request. That's why each recipe page is parsed in its own request.
- The Gemini free tier is rate-limited. Each visit starts on the strong model (`gemini-flash-latest`). When it hits its limit, the app switches to the light model (`gemini-flash-lite-latest`) until you reload. The Strong (anvil) / Light (sewing needles) toggle in Config shows which model is active and can be switched by hand.

## Build plan status

- [x] Kroger: OAuth (authorization code + refresh), product search, location search, batched cart add through the relay. Finding: Kroger *does* allow browser CORS (a direct call returns HTTP 401, not a CORS error), but the relay is still required because the client secret and the user tokens must not live in the browser.
- [x] Ingredient resolver + 50-line eval set + scoring script.
- [x] Recipe search: Brave + JSON-LD extraction in the Worker.
- [x] UI: criteria, results, review screen, settings (Gemini key, relay password, store, pantry), plus Recommend, daily ideas and the Tomato & Basil design.
- [x] Saved recipe library, plus KV caching of parsed recipes and search results.

Out of scope for the MVP: meal planning, price/coupon optimization, nutrition
tracking, purchase-history learning. One relay serves one household; other
households run their own copy (see above).
