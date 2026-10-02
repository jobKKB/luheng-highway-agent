'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { once } = require('node:events');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { SecretVault } = require('../vault.cjs');
const { DesktopPreferences } = require('../lifecycle.cjs');
const { createDesktopHandler } = require('../bridge.cjs');
const SECRET = 'SYNTHETIC-IPC-INTEGRATION-CREDENTIAL-NOT-REAL';

// Authenticated-encryption fixture only. OS-backed safeStorage is exercised
// separately in native runtime checks; these tests never open an OS keyring.
function fakeSafeStorage(backend = 'gnome_libsecret') {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
    encryptString(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
}
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'luheng-desktop-integration-'));
  const dataDir = join(dir, 'data'); mkdirSync(dataDir);
  const vault = new SecretVault({ stateRoot: dir, safeStorage: fakeSafeStorage(options.storageBackend), platform: 'linux' });
  let child, base, cookie, trayAvailable = options.trayAvailable !== false;
  let output = '', publicMessages = [], requests = [];
  const token = randomBytes(32).toString('hex');
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }); });
  async function start() {
    const preferences = new DesktopPreferences(dir);
    const handler = createDesktopHandler({ vault, preferences, tray: { available: () => trayAvailable } });
    child = fork(join(__dirname, '..', 'backend-process.mjs'), [], { silent: true });
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    const ready = new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Desktop backend startup timed out')), 8000);
      child.on('message', async message => {
        if (message.type === 'desktop:request') {
          requests.push(message.method);
          const response = await handler(message); publicMessages.push(response); child.send(response);
        } else {
          publicMessages.push(message);
          if (message.type === 'ready') { clearTimeout(timeout); resolveReady(message); }
          if (message.type === 'error') { clearTimeout(timeout); reject(new Error(message.message)); }
        }
      });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('Desktop backend exited before startup')); });
    });
    child.send({ type: 'start', serverPath: resolve(__dirname, '..', '..', 'server.mjs'), dataDir, desktopToken: token, persistedCredentials: vault.load() });
    const { port } = await ready;
    base = `http://127.0.0.1:${port}`;
    cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const current = child, exited = once(current, 'exit');
    const timeout = setTimeout(() => current.kill(), 5000);
    current.send({ type: 'shutdown' });
    const [code] = await exited; clearTimeout(timeout);
    assert.equal(code, 0); child = null;
  }
  async function request(path, method = 'GET', body) {
    return fetch(base + path, {
      method, headers: { Cookie: cookie, 'X-Highway-Desktop-Token': token,
        ...(method === 'GET' ? {} : { Origin: base, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function json(path, method = 'GET', body, expected = 200) {
    const response = await request(path, method, body), text = await response.text();
    assert.ok(!text.includes(SECRET), 'HTTP response must never contain credentials');
    assert.equal(response.status, expected, text); return JSON.parse(text);
  }
  await start();
  return { dir, vault, token, requests, json, request, stop,
    get base() { return base; }, get cookie() { return cookie; },
    set trayAvailable(value) { trayAvailable = value; },
    restart: async () => { await stop(); await start(); },
    assertNoExposure() {
      assert.ok(!output.includes(SECRET), 'child logs must not expose credentials');
      assert.ok(!JSON.stringify(publicMessages).includes(SECRET), 'public control replies must not expose credentials');
      for (const file of readdirSync(dataDir)) {
        if (file.startsWith('agent.sqlite')) assert.ok(!readFileSync(join(dataDir, file)).includes(Buffer.from(SECRET)), 'SQLite must not contain credentials');
      }
    },
  };
}

test('real backend desktop API requires both session cookie and desktop token', async t => {
  const h = await fixture(t);
  assert.equal((await fetch(`${h.base}/api/state`, { headers: { Cookie: h.cookie } })).status, 401);
  assert.equal((await fetch(`${h.base}/api/state`, { headers: { 'X-Highway-Desktop-Token': h.token } })).status, 401);
  const state = await h.json('/api/state');
  assert.ok(state.settings); assert.equal(state.desktop.available, true);
  assert.equal(state.desktop.backgroundEnabled, false); assert.equal(state.desktop.trayAvailable, true);
  await h.stop(); await assert.rejects(fetch(h.base));
});

test('real utility IPC preserves explicit encrypted snapshots across restart without exposing credentials', async t => {
  const h = await fixture(t);
  await h.json('/api/settings', 'POST', { mode: 'demo', endpoint: 'https://api.openai.com/v1', model: 'fixture-model', apiKey: SECRET });
  assert.equal(h.vault.status().stored, false, 'entering a key is not consent to persistence');
  await h.json('/api/desktop/credentials/save', 'POST', {}, 400);
  assert.equal(h.requests.includes('saveCredentials'), false);
  await h.json('/api/desktop/credentials/save', 'POST', { confirmed: true, snapshot: { unexpected: 'value' } }, 400);
  const saved = await h.json('/api/desktop/credentials/save', 'POST', { confirmed: true });
  assert.equal(saved.credentialVault.stored, true);
  assert.equal(h.vault.load().entries[0].secret, SECRET);
  assert.ok(!readFileSync(join(h.dir, 'credentials.vault')).includes(Buffer.from(SECRET)));
  await h.json('/api/desktop/preferences', 'POST', { backgroundEnabled: true });
  await h.restart();
  let state = await h.json('/api/state');
  assert.equal(state.settings.hasApiKey, true); assert.equal(state.desktop.backgroundEnabled, true);
  await h.json('/api/settings', 'POST', { mode: 'demo', endpoint: 'https://api.openai.com/v1', model: 'different-model' });
  await h.restart();
  state = await h.json('/api/state'); assert.equal(state.settings.hasApiKey, false, 'changed model identity invalidates old snapshot');
  await h.json('/api/desktop/credentials/forget', 'POST', { confirmed: true });
  assert.equal(h.vault.status().stored, false);
  await h.restart();
  assert.equal((await h.json('/api/state')).settings.hasApiKey, false);
  h.assertNoExposure();
});

test('real desktop API fails closed for unavailable encryption and absent tray', async t => {
  const h = await fixture(t, { storageBackend: 'basic_text', trayAvailable: false });
  const state = await h.json('/api/state');
  assert.equal(state.desktop.credentialVault.available, false); assert.equal(state.desktop.trayAvailable, false);
  await h.json('/api/desktop/preferences', 'POST', { backgroundEnabled: true }, 400);
  assert.equal((await h.json('/api/state')).desktop.backgroundEnabled, false);
  await h.json('/api/settings', 'POST', { mode: 'demo', endpoint: 'https://api.openai.com/v1', model: 'fixture-model', apiKey: SECRET });
  await h.json('/api/desktop/credentials/save', 'POST', { confirmed: true }, 400);
  assert.equal(h.vault.status().stored, false); h.assertNoExposure();
});
