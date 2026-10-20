import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGemini, createModelSwitch, retryDelayMs, waitText } from '../web/js/gemini.js';

const ok = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
const modelOf = (url) => decodeURIComponent(url.split('/models/')[1].split(':')[0]);
// The free tier's daily-limit answer, as Gemini sends it.
const dailyLimit = () => new Response(JSON.stringify({ error: {
  code: 429,
  message: 'You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20',
  details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '14389.4s' },
  ],
} }), { status: 429 });
const switchLog = (opts = {}) => {
  const changes = [];
  const sw = createModelSwitch({ strong: 'strong-m', light: 'light-m', onChange: (...c) => changes.push(c), ...opts });
  return { sw, changes };
};

test('daily limit: strong drops to light at once, remembering when it resets; both used up says so plainly', async () => {
  const { sw, changes } = switchLog();
  const called = [];
  let lightLimited = false;
  const fetchImpl = async (url) => {
    called.push(modelOf(url));
    return modelOf(url) === 'strong-m' || lightLimited ? dailyLimit() : ok();
  };
  const g = createGemini({ apiKey: 'k', model: sw, fetchImpl });
  const before = Date.now();
  assert.deepEqual(await g.json('p', {}), { ok: true });
  assert.deepEqual(called, ['strong-m', 'light-m']);
  const [tier, model, reason, until] = changes[0];
  assert.deepEqual([tier, model, reason], ['light', 'light-m', 'limit']);
  assert.ok(until >= before + 14_389_000 && until <= Date.now() + 14_390_000, 'reset time from RetryInfo');

  lightLimited = true;
  const started = Date.now();
  await assert.rejects(g.json('p', {}), (err) => err.status === 429 && /free daily limit is used up on both models\. It resets in about 4 hours/.test(err.message));
  assert.ok(Date.now() - started < 1000, 'no waiting hours for a daily limit');
});

test('a strong model that never answers times out and drops to light; light timing out is a clear error', async () => {
  const { sw, changes } = switchLog();
  let aborted = false;
  const hang = (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }));
  const g = createGemini({ apiKey: 'k', model: sw, fetchImpl: async (url, init) => (modelOf(url) === 'strong-m' ? hang(init) : ok()) });
  assert.deepEqual(await g.json('p', {}, { timeoutMs: 30 }), { ok: true });
  assert.ok(aborted, 'the hung request is cancelled');
  assert.deepEqual(changes.map((c) => c.slice(0, 3)), [['light', 'light-m', 'slow']]);
  assert.equal(changes[0][3], null, 'only until reload');

  const stuck = createGemini({ apiKey: 'k', model: 'light-m', fetchImpl: async (_url, init) => hang(init) });
  await assert.rejects(stuck.json('p', {}, { timeoutMs: 30 }), /Gemini didn't finish within 0 seconds\. Try again in a moment\./);
});

test('an overloaded strong model gets one more try, then light', async () => {
  const { sw, changes } = switchLog();
  const called = [];
  const g = createGemini({ apiKey: 'k', model: sw, fetchImpl: async (url) => { called.push(modelOf(url)); return modelOf(url) === 'strong-m' ? new Response('{}', { status: 503 }) : ok(); } });
  assert.deepEqual(await g.json('p', {}), { ok: true });
  assert.deepEqual(called, ['strong-m', 'strong-m', 'light-m']);
  assert.equal(changes[0][2], 'busy');
});

