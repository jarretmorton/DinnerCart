// Small helpers shared by the relay's route handlers.

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  console.error(err);
  return json({ error: { code: 'internal', message: String(err?.message || err) } }, 500);
}

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'bad_json', 'Request body must be JSON.');
  }
}

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomHex(byteCount = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// fetch() with a timeout. Workers support AbortSignal.timeout.
export function fetchWithTimeout(fetchImpl, url, init = {}, ms = 10000) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(ms) });
}
