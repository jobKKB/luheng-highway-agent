import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.mjs';

const candidateId = 'a'.repeat(32);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const until = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await wait(5); } throw new Error('Fixture did not settle'); };
async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'luheng-backend-update-'));
  const calls = [];
  let current = { supported: true, currentVersion: '0.6.0', channel: 'stable', phase: 'available',
    candidate: { id: candidateId, version: '0.6.1', sizeBytes: 1234, sha256: 'b'.repeat(64),
      releaseDate: '2026-10-03T00:00:00Z', releaseNotes: 'synthetic',
      releaseUrl: 'https://github.com/jobKKB/luheng-highway-agent/releases/tag/v0.6.1', unsigned: true } };
  const bridge = {
    preferences: async () => ({ backgroundEnabled: false, trayAvailable: false }),
    status: async () => ({ available: false, stored: false, backend: 'unknown' }),
    updateStatus: async () => { calls.push(['updateStatus']); return current; },
    checkUpdate: async input => { calls.push(['checkUpdate', input]); return current; },
    downloadUpdate: async input => { calls.push(['downloadUpdate', input]); return current; },
    cancelUpdate: async () => { calls.push(['cancelUpdate']); return current; },
    installUpdate: async input => { calls.push(['installUpdate', input]); return current; },
  };
  const app = await startServer({ port: 0, dataDir: dir, stepDelay: 1,
    desktopToken: 'synthetic-desktop-token', desktopBridge: bridge,
    scheduleOptions: { startTimer: false }, ...options });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  const cookie = (await fetch(app.url)).headers.get('set-cookie').split(';')[0];
  const headers = { cookie, origin: app.url, 'content-type': 'application/json', 'x-highway-desktop-token': 'synthetic-desktop-token' };
  const request = async (path, input, overrides = {}) => {
    const response = await fetch(app.url + path, { method: input === undefined ? 'GET' : 'POST',
      headers: { ...headers, ...overrides }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, data: await response.json() };
  };
  return { app, calls, bridge, headers, request, setStatus: value => { current = value; } };
}

test('updater API is authenticated, fixed-method and exact-body; only main RPC receives opaque candidate', async t => {
  const h = await harness(t);
  assert.equal((await h.request('/api/desktop/update')).data.currentVersion, '0.6.0');
  assert.equal(h.calls.filter(([method]) => method === 'checkUpdate').length, 0, 'GET reads cached state only');
  for (const overrides of [{ cookie: '' }, { 'x-highway-desktop-token': '' }, { origin: 'https://untrusted.invalid' }])
    assert.ok([401, 403].includes((await h.request('/api/desktop/update/install', { candidateId }, overrides)).status));
  assert.equal((await h.request('/api/desktop/update/install', { candidateId }, { origin: '' })).status, 403);
  for (const input of [null, [], 1, { confirmed: true }, { url: 'https://evil.invalid' }, { count: 0 },
    { channel: null }, { channel: '' }, { channel: 'beta' }, { channel: 'STABLE' }, { channel: 1 },
    { channel: {} }, { channel: ['preview'] }, { channel: 'preview', confirmed: true },
    { channel: 'stable', url: 'https://evil.invalid' }, { channel: 'preview', candidateId }])
    assert.equal((await h.request('/api/desktop/update/check', input)).status, 400);
  for (const input of [{}, { channel: 'stable' }, { channel: 'preview' }])
    assert.equal((await h.request('/api/desktop/update/check', input)).status, 200);
  assert.deepEqual(h.calls.filter(([method]) => method === 'checkUpdate'), [
    ['checkUpdate', {}], ['checkUpdate', { channel: 'stable' }], ['checkUpdate', { channel: 'preview' }],
  ], 'only the optional channel enum reaches the fixed main RPC');
  for (const input of [null, [], 1, { confirmed: true }, { url: 'https://evil.invalid' }, { count: 0 },
    { channel: 'stable' }, { channel: 'preview' }, { candidateId }])
    assert.equal((await h.request('/api/desktop/update/cancel', input)).status, 400);
  assert.equal((await h.request('/api/desktop/update/cancel', {})).status, 200);
  assert.deepEqual(h.calls.filter(([method]) => method === 'cancelUpdate'), [['cancelUpdate']]);
  for (const command of ['download', 'install']) {
    for (const input of [{}, null, [], { candidateId: 'A'.repeat(32) }, { candidateId: 'a'.repeat(31) },
      { candidateId, confirmed: true }, { candidateId, activeCount: 0 }, { candidateId, path: 'C:\\temp\\installer.exe' },
      { candidateId, flags: ['/S'] }, { candidateId, url: 'https://evil.invalid' },
      { candidateId, channel: 'stable' }, { candidateId, channel: 'preview' }])
      assert.equal((await h.request('/api/desktop/update/' + command, input)).status, 400);
    assert.equal((await h.request('/api/desktop/update/' + command, { candidateId })).status, 200);
  }
  assert.deepEqual(h.calls.filter(([method]) => method === 'installUpdate'), [['installUpdate', { candidateId }]]);
  assert.deepEqual(h.calls.filter(([method]) => method === 'downloadUpdate'), [['downloadUpdate', { candidateId }]]);
  assert.equal((await h.request('/api/desktop/update?url=evil')).status, 400);
  assert.equal((await h.request('/api/desktop/update/install')).status, 404);
  assert.equal((await h.request('/api/desktop/update/launch', {})).status, 404);
  const health = await fetch(h.app.url + '/health').then(r => r.json());
  assert.equal(h.app.version, health.version);
});