test('plain errors: bad key, offline, per-minute limit', async () => {
  const badKey = createGemini({ apiKey: 'k', model: 'm', fetchImpl: async () => new Response('{"error":{"message":"API key not valid. Please pass a valid API key."}}', { status: 400 }) });
  await assert.rejects(badKey.json('p', {}), /doesn't accept this API key\. Check it in Config/);
  const offline = createGemini({ apiKey: 'k', model: 'm', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.json('p', {}), /Couldn't reach Gemini \(Failed to fetch\)/);
  const busy = createGemini({ apiKey: 'k', model: 'm', maxRetries: 0, fetchImpl: async () => new Response('{"error":{"message":"Resource exhausted"}}', { status: 429 }) });
  await assert.rejects(busy.json('p', {}), /too many requests right now\. Wait a minute/);
});

test('a switch can start on light (strong paused); helpers', () => {
  assert.equal(createModelSwitch({ initial: 'light' }).tier, 'light');
  assert.equal(createModelSwitch().tier, 'strong');
  assert.equal(retryDelayMs({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42s' }] } }), 42_000);
  assert.equal(retryDelayMs({}, new Headers({ 'retry-after': '3' })), 3000);
  assert.equal(waitText(14_389_000), 'about 4 hours');
  assert.equal(waitText(20 * 60_000), 'about 20 minutes');
  assert.equal(waitText(10_000), 'about 1 minute');
});

// A streamed answer: Server-Sent Events, delivered in arbitrary pieces.
const sse = (events, { pause = 0 } = {}) => {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({
    async start(ctrl) {
      for (let i = 0; i < bytes.length; i += 37) { // split mid-event on purpose
        ctrl.enqueue(bytes.slice(i, i + 37));
        if (pause) await new Promise((r) => setTimeout(r, pause));
      }
      ctrl.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const textChunk = (text) => ({ candidates: [{ content: { parts: [{ text }] } }] });

test('streams: thoughts then text, stages reported, answer joined, timing recorded', async () => {
  const seen = [];
  const timings = [];
  const stages = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return sse([
      { candidates: [{ content: { parts: [{ text: 'Planning queries', thought: true }] } }] },
      textChunk('{"queries": ["sweet potato'),
      textChunk(' chili", "black bean chili"]}'),
      { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
    ]);
  };
  const g = createGemini({ apiKey: 'k', model: 'm', fetchImpl, onTiming: (t) => timings.push(t) });
  const out = await g.json('p', {}, { stream: true, onStage: (s) => stages.push(s) });
  assert.deepEqual(out, { queries: ['sweet potato chili', 'black bean chili'] }, 'thought text left out');
  assert.match(seen[0].url, /\/models\/m:streamGenerateContent\?alt=sse$/);
  assert.equal(seen[0].body.generationConfig.thinkingConfig, undefined, 'no thinking settings: they slowed the light model down');
  assert.deepEqual(stages, ['thinking', 'writing']);
  assert.equal(timings.length, 1);
  assert.equal(timings[0].model, 'm');
  assert.equal(timings[0].outcome, 'ok');
  assert.ok(timings[0].firstMs != null && timings[0].firstMs <= timings[0].totalMs);
});

test('no first piece within the start limit: strong drops to light; Match-style calls can opt out', async () => {
  const { sw, changes } = switchLog();
  const timings = [];
  // Strong: accepted (headers), then silence.
  const silent = (init) => new Response(new ReadableStream({ start(ctrl) { init.signal.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError'))); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const fetchImpl = async (url, init) => (modelOf(url) === 'strong-m' ? silent(init) : sse([textChunk('{"ok":true}')]));
  const g = createGemini({ apiKey: 'k', model: sw, fetchImpl, onTiming: (t) => timings.push(t) });
  const started = Date.now();
  assert.deepEqual(await g.json('p', {}, { startTimeoutMs: 40, timeoutMs: 5000 }), { ok: true });
  assert.ok(Date.now() - started < 1000, 'gave up on the start limit, not the 5 s one');
  assert.deepEqual(changes.map((c) => c[2]), ['slow']);
  assert.deepEqual(timings.map((t) => [t.model, t.outcome]), [['strong-m', 'no-start'], ['light-m', 'ok']]);

  // A slow starter is fine when the call opts out of the start limit.
  const slowStart = createGemini({ apiKey: 'k', model: 'm', fetchImpl: async () => { await new Promise((r) => setTimeout(r, 80)); return sse([textChunk('{"ok":true}')]); } });
  assert.deepEqual(await slowStart.json('p', {}, { startTimeoutMs: null, timeoutMs: 2000 }), { ok: true });
  // And a stream that starts but never finishes hits the overall limit.
  const neverDone = createGemini({ apiKey: 'k', model: 'm', fetchImpl: async (_u, init) => silent(init) });
  await assert.rejects(neverDone.json('p', {}, { startTimeoutMs: null, timeoutMs: 60 }), /didn't finish within 0 seconds/);
});

test('an error inside the stream counts like any other (a daily limit here)', async () => {
  const { sw, changes } = switchLog();
  const inStream = createGemini({ apiKey: 'k', model: sw, fetchImpl: async (url) => (modelOf(url) === 'strong-m'
    ? sse([{ error: { code: 429, message: 'Quota exceeded for metric: free_tier_requests', details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' }] } }])
    : sse([textChunk('{"ok":true}')])) });
  assert.deepEqual(await inStream.json('p', {}), { ok: true });
  assert.equal(changes[0][2], 'limit');
  assert.ok(changes[0][3] > Date.now() + 3_500_000, 'daily limit remembered');
});

test('summarizeTimings: per model, typical and slowest, trouble counted', async () => {
  const { summarizeTimings } = await import('../web/js/gemini.js');
  const rs = [
    { model: 's', firstMs: 1000, totalMs: 6000, outcome: 'ok' },
    { model: 's', firstMs: 3000, totalMs: 9000, outcome: 'ok' },
    { model: 's', firstMs: null, totalMs: 5000, outcome: 'no-start' },
    { model: 'l', firstMs: 400, totalMs: 1200, outcome: 'ok' },
    { model: 'l', firstMs: null, totalMs: 100, outcome: 'limit' },
  ];
  const [s, l] = summarizeTimings(rs);
  assert.deepEqual(s, { model: 's', count: 3, firstTypical: 1000, firstSlowest: 3000, doneTypical: 6000, doneSlowest: 9000, noStart: 1, tooSlow: 0, limit: 0 });
  assert.equal(l.limit, 1);
  assert.equal(l.doneTypical, 1200);
});

test('one gate: 30 s to show a sign of life, a minute in all; a long answer that has started may run past the first', async () => {
  const { START_TIMEOUT_MS, TIMEOUT_MS } = await import('../web/js/gemini.js');
  assert.equal(START_TIMEOUT_MS, 30_000);
  assert.equal(TIMEOUT_MS, 60_000);
  // Starts at once, then keeps writing for longer than the start limit.
  const slowWriter = async () => {
    const enc = new TextEncoder();
    const piece = (t) => enc.encode(`data: ${JSON.stringify(textChunk(t))}\r\n\r\n`);
    return new Response(new ReadableStream({
      async start(ctrl) {
        ctrl.enqueue(piece('{"ok":'));
        await new Promise((r) => setTimeout(r, 120));
        ctrl.enqueue(piece('true}'));
        ctrl.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const g = createGemini({ apiKey: 'k', model: 'm', fetchImpl: slowWriter });
  assert.deepEqual(await g.json('p', {}, { startTimeoutMs: 40, timeoutMs: 1000 }), { ok: true });
});

test('regular requests by default; stream: true streams', async () => {
  const urls = [];
  const g = createGemini({ apiKey: 'k', model: 'm', fetchImpl: async (url) => { urls.push(url); return ok(); } });
  assert.deepEqual(await g.json('p', {}), { ok: true });
  assert.match(urls[0], /\/models\/m:generateContent$/);
  await g.json('p', {}, { stream: true });
  assert.match(urls[1], /\/models\/m:streamGenerateContent\?alt=sse$/);
});

test('listModels and pickTestModels: numbered Flash-Lite versions first, no previews or special models', async () => {
  const { listModels, pickTestModels } = await import('../web/js/gemini.js');
  let seenUrl;
  const models = await listModels({ apiKey: 'k', fetchImpl: async (url, init) => {
    seenUrl = url;
    assert.equal(init.headers['x-goog-api-key'], 'k');
    return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.0-flash-lite-001', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-flash-lite-latest', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.9-flash-lite-preview', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] }), { status: 200 });
  } });
  assert.match(seenUrl, /\/v1beta\/models\?pageSize=1000$/);
  assert.ok(!models.includes('text-embedding-004'), 'only models that can answer');
  assert.deepEqual(pickTestModels(models), ['gemini-3.8-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite-001']);
  assert.deepEqual(pickTestModels(['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'], 3), ['gemini-2.5-flash-lite', 'gemini-3.8-flash', 'gemini-2.5-flash']);
});
