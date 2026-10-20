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

// One gate for every request, on both models: a request that shows no sign
// of life (no first piece of the answer) within START_TIMEOUT_MS is stuck,
// and none may take longer than TIMEOUT_MS in all. Running out on the strong
// model switches to the light one. The models tend to send their answer in
// one go after thinking, so the first piece can come late (seen: 10-15 s on
// the free tier); 5 and 15 s cut off requests that would have worked.
// No thinking settings are sent: asking for thought summaries
// (includeThoughts) or a thinking level made the light model think, and its
// replies went from about 1 s to 10-30 s, with no thoughts streamed back.
export const START_TIMEOUT_MS = 30_000;
export const TIMEOUT_MS = 60_000;
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

// Joins streamed chunks into one generateContent-shaped answer. Thought
// summaries (parts marked `thought`) only show it's working; they aren't
// part of the answer.
function mergeChunks(chunks) {
  const error = chunks.find((c) => c?.error)?.error;
  if (error) return { error };
  const text = chunks.flatMap((c) => c?.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  const finishReason = chunks.map((c) => c?.candidates?.[0]?.finishReason).filter(Boolean).at(-1);
  const promptFeedback = chunks.find((c) => c?.promptFeedback)?.promptFeedback;
  return { candidates: [{ content: { parts: [{ text }] }, finishReason }], promptFeedback };
}

const secs = (ms) => Math.round(ms / 1000);

// `model` is a model id, or a switch from createModelSwitch() to fall back
// to the light model when the strong one is rate limited, slow or busy.
// onTiming({model, firstMs, totalMs, outcome, at}) is called after every
// request, for "Check setup" to show how fast Gemini really is.
export function createGemini({ apiKey, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch.bind(globalThis), maxRetries = 4, onTiming = () => {} } = {}) {
  if (!apiKey) throw new GeminiError('Add your Gemini API key in Config.', 0);
  const modelSwitch = typeof model === 'object' && model ? model : null;
  const currentModel = () => (modelSwitch ? modelSwitch.model : model || DEFAULT_MODEL);
  const onStrong = () => modelSwitch?.tier === 'strong';

  // One streamed request. The answer comes in pieces as Gemini writes it
  // (long answers in several, short ones often in one), so a request that's working
  // can be told from one that's stuck: no first piece within startTimeoutMs
  // (when set), or no finished answer within timeoutMs, aborts it with a
  // GeminiError (status 'timeout'). onStage('thinking' | 'writing') reports
  // what the pieces show.
  async function send(body, { timeoutMs, startTimeoutMs, onStage, stream = true }) {
    const modelId = currentModel();
    const ctrl = new AbortController();
    const started = Date.now();
    let firstMs = null;
    let stage = null;
    let fail;
    const timedOut = new Promise((_, reject) => { fail = reject; });
    const stop = (message, kind) => {
      ctrl.abort();
      fail(Object.assign(new GeminiError(message, 'timeout'), { kind }));
    };
    const timers = [setTimeout(() => stop(`Gemini didn't finish within ${secs(timeoutMs)} seconds. Try again in a moment.`, 'too-slow'), timeoutMs)];
    if (startTimeoutMs) {
      timers.push(setTimeout(() => {
        if (firstMs == null) stop(`Gemini didn't start answering within ${secs(startTimeoutMs)} seconds. Try again in a moment.`, 'no-start');
      }, startTimeoutMs));
    }
    const alive = (next) => {
      if (firstMs == null) firstMs = Date.now() - started;
      if (next !== stage) {
        stage = next;
        onStage?.(next);
      }
    };

    const go = async () => {
      let res;
      try {
        const method = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
        res = await fetchImpl(`${API}/${encodeURIComponent(modelId)}:${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (ctrl.signal.aborted) throw err;
        throw new GeminiError(`Couldn't reach Gemini (${err.message}). Check the connection and try again.`, 'network');
      }
      // Errors (limits, bad key) come back whole, straight away.
      if (!res.ok) return { res, data: await res.json().catch(() => ({})) };
      if (!/event-stream/i.test(res.headers.get('content-type') || '') || !res.body?.getReader) {
        // Not streamed after all: one answer, or a JSON list of chunks.
        const raw = await res.json().catch(() => ({}));
        alive('writing');
        return { res, data: mergeChunks(Array.isArray(raw) ? raw : [raw]) };
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const chunks = [];
      let buf = '';
      const take = (event) => {
        const payload = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (!payload) return;
        let chunk;
        try { chunk = JSON.parse(payload); } catch { return; }
        chunks.push(chunk);
        const parts = chunk.candidates?.[0]?.content?.parts || [];
        alive(parts.some((p) => !p.thought && p.text) ? 'writing' : (stage || 'thinking'));
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        for (let i; (i = buf.indexOf('\n\n')) >= 0;) {
          take(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      }
      take(buf);
      return { res, data: mergeChunks(chunks) };
    };

    const timing = (outcome) => onTiming({ model: modelId, firstMs, totalMs: Date.now() - started, outcome, at: Date.now() });
    try {
      const out = await Promise.race([go(), timedOut]);
      const status = out.data?.error?.code || out.res.status;
      timing(status === 429 ? 'limit' : status >= 400 ? 'error' : 'ok');
      return out;
    } catch (err) {
      timing(err.kind || 'error');
      throw err;
    } finally {
      timers.forEach(clearTimeout);
    }
  }

  // Ask for JSON matching `schema` (OpenAPI-style subset Gemini accepts).
  // startTimeoutMs: its first piece; timeoutMs: the whole answer (see the
  // constants above). On the strong model, either one running out switches
  // to the light model and asks again.
  // stream: false asks with the regular (one-piece) request instead, for
  // Check setup's speed comparison.
  async function json(prompt, schema, { system, temperature = 0.2, timeoutMs = TIMEOUT_MS, startTimeoutMs = START_TIMEOUT_MS, onStage, stream = true } = {}) {
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    for (let attempt = 0; ; attempt++) {
      let res;
      let data;
      try {
        ({ res, data } = await send(body, { timeoutMs, startTimeoutMs, onStage, stream }));
      } catch (err) {
        // Strong model stuck or slow: try the light one now.
        if (err.status === 'timeout' && onStrong()) {
          modelSwitch.downgrade({ reason: 'slow' });
          attempt--;
          continue;
        }
        throw err;
      }
      // An error can also arrive inside the stream.
      const status = data?.error?.code || res.status;
      if (status === 429) {
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
      if (status >= 500) {
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
        throw new GeminiError(`Gemini is having trouble right now (error ${status}). Try again in a minute.`, status);
      }
      if (status >= 400) {
        const message = data?.error?.message || res.statusText;
        if (/api key/i.test(message) || status === 401 || status === 403) {
          throw new GeminiError("Gemini doesn't accept this API key. Check it in Config.", status);
        }
        throw new GeminiError(`Gemini ${status}: ${message}`, status);
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

// For "Check setup": per model, how fast the recent requests on this device
// started and finished, and how many ran out of time or hit a limit.
export function summarizeTimings(records = []) {
  const median = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
  };
  const byModel = new Map();
  for (const r of records) {
    if (!byModel.has(r.model)) byModel.set(r.model, []);
    byModel.get(r.model).push(r);
  }
  return [...byModel].map(([model, rs]) => {
    const firsts = rs.map((r) => r.firstMs).filter((x) => x != null);
    const done = rs.filter((r) => r.outcome === 'ok').map((r) => r.totalMs);
    return {
      model,
      count: rs.length,
      firstTypical: median(firsts),
      firstSlowest: firsts.length ? Math.max(...firsts) : null,
      doneTypical: median(done),
      doneSlowest: done.length ? Math.max(...done) : null,
      noStart: rs.filter((r) => r.outcome === 'no-start').length,
      tooSlow: rs.filter((r) => r.outcome === 'too-slow').length,
      limit: rs.filter((r) => r.outcome === 'limit').length,
    };
  });
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
