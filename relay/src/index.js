// DinnerCart relay (Cloudflare Worker).
//
// Exists because browsers can't call Brave, recipe sites or (probably)
// Kroger directly (CORS), and the Kroger client secret can't live in the
// browser. Every route except the OAuth callback requires the relay
// password in the X-Relay-Password header.
import { corsHeaders, requirePassword } from './auth.js';
import { HttpError, errorResponse, json, readJson } from './http.js';
import * as kroger from './kroger.js';
import { fetchRecipe, searchMany } from './search.js';
import { libraryDelete, libraryList, libraryPicked, librarySave, prefsGet, prefsUpdate } from './store.js';

const routes = {
  'GET /health': async (_req, env) => ({
    ok: true,
    configured: {
      brave: Boolean(env.BRAVE_API_KEY),
      kroger: Boolean(env.KROGER_CLIENT_ID && env.KROGER_CLIENT_SECRET),
      kv: Boolean(env.DC_KV),
    },
  }),

  'POST /search': async (req, env) => {
    const body = await readJson(req);
    return { results: await searchMany(env, body.queries, { count: body.count || 20 }) };
  },

  'POST /recipe': async (req, env) => {
    const body = await readJson(req);
    return fetchRecipe(env, body.url, { refresh: Boolean(body.refresh) });
  },

  'POST /kroger/products': async (req, env) => {
    const body = await readJson(req);
    return kroger.searchProductsMany(env, body.terms, body.locationId, { limit: body.limit || 12 });
  },

  'GET /kroger/locations': async (req, env) => {
    const url = new URL(req.url);
    return { locations: await kroger.findLocations(env, url.searchParams.get('zip')) };
  },

  'POST /kroger/cart': async (req, env) => {
    const body = await readJson(req);
    return kroger.addToCart(env, body.items, body.modality);
  },

  'GET /kroger/status': async (_req, env) => kroger.userStatus(env),

  // Search-only token so the browser can query Kroger products itself.
  'GET /kroger/token': async (_req, env) => kroger.appTokenForBrowser(env),

  'POST /kroger/oauth/start': async (req, env) => {
    const body = await readJson(req);
    return { url: await kroger.startOAuth(env, req.url, body.returnTo) };
  },

  'POST /kroger/disconnect': async (_req, env) => {
    await kroger.disconnect(env);
    return { ok: true };
  },

  'GET /library': async (_req, env) => ({ recipes: await libraryList(env) }),

  'POST /library': async (req, env) => {
    const body = await readJson(req);
    return { recipe: await librarySave(env, body.recipe) };
  },

  // Called after a cart send: saves each picked recipe and records the pick.
  'POST /library/picked': async (req, env) => {
    const body = await readJson(req);
    await libraryPicked(env, body.recipes);
    return { recipes: await libraryList(env) };
  },

  'DELETE /library': async (req, env) => {
    const id = new URL(req.url).searchParams.get('id');
    if (!id) throw new HttpError(400, 'bad_request', 'Missing id.');
    return { removed: await libraryDelete(env, id) };
  },

  'GET /prefs': async (_req, env) => ({ prefs: await prefsGet(env) }),

  'PUT /prefs': async (req, env) => {
    const body = await readJson(req);
    return { prefs: await prefsUpdate(env, body.prefs) };
  },
};

export async function handle(request, env) {
  const url = new URL(request.url);
  const cors = corsHeaders(request, env);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  // Browser navigation from Kroger's login page; authenticated by `state`.
  if (request.method === 'GET' && url.pathname === '/kroger/oauth/callback') {
    try {
      return await kroger.finishOAuth(env, request.url);
    } catch (err) {
      return errorResponse(err);
    }
  }

  let response;
  try {
    const route = routes[`${request.method} ${url.pathname.replace(/\/+$/, '') || '/'}`];
    if (!route) throw new HttpError(404, 'not_found', `No route for ${request.method} ${url.pathname}.`);
    await requirePassword(request, env);
    response = json(await route(request, env));
  } catch (err) {
    response = errorResponse(err);
  }
  for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
  return response;
}

export default { fetch: handle };
