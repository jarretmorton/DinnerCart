// Fred Meyer product search and store lookup, through the relay. Kroger's API
// doesn't send the CORS header a browser needs to read its answers, so the
// phone can't ask Kroger directly.
import { isZip } from './kroger-shared.js';

// Chunks to the relay's limit and returns {term: products[]}, or
// {term: {error}} when that search failed.
export function productSearcher(relay, locationId) {
  return async (terms) => {
    const out = {};
    for (let i = 0; i < terms.length; i += 15) {
      const { results, errors = {} } = await relay.products(terms.slice(i, i + 15), locationId);
      for (const [term, products] of Object.entries(results)) out[term] = errors[term] ? { error: errors[term] } : products;
    }
    return out;
  };
}

// Nearby Fred Meyer stores.
export async function findStores(relay, zip) {
  if (!isZip(zip)) throw new Error('Enter a 5-digit ZIP code.');
  return (await relay.locations(zip)).locations;
}