test('non-desktop and unsupported updater requests fail closed; raw bridge errors are not exposed', async t => {
  const h = await harness(t, { desktopBridge: undefined });
  const unsupported = await h.request('/api/desktop/update');
  assert.equal(unsupported.data.supported, false);
  assert.equal(unsupported.data.channel, 'stable');
  assert.equal((await h.request('/api/desktop/update/check', {})).status, 409);
  const supported = await harness(t);
  supported.setStatus({ supported: false, currentVersion: '0.6.0', phase: 'unsupported' });
  assert.equal((await supported.request('/api/desktop/update/install', { candidateId })).status, 409);
  assert.equal(supported.calls.some(([method]) => method === 'installUpdate'), false);
  supported.bridge.updateStatus = async () => { throw new Error('C:\\private\\secret-vault TOKEN'); };
  const failed = await supported.request('/api/desktop/update');
  assert.equal(failed.status, 503);
  assert.doesNotMatch(JSON.stringify(failed.data), /private|secret|TOKEN/);
});

test('readiness refuses each real active-service field without aborting it and releases its gate', async t => {
  const h = await harness(t), app = h.app;
  const fields = [app.engine.running, app.localAccess.running, app.localAccess.inflight,
    app.mail.active, app.mail.inboxLocks, app.mail.readControllers,
    app.controlledBrowser.inflight, app.controlledBrowser.live];
  for (const field of fields) {
    const controller = new AbortController();
    if (field instanceof Set) field.add(controller); else field.set('fixture-active', controller);
    assert.deepEqual(app.prepareForUpdate(), { ready: false });
    assert.equal(app.engine.updateGate, false); assert.equal(app.schedules.updateGate, false);
    assert.equal(controller.signal.aborted, false, 'readiness never force-cancels an external action');
    field.clear();
  }
  assert.deepEqual(app.prepareForUpdate(), { ready: true });
  app.releaseUpdateGate();
  assert.equal((await h.request('/api/memories', { title: 'Synthetic', content: 'Fixture', source: 'test' })).status, 201);
});

