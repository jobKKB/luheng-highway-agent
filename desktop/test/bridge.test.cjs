'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopHandler, createDesktopClient, publicStatus } = require('../bridge.cjs');
const SECRET = 'SYNTHETIC-PRIVATE-BRIDGE-SECRET';
const snapshot = () => ({ version: 1, entries: [{ kind: 'global', id: 'main', configDigest: 'a'.repeat(64), secret: SECRET }] });

function fixture() {
  let saved = null, saveCalls = 0, trayAvailable = true, restoreError = true;
  const preferences = { backgroundEnabled: false, set(value) { this.backgroundEnabled = value.backgroundEnabled; } };
  const vault = {
    status: () => ({ available: true, stored: !!saved, backend: 'keychain', accidental: SECRET }),
    save(value) { saved = structuredClone(value); saveCalls++; return this.status(); },
    forget() { saved = null; return this.status(); },
  };
  const handler = createDesktopHandler({ vault, preferences, tray: { available: () => trayAvailable }, getRestoreError: () => restoreError, clearRestoreError: () => { restoreError = false; } });
  const replies = [];
  const client = createDesktopClient(message => queueMicrotask(async () => {
    const response = await handler(structuredClone(message));
    replies.push(response); client.receive(response);
  }));
  return { handler, client, replies, vault, preferences, set trayAvailable(value) { trayAvailable = value; }, get saved() { return saved; }, get saveCalls() { return saveCalls; } };
}

test('private RPC saves only on explicit save, projects status, and forgets saved state', async () => {
  const h = fixture();
  assert.deepEqual(await h.client.api.status(), { available: true, stored: false, backend: 'keychain', restoreError: true });
  assert.deepEqual(await h.client.api.preferences(), { backgroundEnabled: false, trayAvailable: true });
  assert.equal(h.saveCalls, 0);
  await h.client.api.setPreferences({ backgroundEnabled: true }); assert.equal(h.saveCalls, 0);
  const result = await h.client.api.saveCredentials(snapshot());
  assert.deepEqual(result, { available: true, stored: true, backend: 'keychain' });
  assert.deepEqual(h.saved, snapshot()); assert.equal(h.saveCalls, 1);
  assert.equal((await h.client.api.forgetCredentials()).stored, false);
  assert.equal(h.saved, null);
  assert.ok(!JSON.stringify(h.replies).includes(SECRET), 'replies cannot reveal any snapshot secret');
  h.client.close();
});

test('bridge refuses unsupported commands, argument smuggling, malformed records and background without tray', async () => {
  const h = fixture();
  for (const message of [
    { method: 'loadCredentials' }, { method: 'status', payload: snapshot() },
    { method: 'saveCredentials', payload: { ...snapshot(), extra: SECRET } },
    { method: 'setPreferences', payload: { backgroundEnabled: true, autoStart: true } },
    { method: 'setPreferences', payload: { backgroundEnabled: 'true' } },
    { method: 'preferences', unexpected: SECRET },
  ]) {
    const response = await h.handler({ type: 'desktop:request', id: 1, ...message });
    assert.equal(response.ok, false); assert.equal(response.error.code, 'invalid');
    assert.ok(!JSON.stringify(response).includes(SECRET));
  }
  assert.equal(h.saveCalls, 0);
  h.trayAvailable = false;
  await assert.rejects(h.client.api.setPreferences({ backgroundEnabled: true }), /托盘/);
  assert.equal(h.preferences.backgroundEnabled, false);
  await h.client.api.setPreferences({ backgroundEnabled: false });
  h.client.close();
});

test('bridge failure responses use fixed text and never return thrown error content', async () => {
  const h = fixture();
  h.vault.save = () => { throw new Error(SECRET); };
  await assert.rejects(h.client.api.saveCredentials(snapshot()), error => !String(error).includes(SECRET) && /密钥库/.test(error.message));
  assert.equal(h.replies[0].error.code, 'vault');
  const status = publicStatus({ available: false, stored: false, backend: SECRET, reason: SECRET, secret: SECRET });
  assert.equal(status.backend, 'unknown'); assert.ok(!JSON.stringify(status).includes(SECRET));
  h.client.close();
});

test('client rejects missing parent replies, failed transport and shutdown without keeping requests open', async () => {
  const timeout = createDesktopClient(() => {}, { timeoutMs: 15 });
  await assert.rejects(timeout.api.status(), /超时/); timeout.close();
  const transport = createDesktopClient(() => { throw new Error(SECRET); });
  await assert.rejects(transport.api.status(), error => !String(error).includes(SECRET)); transport.close();
  const closed = createDesktopClient(() => {}); const pending = closed.api.status(); closed.close();
  await assert.rejects(pending, /不可用/); await assert.rejects(closed.api.status(), /不可用/);
});

test('client validates response shape, ignores unknown ids and strips unexpected fields', async () => {
  let request; const client = createDesktopClient(message => { request = message; });
  const first = client.api.preferences();
  assert.equal(client.receive({ type: 'not-desktop' }), false);
  assert.equal(client.receive({ type: 'desktop:response', id: 5555, ok: true, result: {} }), true);
  client.receive({ type: 'desktop:response', id: request.id, ok: true, result: { backgroundEnabled: false, trayAvailable: true, secret: SECRET } });
  assert.deepEqual(await first, { backgroundEnabled: false, trayAvailable: true });
  const second = client.api.status();
  client.receive({ type: 'desktop:response', id: request.id, ok: true, result: { secret: SECRET } });
  await assert.rejects(second, /格式/); client.close();
});
