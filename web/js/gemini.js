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

// Strong/light model pair. Starts strong; `downgrade()` is called when the
// strong model hits its rate limit. Lives only in memory, so a page reload
// starts on the strong model again.
export function createModelSwitch({ strong = DEFAULT_MODEL, light = LIGHT_MODEL, onChange = () => {} } = {}) {
  let tier = 'strong';
  const sw = {
    get tier() { return tier; },
    get model() { return tier === 'strong' ? strong : light; },
    // reason: 'manual' (user toggled) or 'limit' (automatic fallback).
    set(next, reason = 'manual') {
      if (next === tier || (next !== 'strong' && next !== 'light')) return;
      tier = next;
      onChange(tier, sw.model, reason);
    },
    downgrade() { sw.set('light', 'limit'); },
  };
  return sw;
}

// `model` is a model id, or a switch from createModelSwitch() to fall back
// to the light model when the strong one is rate limited.
export function createGemini({ apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch.bind(globalThis), maxRetries = 4 } = {}) {
  if (!apiKey) throw new GeminiError('Add your Gemini API key in Settings.', 0);
  const modelSwitch = typeof model === 'object' && model ? model : null;
  const currentModel = () => (modelSwitch ? modelSwitch.model : model || DEFAULT_MODEL);

  // Ask for JSON matching `schema` (OpenAPI-style subset Gemini accepts).
  async function json(prompt, schema, { system, temperature = 0.2 } = {}) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };

    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(`${API}/${encodeURIComponent(currentModel())}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
      if (res.status === 429 && modelSwitch?.tier === 'strong') {
        // Strong model's limit hit: switch to the light model and retry now.
        modelSwitch.downgrade();
        attempt--;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        // Free tier is rate limited per minute; back off and retry.
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        await sleep(Math.max(retryAfter * 1000, 2000 * 2 ** attempt));
        continue;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new GeminiError(`Gemini ${res.status}: ${data?.error?.message || res.statusText}`, res.status);
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