test('partially received mutation prevents installation before any body await can race the gate', async t => {
  const h = await harness(t);
  const input = JSON.stringify({ title: 'Synthetic partial request', content: 'Fixture', source: 'test' });
  const seen = deferred(); h.app.server.once('request', () => seen.resolve());
  let request;
  const finished = new Promise((resolve, reject) => {
    request = http.request(h.app.url + '/api/memories', { method: 'POST', headers: { ...h.headers, 'content-length': Buffer.byteLength(input) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject); request.write(input.slice(0, 5));
  });
  await seen.promise;
  assert.deepEqual(h.app.prepareForUpdate(), { ready: false });
  request.end(input.slice(5));
  assert.equal((await finished).status, 201);
  assert.deepEqual(h.app.prepareForUpdate(), { ready: true });
  assert.equal((await h.request('/api/memories', { title: 'Blocked', content: 'Fixture', source: 'test' })).status, 409);
  h.app.releaseUpdateGate();
});

test('held gate pauses engine/timer/reconcile/scheduler dispatch; queued and awaiting work stays unchanged', async t => {
  const h = await harness(t), app = h.app;
  const queued = app.engine.create({ prompt: 'Synthetic queued task' });
  const waiting = { ...app.store.get('tasks', queued.id), id: 'synthetic-awaiting', status: 'awaiting_approval', localContext: false };
  app.store.put('tasks', waiting.id, waiting);
  const schedule = app.schedules.create({ prompt: 'Synthetic due schedule', timezone: 'UTC',
    recurrence: { type: 'interval', intervalMinutes: 1 }, startAt: new Date(Date.now() - 60000).toISOString() });
  assert.deepEqual(app.prepareForUpdate(), { ready: true });
  const before = JSON.stringify(app.store.all('tasks'));
  assert.equal(app.engine.updateGate, true); assert.equal(app.schedules.updateGate, true);
  app.engine.pump(); await app.engine.run(queued.id); app.engine.tick(); app.engine.reconcileLocalAccess(); app.engine.reconcileControlledSessions();
  assert.deepEqual(app.schedules.tick(), []);
  assert.equal(app.schedules.claim(schedule.id, Date.now()), null);
  assert.equal(app.schedules.dispatch({ id: 'blocked-occurrence' }, Date.now()), null);
  await wait(30);
  assert.equal(app.engine.running.size, 0); assert.equal(JSON.stringify(app.store.all('tasks')), before);
  assert.equal(app.schedules.occurrences().length, 0);
  assert.throws(() => app.engine.create({ prompt: 'blocked' }), /更新/);
  await assert.rejects(app.engine.decide('missing', 'approve'), /更新/);
  assert.equal((await h.request('/api/state')).status, 409, 'GET state never reconciles under the gate');
  assert.equal((await h.request('/api/local-access/state')).status, 409);
  assert.equal((await h.request('/api/desktop/update')).status, 200);
  // Install itself is excluded from mutation counting: main can get readiness
  // through its private channel while this authenticated request is in flight.
  h.bridge.installUpdate = async () => ({ ...await h.bridge.updateStatus(), readiness: app.prepareForUpdate().ready });
  assert.equal((await h.request('/api/desktop/update/install', { candidateId })).data.readiness, true);
  app.releaseUpdateGate(); app.releaseUpdateGate();
  await until(() => app.store.get('tasks', queued.id).status !== 'queued');
  assert.equal(app.store.get('tasks', waiting.id).status, 'awaiting_approval');
  assert.equal((await h.request('/api/state')).status, 200);
});

test('actual running model operation blocks update and is allowed to finish rather than being force-closed', async t => {
  const work = deferred();
  const h = await harness(t, { completion: async () => work.promise });
  h.app.engine.getKey = () => 'synthetic-key';
  h.app.store.put('settings', 'main', { ...h.app.store.get('settings', 'main'), model: 'synthetic-model' });
  const task = h.app.engine.create({ prompt: 'Synthetic ordinary fixture question', agentId: 'researcher' });
  await until(() => h.app.engine.running.has(task.id));
  const controller = h.app.engine.running.get(task.id);
  assert.deepEqual(h.app.prepareForUpdate(), { ready: false });
  assert.equal(controller.signal.aborted, false);
  work.resolve({ message: { role: 'assistant', content: 'Synthetic reply' } });
  await until(() => !h.app.engine.running.has(task.id));
  assert.deepEqual(h.app.prepareForUpdate(), { ready: true });
  h.app.releaseUpdateGate();
});
