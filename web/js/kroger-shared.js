// Kroger product and store helpers for the relay (relay/src/kroger.js
// imports this file; wrangler bundles it). The browser uses isZip.

export function normalizeProduct(p) {
  const item = p.items?.[0] || {};
  const images = p.images || [];
  const front = images.find((i) => i.perspective === 'front') || images[0];
  const sizes = front?.sizes || [];
  const image = (sizes.find((s) => s.size === 'medium') || sizes.find((s) => s.size === 'small') || sizes[0])?.url || null;
  const promo = Number(item.price?.promo) || null;
  return {
    productId: p.productId,
    upc: p.upc,
    brand: p.brand || null,
    description: p.description || '',
    size: item.size || null,
    soldBy: item.soldBy || null,
    price: Number(item.price?.regular) || null,
    promoPrice: promo,
    inStock: item.inventory?.stockLevel ? item.inventory.stockLevel !== 'TEMPORARILY_OUT_OF_STOCK' : null,
    stockLevel: item.inventory?.stockLevel || null,
    image,
    aisle: p.aisleLocations?.[0]?.description || null,
    categories: p.categories || [],
  };
}

// Store lookup: the query for Kroger's /locations, and the stores to offer.
// Kroger's chain codes don't match brand names ("FRED MEYER" finds nothing),
// so search every Kroger-family store nearby and keep the Fred Meyer ones by
// name/chain. If none are nearby, return everything so the user still has a choice.
export const isZip = (zip) => /^\d{5}$/.test(String(zip || ''));
export const locationsQuery = (zip) => new URLSearchParams({ 'filter.zipCode.near': zip, 'filter.limit': '50', 'filter.radiusInMiles': '25' });

export function pickLocations(data, brand = /fred/i) {
  const all = (data?.data || [])
    .filter((l) => !/fuel|gas station/i.test(l.name || ''))
    .map((l) => ({
      locationId: l.locationId,
      chain: l.chain,
      name: l.name,
      address: [l.address?.addressLine1, l.address?.city, l.address?.state, l.address?.zipCode].filter(Boolean).join(', '),
    }));
  const matching = all.filter((l) => brand.test(`${l.chain} ${l.name}`));
  return (matching.length ? matching : all).slice(0, 15);
}

// Kroger requires 3+ characters and at most 8 words.
export function cleanTerm(term) {
  return String(term || '').replace(/[^\p{L}\p{N}\s&'-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
}
