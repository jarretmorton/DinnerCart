// Kroger product helpers shared by the browser (direct product search) and
// the relay (relay/src/kroger.js imports this file; wrangler bundles it).

export const KROGER_API = 'https://api.kroger.com/v1';

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

// Kroger requires 3+ characters and at most 8 words.
export function cleanTerm(term) {
  return String(term || '').replace(/[^\p{L}\p{N}\s&'-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
}
