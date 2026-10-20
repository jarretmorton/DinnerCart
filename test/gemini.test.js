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
  await assert.rejects(stuck.json('p', {}, { timeoutMs: 30 }), /Gemini didn't answer within 0 seconds\. Try again in a moment\./);
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
