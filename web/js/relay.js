// Client for the Cloudflare Worker relay.

export class RelayError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function createRelay({ url, password, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  if (!url) throw new RelayError('Set the relay URL in Settings.', 0, 'not_configured');
  const base = url.replace(/\/+$/, '');

  async function call(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'x-relay-password': password || '', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new RelayError(`Can't reach the relay (${err.message}). Check the URL and that its ALLOWED_ORIGINS includes this site.`, 0, 'network');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = data.error || {};
      throw new RelayError(e.message || `Relay error ${res.status}`, res.status, e.code, e.details);
    }
    return data;
  }

  return {
    health: () => call('GET', '/health'),
    search: (queries) => call('POST', '/search', { queries }),
    recipe: (url, refresh = false) => call('POST', '/recipe', { url, refresh }),
    products: (terms, locationId) => call('POST', '/kroger/products', { terms, locationId }),
    locations: (zip) => call('GET', `/kroger/locations?zip=${encodeURIComponent(zip)}`),
    cartAdd: (items, modality) => call('POST', '/kroger/cart', { items, modality }),
    krogerStatus: () => call('GET', '/kroger/status'),
    oauthStart: (returnTo) => call('POST', '/kroger/oauth/start', { returnTo }),
    krogerDisconnect: () => call('POST', '/kroger/disconnect'),
    library: () => call('GET', '/library'),
    librarySave: (recipe) => call('POST', '/library', { recipe }),
    libraryDelete: (id) => call('DELETE', `/library?id=${encodeURIComponent(id)}`),
    prefs: () => call('GET', '/prefs'),
    prefsUpdate: (prefs) => call('PUT', '/prefs', { prefs }),
  };
}

// Product search for the resolver: chunks terms to the relay's limit and
// returns {term: products[]}.
export function productSearcher(relay, locationId) {
  return async (terms) => {
    const out = {};
    for (let i = 0; i < terms.length; i += 15) {
      const { results } = await relay.products(terms.slice(i, i + 15), locationId);
      Object.assign(out, results);
    }
    return out;
  };
}
