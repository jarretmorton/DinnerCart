import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSetupLink, readSetupLink } from '../web/js/setup-link.js';

const APP = 'https://example.github.io/DinnerCart/';

test('setup link round-trips the device settings', () => {
  const settings = { relayUrl: 'https://relay.example.workers.dev', relayPassword: 'pä$$/+=word', geminiKey: 'AIza-123' };
  const link = makeSetupLink(APP, settings);
  assert.ok(link.startsWith(`${APP}#setup=`));
  assert.doesNotMatch(link.split('#setup=')[1], /[+/=]/, 'URL-safe');
  assert.deepEqual(readSetupLink(new URL(link).hash), settings);
});

test('setup link leaves out empty fields', () => {
  const link = makeSetupLink(APP, { relayUrl: '', relayPassword: 'secret', geminiKey: '' });
  assert.deepEqual(readSetupLink(new URL(link).hash), { relayPassword: 'secret' });
});

test('not a setup link, or a broken one', () => {
  assert.equal(readSetupLink('#find'), null);
  assert.equal(readSetupLink(''), null);
  assert.equal(readSetupLink('#setup=%%%'), null);
  assert.equal(readSetupLink(new URL(makeSetupLink(APP, { geminiKey: 'k' })).hash), null, 'needs a password');
  assert.equal(readSetupLink(new URL(makeSetupLink(APP, { relayUrl: 'javascript:alert(1)', relayPassword: 'p' })).hash), null);
});
