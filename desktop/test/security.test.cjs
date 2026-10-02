'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { isApplicationURL, isAllowedResource, authenticatedHeaders, backendEnvironment, CONTENT_SECURITY_POLICY } = require('../security.cjs');
const origin = 'http://127.0.0.1:43821';

test('only the exact loopback application origin is a navigation target', () => {
  assert.equal(isApplicationURL(`${origin}/api/state`, origin), true);
  for (const url of [
    'https://example.com', 'file:///etc/passwd', 'javascript:alert(1)',
    'http://localhost:43821', 'http://127.0.0.1:43822',
    'http://127.0.0.1:43821.attacker.invalid', 'http://user@127.0.0.1:43821',
    'http://127.0.0.1:43821@attacker.invalid', 'not a URL',
  ]) assert.equal(isApplicationURL(url, origin), false, url);
});

test('remote resources are blocked and data URLs are images only', () => {
  assert.equal(isAllowedResource(`${origin}/style.css`, origin, 'stylesheet'), true);
  assert.equal(isAllowedResource('data:image/png;base64,AA==', origin, 'image'), true);
  assert.equal(isAllowedResource('data:text/html,hello', origin, 'mainFrame'), false);
  assert.equal(isAllowedResource('https://example.com/x.png', origin, 'image'), false);
  assert.equal(isAllowedResource('blob:https://example.com/x', origin, 'script'), false);
});

test('desktop session header cannot be overridden by renderer', () => {
  assert.deepEqual(authenticatedHeaders({ Accept: 'application/json', 'x-highway-desktop-token': 'wrong' }, 'secret'), {
    Accept: 'application/json', 'X-Highway-Desktop-Token': 'secret',
  });
});

test('backend environment does not inherit provider keys or shell injection hooks', () => {
  assert.deepEqual(backendEnvironment({ PATH: '/bin', HOME: '/home/me', OPENAI_API_KEY: 'secret', NODE_OPTIONS: '--require=bad.js', LD_PRELOAD: '/evil.so' }), { PATH: '/bin', HOME: '/home/me' });
});

test('desktop security settings and CSP remain explicit', () => {
  const main = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
  for (const setting of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'devTools: false', 'webSecurity: true', "action: 'deny'"]) assert.ok(main.includes(setting), setting);
  assert.equal(main.includes("appendSwitch('no-sandbox'"), false);
  assert.ok(CONTENT_SECURITY_POLICY.includes("script-src 'self'"));
  assert.equal(CONTENT_SECURITY_POLICY.includes('unsafe-eval'), false);
});

test('only local artifact downloads may open a native Save dialog', () => {
  const { isArtifactDownload } = require('../security.cjs');
  assert.equal(isArtifactDownload(`${origin}/api/artifacts/weekly-report?download=1`, origin), true);
  assert.equal(isArtifactDownload(`${origin}/api/settings`, origin), false);
  assert.equal(isArtifactDownload(`${origin}/api/artifacts/id/nested`, origin), false);
  assert.equal(isArtifactDownload('https://evil.invalid/api/artifacts/report', origin), false);
});
