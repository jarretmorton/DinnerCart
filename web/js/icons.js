// Line icons for the "Tomato & Basil" design: 24px grid, rounded 1.75 strokes,
// drawn in currentColor so they follow the text color (and night mode).
const PATHS = {
  search: '<circle cx="10.5" cy="10.5" r="6.2"/><path d="M15.2 15.2 20 20"/>',
  // Market basket: placeholder for products without a photo.
  basket: '<path d="M3.5 10h17l-1.7 8.4a2 2 0 0 1-2 1.6H7.2a2 2 0 0 1-2-1.6L3.5 10z"/><path d="M7.5 10a4.5 4.5 0 0 1 9 0"/><path d="M9.5 13.5v3M14.5 13.5v3M12 13.5v3"/>',
  // Open-top cart with a shopping list flowing into it (the Pick tab).
  cart: '<path d="M2.5 4.5h2.3l3 12h10.4L21 8"/><circle cx="9.3" cy="20" r="1.5"/><circle cx="16.8" cy="20" r="1.5"/><path d="M8.7 5.6h.01M11.1 5.6h6.6M9.4 9.3h.01M11.8 9.3h5.7M10.1 13h.01M12.5 13h3.2"/>',
  book: '<path d="M12 6.6C10 5.1 7 4.6 3.8 5v13.2c3.2-.4 6.2.1 8.2 1.6 2-1.5 5-2 8.2-1.6V5c-3.2-.4-6.2.1-8.2 1.6z"/><path d="M12 6.6v13.2"/>',
  gear: '<path d="M19.05 10.12 L21.28 10.50 L21.28 13.50 L19.05 13.88 L18.32 15.66 L19.62 17.50 L17.50 19.62 L15.66 18.32 L13.88 19.05 L13.50 21.28 L10.50 21.28 L10.12 19.05 L8.34 18.32 L6.50 19.62 L4.38 17.50 L5.68 15.66 L4.95 13.88 L2.72 13.50 L2.72 10.50 L4.95 10.12 L5.68 8.34 L4.38 6.50 L6.50 4.38 L8.34 5.68 L10.12 4.95 L10.50 2.72 L13.50 2.72 L13.88 4.95 L15.66 5.68 L17.50 4.38 L19.62 6.50 L18.32 8.34 Z"/><circle cx="12" cy="12" r="3.2"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7.8V12l2.8 1.8"/>',
  people: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.6" cy="9.4" r="2.4"/><path d="M15.6 14.1a4.6 4.6 0 0 1 5 4.6"/>',
  star: '<path d="M12 3.8l2.5 5.2 5.7.7-4.2 3.9 1.1 5.6L12 16.4l-5.1 2.8 1.1-5.6-4.2-3.9 5.7-.7L12 3.8z"/>',
  flame: '<path d="M12 20.5c3.4 0 5.8-2.3 5.8-5.6 0-3.4-2.5-5.2-3.5-8.4-.6 1.8-1.7 2.9-2.9 3.4.2-2.5-.7-4.9-2.9-6.4-.3 2.9-2.4 4.8-3.3 7-.9 2.2-.3 4.7 1.2 6.3 1.1 1.1 2.3 1.7 3.6 1.7z"/>',
  check: '<path d="M5 12.6l4.3 4.3L19 7.2"/>',
  bookmark: '<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4.2L6 20V5a1 1 0 0 1 1-1z"/>',
  // Frying pan with steam (Cook).
  pan: '<path d="M2.5 11.8h14v1.8a4.6 4.6 0 0 1-4.6 4.6H7.1a4.6 4.6 0 0 1-4.6-4.6z"/><path d="M16.5 13.1l5-1.6"/><path d="M6.3 9.2c-1.2-1.3 1.2-2.6 0-4.2M9.5 9.2c-1.2-1.3 1.2-2.6 0-4.2M12.7 9.2c-1.2-1.3 1.2-2.6 0-4.2"/>',
  // Model toggle: Strong (anvil) and Light (feather).
  anvil: '<path d="M8 5.5h13v4h-4.6l-.9 3.8 2.8 2.6v3.6H6.7v-3.6l2.8-2.6-.9-3.8C5.8 9.5 3.6 8.6 2.5 6.6 4 5.9 5.8 5.5 8 5.5z"/>',
  feather: '<path d="M20.5 3.5C15 3.5 9.6 6.6 8 12.6L7.2 16l3.4-.5c2-.4 3.8-1.3 5.2-2.6l-3-.5 4.6-1.6c2.2-2.4 3.1-5.1 3.1-7.3z"/><path d="M3.5 20.5l12-12"/>',
  // Twinkle (Recommend).
  sparkle: '<path d="M10 4.5c.6 3.8 2.6 5.8 6.4 6.4-3.8.6-5.8 2.6-6.4 6.4-.6-3.8-2.6-5.8-6.4-6.4 3.8-.6 5.8-2.6 6.4-6.4z"/><path d="M18.3 2.4c.3 1.6 1.2 2.5 2.8 2.8-1.6.3-2.5 1.2-2.8 2.8-.3-1.6-1.2-2.5-2.8-2.8 1.6-.3 2.5-1.2 2.8-2.8z"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7"/><path d="M6.5 7l.9 11.6a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/><path d="M10.2 10.8v5.6M13.8 10.8v5.6"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  bowl: '<path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0z"/><path d="M8 20.5h8"/><path d="M9.5 8c0-1.1 1-1.5 1-2.6M13.5 8c0-1.1 1-1.5 1-2.6"/>',
  bolt: '<path d="M13.2 3 5.5 13.4h5.8L10.5 21l7.9-10.4h-5.9L13.2 3z"/>',
  // Opens another site (e.g. the Fred Meyer cart).
  external: '<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>',
  share: '<path d="M12 14.5v-11"/><path d="M8 7.5l4-4 4 4"/><path d="M8.5 10.5H6.5a1.5 1.5 0 0 0-1.5 1.5v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-2"/>',
  question: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.7"/><path d="M12 16.9v.1"/>',
};

// `filled` fills the shape (e.g. a saved bookmark or rating star).
export function icon(name, { filled = false, label } = {}) {
  const a11y = label ? `role="img" aria-label="${label}"` : 'aria-hidden="true"';
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ${a11y}>${PATHS[name] || ''}</svg>`;
}

// Fill any <span data-icon="name"> placeholders in static HTML.
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
}
