// localStorage wrappers. Device settings (keys, password) stay here;
// household prefs live on the relay and are only cached here.

const SETTINGS_KEY = 'dinnercart.settings';
const STATE_KEY = 'dinnercart.state';
const PREFS_KEY = 'dinnercart.prefs';
const IDEAS_KEY = 'dinnercart.ideas';

export const DEFAULT_PANTRY = [
  'salt', 'black pepper', 'olive oil', 'vegetable oil', 'cooking spray', 'all-purpose flour', 'granulated sugar',
  'brown sugar', 'baking soda', 'baking powder', 'vanilla extract', 'soy sauce', 'garlic powder', 'onion powder',
  'dried oregano', 'ground cumin', 'chili powder', 'paprika', 'red pepper flakes', 'water',
];

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('localStorage write failed', err);
  }
}

export const loadSettings = () => ({ relayUrl: '', relayPassword: '', geminiKey: '', ...read(SETTINGS_KEY, {}) });
export const saveSettings = (s) => write(SETTINGS_KEY, s);

export const loadState = () => read(STATE_KEY, {});
export const saveState = (s) => write(STATE_KEY, s);

export const DEFAULT_MIN_RATING = 4;
export const DEFAULT_MAX_MINUTES = 30;
export const DEFAULT_SERVINGS = 4;
export const loadPrefs = () => ({
  store: null, pantry: DEFAULT_PANTRY, modality: 'PICKUP',
  minRating: DEFAULT_MIN_RATING, maxMinutes: DEFAULT_MAX_MINUTES, servings: DEFAULT_SERVINGS, easy: false, leaveOut: [],
  ...read(PREFS_KEY, {}),
});
export const savePrefs = (p) => write(PREFS_KEY, p);

// Today's Gemini-generated "What sounds good?" ideas: {date, ideas}.
export const loadIdeas = () => read(IDEAS_KEY, null);
export const saveIdeas = (v) => write(IDEAS_KEY, v);

// Cook steps written on this device, by recipe URL (newest 40). Saved
// recipes also keep theirs in the shared library on the relay.
const COOK_KEY = 'dinnercart.cook';
const PROGRESS_KEY = 'dinnercart.cookProgress';
const DAY_MS = 86_400_000;

function keepNewest(map, n) {
  return Object.fromEntries(Object.entries(map).sort((a, b) => b[1].at - a[1].at).slice(0, n));
}

export const loadCook = (url) => read(COOK_KEY, {})[url]?.cook || null;
export function saveCook(url, cook) {
  write(COOK_KEY, keepNewest({ ...read(COOK_KEY, {}), [url]: { cook, at: Date.now() } }, 40));
}

// Ticked-off prep and steps while cooking, so a reload doesn't lose your place (kept a day).
export function loadProgress(url) {
  const p = read(PROGRESS_KEY, {})[url];
  return p && Date.now() - p.at < DAY_MS ? p : { prep: [], steps: [] };
}
export function saveProgress(url, { prep, steps }) {
  write(PROGRESS_KEY, keepNewest({ ...read(PROGRESS_KEY, {}), [url]: { prep, steps, at: Date.now() } }, 20));
}
