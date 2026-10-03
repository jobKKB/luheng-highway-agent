import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'playwright';
import { startServer } from '../server.mjs';

// Actual HTTP preparation contract for the real browser gate. No Chromium or
// DOM facade: verifies route, session, Origin, body and response shape first.
test('stability browser gate uses real same-origin HTTP contracts and explicit synthetic API task data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stability-http-contract-')), docs = join(root, 'selected');
  await mkdir(docs); let app, client;
  try {
    app = await startServer({ port: 0, dataDir: join(root, 'data'), stepDelay: 15, completion: async () => ({ message: { role: 'assistant', content: '合成通用资料，仅用于无浏览器HTTP准备合同。' } }) });
    app.store.put('agents', 'coordinator', { ...app.store.get('agents', 'coordinator'), permissions: ['knowledge.read', 'workspace.write'] });
    client = await request.newContext({ baseURL: app.url, extraHTTPHeaders: { origin: app.url } });
    await client.get('/');
    const get = async path => { const r = await client.get(path); assert.equal(r.status(), 200, path); return r.json(); };
    const post = async (path, data) => { const r = await client.post(path, { data }); assert.ok(r.ok(), path + ' ' + r.status() + ' ' + await r.text()); return r.json(); };
    const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
    const health = await get('/health'); assert.equal(health.ok, true); assert.equal(health.version, version);
    const disabled = await post('/api/local-access/configure', { mode: 'disabled', onboardingComplete: true });
    assert.equal(disabled.mode, 'disabled'); assert.equal(disabled.configured, true);
    let state = await get('/api/state'); assert.equal(state.system.version, version); assert.equal(typeof state.system.lastHeartbeat, 'string'); assert.ok(Array.isArray(state.tasks));
    // Public literal fixture endpoint is never contacted: completion is injected.
    // It avoids external DNS while retaining the real endpoint/settings contract.
    await post('/api/settings', { mode: 'api', endpoint: 'https://8.8.8.8/v1', model: 'synthetic-stability-model', budget: 30, apiKey: 'SYNTHETIC-STABILITY-KEY-NOT-REAL' });
    state = await get('/api/state'); assert.equal(state.settings.hasApiKey, true);
    const task = await post('/api/tasks', { prompt: '请讨论一个通用资料组织方法', submissionId: 'stability-http-test-only-0001', budget: 20 });
    assert.equal(typeof task.id, 'string'); assert.equal(typeof task.status, 'string');
    const statuses = new Set([task.status]); let settled;
    for (let i = 0; i < 100; i++) { settled = await get('/api/tasks/' + task.id); statuses.add(settled.status); if (settled.status === 'completed') break; await new Promise(r => setTimeout(r, 50)); }
    assert.equal(settled.status, 'completed'); assert.ok(statuses.size >= 2);
    const row = app.store.get('tasks', task.id); assert.ok(row && !row.localContext); assert.equal(typeof row.output, 'string');
    app.store.put('tasks', task.id, { ...row, output: 'native-range-source-fixture' });
    state = await get('/api/state'); assert.equal(state.tasks.find(t => t.id === task.id).output, 'native-range-source-fixture');
    const confirmed = await post('/api/local-access/configure', { mode: 'confirm', roots: [docs], allFiles: false, onboardingComplete: true });
    assert.equal(confirmed.mode, 'confirm'); assert.deepEqual(confirmed.roots, [docs]);
    const revoked = await post('/api/local-access/revoke', {}); assert.equal(revoked.mode, 'disabled'); assert.deepEqual(revoked.roots, []);
    state = await get('/api/state'); assert.equal(state.localAccess.mode, 'disabled');
  } finally { await client?.dispose(); await app?.close(); await rm(root, { recursive: true, force: true }); }
});
