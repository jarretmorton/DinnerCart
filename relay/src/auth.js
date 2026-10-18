import { HttpError, sha256Hex } from './http.js';

export const PASSWORD_HEADER = 'x-relay-password';

// Compare SHA-256 digests so the comparison time doesn't depend on where the
// strings first differ.
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

export async function requirePassword(request, env) {
  if (!env.RELAY_PASSWORD) {
    throw new HttpError(500, 'not_configured', 'RELAY_PASSWORD secret is not set on the Worker.');
  }
  const given = request.headers.get(PASSWORD_HEADER) || '';
  if (!given || !(await safeEqual(given, env.RELAY_PASSWORD))) {
    throw new HttpError(401, 'bad_password', 'Missing or wrong relay password.');
  }
}

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'access-control-allow-headers': `content-type, ${PASSWORD_HEADER}`,
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

// The OAuth return URL must point back at the app, never somewhere arbitrary.
export function isAllowedReturnUrl(url, env) {
  try {
    const u = new URL(url);
    return allowedOrigins(env).includes(u.origin);
  } catch {
    return false;
  }
}
