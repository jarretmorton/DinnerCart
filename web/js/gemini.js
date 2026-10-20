// Minimal Gemini client (Google AI Studio key), called straight from the
// browser. Works in Node too, for the eval script.

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
export const DEFAULT_MODEL = 'gemini-flash-latest';
export const LIGHT_MODEL = 'gemini-flash-lite-latest';

export class GeminiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A request with no answer by then is given up on (and the strong model
// drops to the light one), instead of a spinner that never stops.
export const TIMEOUT_MS = 30_000;
// A limit that lifts later than this is the free tier's daily limit, not
// the per-minute one: no point waiting for it.
const LONG_WAIT_MS = 120_000;

// "about 4 hours", "about 20 minutes".
export function waitText(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `about ${min} minute${min === 1 ? '' : 's'}`;
  const hrs = Math.round(min / 60);
  return `about ${hrs} hour${hrs === 1 ? '' : 's'}`;
}

// How long Gemini says to wait before retrying: its RetryInfo detail
// ("14389.4s"), else a Retry-After header (browsers usually can't read it).
export function retryDelayMs(data, headers) {
  const info = (data?.error?.details || []).find((d) => /RetryInfo$/.test(d?.['@type'] || ''));
  const secs = parseFloat(info?.retryDelay) || Number(headers?.get?.('retry-after')) || 0;
  return Math.max(0, secs * 1000);
}

const isDailyLimit = (data, waitMs) => waitMs > LONG_WAIT_MS || /PerDay|per day|daily/i.test(JSON.stringify(data?.error || ''));

// Strong/light model pair. Starts strong (or light while `initial` says so);
// `downgrade()` is called when the strong model hits its limit, times out or
// is overloaded. A plain downgrade lasts until reload; one with `until`
// (the daily limit) is for the app to remember across reloads.
export function createModelSwitch({ strong = DEFAULT_MODEL, light = LIGHT_MODEL, initial = 'strong', onChange = () => {} } = {}) {
  let tier = initial === 'light' ? 'light' : 'strong';
  const sw = {
    get tier() { return tier; },
    get model() { return tier === 'strong' ? strong : light; },
    // reason: 'manual' (user toggled), 'limit', 'slow' or 'busy' (automatic).
    set(next, reason = 'manual', until = null) {
      if (next === tier || (next !== 'strong' && next !== 'light')) return;
      tier = next;
      onChange(tier, sw.model, reason, until);
    },
    downgrade({ reason = 'limit', until = null } = {}) { sw.set('light', reason, until); },
  };
  return sw;
}

// `model` is a model id, or a switch from createModelSwitch() to fall back
// to the light model when the strong one is rate limited.
export function createGemini({ apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch.bind(globalThis), maxRetries = 4 } = {}) {
  if (!apiKey) throw new GeminiError('Add your Gemini API key in Config.', 0);
  const modelSwitch = typeof model === 'object' && model ? model : null;
  const currentModel = () => (modelSwitch ? modelSwitch.model : model || DEFAULT_MODEL);

  const onStrong = () => modelSwitch?.tier === 'strong';

  // One request, answer read in full, or a GeminiError (timeout, offline).
  async function send(body, timeoutMs) {
    const ctrl = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new GeminiError(`Gemini didn't answer within ${Math.round(timeoutMs / 1000)} seconds. Try again in a moment.`, 'timeout'));
      }, timeoutMs);
    });
    const go = async () => {
      let res;
      try {
        res = await fetchImpl(`${API}/${encodeURIComponent(currentModel())}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (ctrl.signal.aborted) throw err;
        throw new GeminiError(`Couldn't reach Gemini (${err.message}). Check the connection and try again.`, 'network');
      }
      const data = await res.json().catch(() => ({}));
      return { res, data };
    };
    try {
      return await Promise.race([go(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Ask for JSON matching `schema` (OpenAPI-style subset Gemini accepts).
  async function json(prompt, schema, { system, temperature = 0.2, timeoutMs = TIMEOUT_MS } = {}) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    for (let attempt = 0; ; attempt++) {
      let res;
      let data;
      try {
        ({ res, data } = await send(body, timeoutMs));
      } catch (err) {
        // Strong model not answering: try the light one now.
        if (err.status === 'timeout' && onStrong()) {
          modelSwitch.downgrade({ reason: 'slow' });
          attempt--;
          continue;
        }
        throw err;
      }
      if (res.status === 429) {
        const waitMs = retryDelayMs(data, res.headers);
        const daily = isDailyLimit(data, waitMs);
        if (onStrong()) {
          // Strong model's limit hit: switch to the light model and retry now.
          modelSwitch.downgrade({ reason: 'limit', until: daily ? Date.now() + (waitMs || 86_400_000) : null });
          attempt--;
          continue;
        }
        if (!daily && attempt < maxRetries) {
          // The per-minute limit: wait it out.
          await sleep(Math.max(waitMs, 2000 * 2 ** attempt));
          continue;
        }
        throw new GeminiError(daily
          ? `Gemini's free daily limit is used up${modelSwitch ? ' on both models' : ''}. It resets in ${waitText(waitMs || 86_400_000)}. Adding billing to the Gemini key raises the limit.`
          : 'Gemini is getting too many requests right now. Wait a minute and try again.', 429);
      }
      if (res.status >= 500) {
        // Overloaded: one more try on the strong model, then the light one.
        if (onStrong() && attempt >= 1) {
          modelSwitch.downgrade({ reason: 'busy' });
          attempt--;
          continue;
        }
        if (attempt < maxRetries) {
          await sleep(2000 * 2 ** attempt);
          continue;
        }
        throw new GeminiError(`Gemini is having trouble right now (error ${res.status}). Try again in a minute.`, res.status);
      }
      if (!res.ok) {
        const message = data?.error?.message || res.statusText;
        if (/api key/i.test(message) || res.status === 401 || res.status === 403) {
          throw new GeminiError("Gemini doesn't accept this API key. Check it in Config.", res.status);
        }
        throw new GeminiError(`Gemini ${res.status}: ${message}`, res.status);
      }
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.map((p) => p.text || '').join('') || '';
      if (!text) {
        if (attempt < maxRetries) continue;
        throw new GeminiError(`Gemini returned no text (${candidate?.finishReason || data.promptFeedback?.blockReason || 'unknown'}).`, 200);
      }
      try {
        return JSON.parse(text);
      } catch {
        if (attempt < maxRetries) continue;
        throw new GeminiError('Gemini returned invalid JSON.', 200);
      }
    }
  }

  return { json, get model() { return currentModel(); } };
}

// Schema helpers to keep prompts readable.
export const S = {
  obj: (properties, required = Object.keys(properties)) => ({ type: 'OBJECT', properties, required }),
  arr: (items) => ({ type: 'ARRAY', items }),
  str: (description) => ({ type: 'STRING', ...(description && { description }) }),
  num: (description) => ({ type: 'NUMBER', ...(description && { description }) }),
  int: (description) => ({ type: 'INTEGER', ...(description && { description }) }),
  bool: (description) => ({ type: 'BOOLEAN', ...(description && { description }) }),
  nullable: (schema) => ({ ...schema, nullable: true }),
  enum: (values, description) => ({ type: 'STRING', enum: values, ...(description && { description }) }),
};
