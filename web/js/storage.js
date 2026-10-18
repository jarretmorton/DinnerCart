// localStorage wrappers. Device settings (keys, password) stay here;
// household prefs live on the relay and are only cached here.

const SETTINGS_KEY = 'dinnercart.settings';
const STATE_KEY = 'dinnercart.state';
const PREFS_KEY = 'dinnercart.prefs';

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

export const loadSettings = () => ({ relayUrl: '', relayPassword: '', geminiKey: '', geminiModel: '', geminiLightModel: '', ...read(SETTINGS_KEY, {}) });
export const saveSettings = (s) => write(SETTINGS_KEY, s);

export const loadState = () => read(STATE_KEY, {});
export const saveState = (s) => write(STATE_KEY, s);

export const loadPrefs = () => ({ store: null, pantry: DEFAULT_PANTRY, modality: 'PICKUP', ...read(PREFS_KEY, {}) });
export const savePrefs = (p) => write(PREFS_KEY, p);
