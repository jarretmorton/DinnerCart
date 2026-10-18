// Test doubles for the Worker environment.

export class FakeKV {
  constructor() { this.map = new Map(); this.ttls = new Map(); }
  async get(key, type) {
    const v = this.map.get(key);
    if (v == null) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value, opts) {
    this.map.set(key, value);
    if (opts?.expirationTtl) this.ttls.set(key, opts.expirationTtl);
  }
  async delete(key) { this.map.delete(key); }
}

export function makeEnv(overrides = {}) {
  return {
    DC_KV: new FakeKV(),
    RELAY_PASSWORD: 'hunter2',
    BRAVE_API_KEY: 'brave-key',
    KROGER_CLIENT_ID: 'client-id',
    KROGER_CLIENT_SECRET: 'client-secret',
    ALLOWED_ORIGINS: 'https://example.github.io,http://localhost:8080',
    APP_URL: 'https://example.github.io/DinnerCart/',
    ...overrides,
  };
}

// Routes fetch calls to handlers by URL prefix; records every call.
export function mockFetch(handlers) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [prefix, handler] of handlers) {
      if (String(url).startsWith(prefix)) return handler(String(url), init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  fn.calls = calls;
  return fn;
}

export const jsonRes = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
