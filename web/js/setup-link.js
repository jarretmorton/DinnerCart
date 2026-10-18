// "Setup link": one tap sets up another phone in the household. It carries
// the relay password (and the relay URL and Gemini key when given) in the
// part of the link after "#", which browsers never send to a server.
// Opening it saves the settings on that device and clears the link from
// the address bar.
const PREFIX = '#setup=';
const FIELDS = { u: 'relayUrl', p: 'relayPassword', g: 'geminiKey' };

const toBase64Url = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (code) => new TextDecoder().decode(
  Uint8Array.from(atob(code.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
);

// appUrl: the page's address without the "#" part.
export function makeSetupLink(appUrl, settings) {
  const data = {};
  for (const [short, key] of Object.entries(FIELDS)) if (settings[key]) data[short] = settings[key];
  return `${appUrl}${PREFIX}${toBase64Url(JSON.stringify(data))}`;
}

// Returns {relayUrl?, relayPassword?, geminiKey?}, or null if the hash isn't a valid setup link.
export function readSetupLink(hash) {
  if (!hash?.startsWith(PREFIX)) return null;
  try {
    const data = JSON.parse(fromBase64Url(hash.slice(PREFIX.length)));
    const out = {};
    for (const [short, key] of Object.entries(FIELDS)) if (typeof data[short] === 'string' && data[short]) out[key] = data[short];
    if (out.relayUrl && !/^https?:\/\//i.test(out.relayUrl)) return null;
    return out.relayPassword ? out : null;
  } catch {
    return null;
  }
}
