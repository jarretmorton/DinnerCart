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
export const DEFAULT_EASY_MAX_INGREDIENTS = 10;
export const DEFAULT_EASY_MAX_STEPS = 8;
export const loadPrefs = () => ({
  store: null, pantry: DEFAULT_PANTRY, modality: 'PICKUP',
  minRating: DEFAULT_MIN_RATING, maxMinutes: DEFAULT_MAX_MINUTES, servings: DEFAULT_SERVINGS, easy: false,
  easyMaxIngredients: DEFAULT_EASY_MAX_INGREDIENTS, easyMaxSteps: DEFAULT_EASY_MAX_STEPS, leaveOut: [],
  ...read(PREFS_KEY, {}),
});
export const savePrefs = (p) => write(PREFS_KEY, p);

// While the strong model's free daily limit is used up: when it resets (ms).
const STRONG_PAUSE_KEY = 'dinnercart.strongPausedUntil';
export const loadStrongPausedUntil = () => Number(read(STRONG_PAUSE_KEY, 0)) || 0;
export const saveStrongPausedUntil = (ms) => write(STRONG_PAUSE_KEY, ms);

// The last 40 Gemini requests on this device, for "Check setup":
// {model, firstMs, totalMs, outcome, at}.
const TIMINGS_KEY = 'dinnercart.geminiTimings';
export const loadGeminiTimings = () => read(TIMINGS_KEY, []);
export const addGeminiTiming = (t) => write(TIMINGS_KEY, [...loadGeminiTimings(), t].slice(-40));

// Models Gemini lists but won't answer from ("no longer available to new
// users"), so "Test Gemini speed" skips them.
const RETIRED_KEY = 'dinnercart.retiredModels';
export const loadRetiredModels = () => read(RETIRED_KEY, []);
export const addRetiredModel = (name) => write(RETIRED_KEY, [...new Set([...loadRetiredModels(), name])]);

// Sign out: forget everything DinnerCart keeps on this device (all its
// keys start with "dinnercart."). Household data on the relay stays.
export function clearDevice() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('dinnercart.')) localStorage.removeItem(k);
  } catch (err) {
    console.warn('localStorage clear failed', err);
  }
}

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
