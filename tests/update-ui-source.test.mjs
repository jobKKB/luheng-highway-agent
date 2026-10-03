import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const controller = source.slice(source.indexOf('// UPDATE-CONTROLLER-START'), source.indexOf('// UPDATE-CONTROLLER-END'));
const candidateId = 'a'.repeat(32);
const candidate = { id: candidateId, version: '0.6.1', sizeBytes: 4 * 1048576, sha256: 'b'.repeat(64), unsigned: true,
  releaseNotes: '<script>attack()</script>\nPlain release notes', releaseDate: '2026-10-03T00:00:00Z',
  releaseUrl: 'https://github.com/jobKKB/luheng-highway-agent/releases/tag/v0.6.1' };
const state = (phase, extra = {}) => ({ supported: true, currentVersion: '0.6.0-fixture', channel: 'stable', phase, candidate, ...extra });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function harness() {
  const fields = ['desktop-update-panel', 'update-current-version', 'update-channel', 'update-channel-select', 'update-channel-warning', 'update-channel-pending', 'update-status', 'update-candidate',
    'update-version', 'update-size', 'update-source', 'update-release-date', 'update-unsigned', 'update-sha256', 'update-notes',
    'update-progress-row', 'update-progress', 'update-progress-text', 'update-error', 'update-check', 'update-download', 'update-cancel', 'update-install'];
  const nodes = new Map(fields.map(id => [id, { id, textContent: '', hidden: false, disabled: false, value: 0 }]));
  for (const node of nodes.values()) for (const property of ['innerHTML', 'outerHTML'])
    Object.defineProperty(node, property, { set() { throw new Error('Update status must not replace DOM'); } });
  nodes.get('update-channel-select').value = 'stable';
  const changes = [];
  const draft = { value: 'synthetic-user-draft', key: 'synthetic-key-in-page-only', focus: true, selectionStart: 3, selectionEnd: 8, scrollTop: 91 };
  const h = { nodes, draft, reads: [], posts: [], queue: [], responses: [] };
  const context = vm.createContext({ console, Set, String, Number, Object, Date, Error, Promise, Math,
    document: { addEventListener: (event, listener) => { assert.equal(event, 'change'); changes.push(listener); } },
    view: 'settings', icon: () => '', $: selector => nodes.get(selector.replace(/^#/, '')) || null,
    api: async path => { h.reads.push(path); const item = h.queue.shift(); if (!item) throw new Error('Fixture status missing'); return item.promise || item; },
    post: async (path, body) => { h.posts.push({ path, body }); const item = h.responses.shift(); if (!item) throw new Error('Fixture command response missing'); return item.promise || item; },
  });
  vm.runInContext(controller, context);
  h.context = context;
  h.poll = async value => { h.queue.push(value); await context.pollDesktopUpdate(); };
  h.node = id => nodes.get(id);
  h.select = value => { const target = h.node('update-channel-select'); target.value = value; changes.forEach(listener => listener({ target })); };
  return h;
}

test('update panel mounts separately, keeps current version main-owned, and always explains unsigned/hash limits', () => {
  const h = harness(), panel = h.context.renderUpdateSettings();
  assert.match(panel, /版本与更新/);
  assert.match(panel, /安装包未签名/);
  assert.match(panel, /不独立认证发布者/);
  assert.match(panel, /原生确认/);
  assert.match(panel, /不会自动保存凭据/);
  assert.match(panel, /<select id="update-channel-select"[^>]*>/);
  assert.match(panel, /<option value="stable" selected>正式版（默认）<\/option>/);
  assert.match(panel, /<option value="preview" >测试版（包含预发布版本）<\/option>/);
  assert.match(panel, /测试版包含未正式发布的版本，可能不稳定/);
  assert.match(panel, /切换选项不会自动检查或下载/);
  assert.ok(panel.indexOf('update-channel-warning') < panel.indexOf('id="update-check"'), 'warning is shown before the explicit check button');
  assert.doesNotMatch(panel, /<form|<input|value="0\.[0-9]/);
  assert.match(source, /\$\{renderDesktopSettings\(\)\}\$\{renderUpdateSettings\(\)\}/);
  assert.match(controller, /status\?\.currentVersion/);
  assert.doesNotMatch(controller, /localStorage|sessionStorage|indexedDB|document\.cookie|render\(|loadState\(|innerHTML\s*=|outerHTML\s*=/);
});

test('cached progress only changes updater text/progress/buttons; drafts, key, focus, selection and scroll survive', async () => {
  const h = harness(), panel = h.node('desktop-update-panel'), before = { ...h.draft };
  await h.poll(state('available'));
  assert.equal(h.node('update-current-version').textContent, '0.6.0-fixture');
  assert.equal(h.node('update-notes').textContent, candidate.releaseNotes, 'release notes remain literal text, including HTML');
  assert.match(h.node('update-source').textContent, /jobKKB\/luheng-highway-agent/);
  assert.match(h.node('update-sha256').textContent, new RegExp(candidate.sha256));
  for (const percent of [0, 5, 25, 50, 99.9, 100]) await h.poll(state('downloading', { percent, bytesReceived: Math.floor(candidate.sizeBytes * percent / 100) }));
  assert.equal(h.node('desktop-update-panel'), panel);
  assert.deepEqual(h.draft, before);
  assert.equal(h.node('update-progress').value, 100);
  assert.equal(h.node('update-check').disabled, true);
  assert.equal(h.node('update-cancel').hidden, false);
  assert.equal(h.node('update-install').hidden, true);
  assert.deepEqual(h.reads, Array(7).fill('/api/desktop/update'));
  assert.equal(h.posts.length, 0, 'status refresh never triggers a release check/download');
});

test('user commands send only channel for check, empty cancel body or candidateId; cancel/retry work and native confirmation is not forged', async () => {
  const h = harness();
  await h.poll(state('available'));
  h.responses.push(state('checking'));
  await h.context.updateAction('update-check', h.node('update-check'));
  await h.poll(state('available'));
  h.responses.push(state('downloading', { bytesReceived: 0, percent: 0 }));
  await h.context.updateAction('update-download', h.node('update-download'));
  h.responses.push(state('cancelled'));
  await h.context.updateAction('update-cancel', h.node('update-cancel'));
  assert.match(h.node('update-download').textContent, /重试下载.*从头/);
  assert.equal(h.node('update-download').disabled, false);
  await h.poll(state('error', { error: { code: 'DOWNLOAD_FAILED', message: 'Synthetic network failure', retryable: true } }));
  assert.equal(h.node('update-install').hidden, true);
  assert.equal(h.node('update-download').hidden, false);
  assert.equal(h.node('update-error').textContent, 'Synthetic network failure');
  await h.poll(state('ready'));
  assert.equal(h.node('update-install').disabled, false);
  h.responses.push(state('confirming'));
  await h.context.updateAction('update-install', h.node('update-install'));
  assert.equal(h.node('update-install').hidden, true);
  assert.equal(h.node('update-check').disabled, true);
  assert.deepEqual(h.posts.map(post => ({ path: post.path, body: { ...post.body } })), [
    { path: '/api/desktop/update/check', body: { channel: 'stable' } },
    { path: '/api/desktop/update/download', body: { candidateId } },
    { path: '/api/desktop/update/cancel', body: {} },
    { path: '/api/desktop/update/install', body: { candidateId } },
  ]);
  assert.doesNotMatch(JSON.stringify(h.posts), /confirmed|activeCount|path.*exe|flags|\/S/);
  await h.poll(state('launch-pending'));
  assert.match(h.node('update-status').textContent, /尚未结束.*请勿再次/);
  assert.equal(h.node('update-install').hidden, true);
  assert.doesNotMatch(h.node('update-status').textContent, /安装成功|更新完成/);
});

test('unsupported Mac/web status disables all update commands and never substitutes a hardcoded version', async () => {
  const h = harness();
  await h.poll({ supported: false, phase: 'unsupported', currentVersion: '0.9.9-fixture', channel: 'preview' });
  assert.equal(h.node('update-current-version').textContent, '0.9.9-fixture');
  assert.match(h.node('update-status').textContent, /Mac.*不支持/);
  assert.equal(h.node('update-check').disabled, true);
  assert.equal(h.node('update-download').hidden, true);
  assert.equal(h.node('update-install').hidden, true);
  await h.context.updateAction('update-check', h.node('update-check'));
  assert.equal(h.posts.length, 0);
});

test('polling is scoped to settings/current download and stale status cannot overwrite a newer user command', async () => {
  const h = harness();
  h.context.view = 'chat'; await h.context.pollDesktopUpdate();
  assert.equal(h.reads.length, 0);
  h.context.view = 'settings'; await h.poll(state('available'));
  const old = deferred(); h.queue.push(old); const reading = h.context.pollDesktopUpdate();
  h.responses.push(state('ready'));
  await h.context.updateAction('update-download', h.node('update-download'));
  old.resolve(state('available', { currentVersion: 'stale-version' })); await reading;
  assert.equal(h.node('update-current-version').textContent, '0.6.0-fixture');
  assert.equal(h.node('update-install').hidden, false);
  h.context.view = 'chat'; await h.context.pollDesktopUpdate();
  assert.equal(h.reads.length, 2, 'ready state does not poll after leaving settings');
  h.context.view = 'settings'; await h.poll(state('downloading'));
  h.context.view = 'chat'; await h.poll(state('verifying', { percent: 100 }));
  assert.equal(h.reads.length, 4, 'current download remains visible through cached polling');
});

test('an in-flight command is single-flight and leaves settings untouched on error', async () => {
  const h = harness(), before = { ...h.draft };
  await h.poll(state('available'));
  const response = deferred(); h.responses.push(response);
  const first = h.context.updateAction('update-download', h.node('update-download'));
  await h.context.updateAction('update-download', h.node('update-download'));
  assert.equal(h.posts.length, 1);
  response.resolve(state('error', { error: { code: 'DISK_SPACE', message: 'Synthetic insufficient disk space', retryable: true } }));
  await first;
  assert.equal(h.node('update-download').disabled, false);
  assert.equal(h.node('update-error').textContent, 'Synthetic insufficient disk space');
  assert.deepEqual(h.draft, before);
});


test('channel selection is isolated and unsaved; no check/download runs before the Check click', async () => {
  const h = harness(), before = { ...h.draft }, panel = h.node('desktop-update-panel');
  assert.equal(h.node('update-channel-select').value, 'stable');
  await h.poll(state('available'));
  h.select('preview');
  assert.equal(h.node('update-channel-select').value, 'preview');
  assert.equal(h.node('update-channel').textContent, '正式版渠道', 'selection does not relabel the cached status');
  assert.match(h.node('update-source').textContent, /正式版渠道/);
  assert.match(h.node('update-channel-pending').textContent, /尚未检查.*测试版渠道.*正式版渠道.*缓存结果/);
  assert.equal(h.node('update-download').hidden, true, 'old-channel candidate cannot be downloaded');
  assert.equal(h.node('update-install').hidden, true);
  assert.equal(h.posts.length, 0);
  assert.deepEqual(h.reads, ['/api/desktop/update'], 'changing selection does not even poll');
  await h.poll(state('available'));
  assert.equal(h.node('update-channel-select').value, 'preview', 'cached status cannot erase a draft channel');
  assert.match(h.context.renderUpdateSettings(), /<option value="preview" selected>/, 'a separately requested render preserves the draft');
  assert.equal(h.node('desktop-update-panel'), panel);
  assert.deepEqual(h.draft, before);
  h.responses.push(state('checking', { channel: 'preview', candidate: null }));
  await h.context.updateAction('update-check', h.node('update-check'));
  assert.deepEqual(h.posts.map(post => ({ path: post.path, body: { ...post.body } })), [
    { path: '/api/desktop/update/check', body: { channel: 'preview' } },
  ]);
  assert.match(h.node('update-channel').textContent, /测试版渠道/);
  assert.match(h.node('update-status').textContent, /正在检查测试版渠道/);
  await h.poll(state('available', { channel: 'preview' }));
  assert.match(h.node('update-source').textContent, /测试版渠道/);
  assert.equal(h.node('update-download').hidden, false);
  assert.deepEqual(h.draft, before);
});

test('unsubmitted selection survives stale polling and an already-submitted check result', async () => {
  const h = harness(), before = { ...h.draft };
  await h.poll(state('available'));
  const old = deferred(); h.queue.push(old); const reading = h.context.pollDesktopUpdate();
  h.select('preview');
  const response = deferred(); h.responses.push(response);
  const checking = h.context.updateAction('update-check', h.node('update-check'));
  h.select('stable');
  response.resolve(state('checking', { channel: 'preview', candidate: null })); await checking;
  old.resolve(state('available', { currentVersion: 'stale-version' })); await reading;
  assert.equal(h.node('update-channel-select').value, 'stable');
  assert.equal(h.node('update-current-version').textContent, '0.6.0-fixture');
  assert.equal(h.node('update-channel').textContent, '测试版渠道');
  await h.poll(state('ready', { channel: 'preview' }));
  assert.equal(h.node('update-channel-select').value, 'stable');
  assert.equal(h.node('update-install').hidden, true, 'a check for the previous draft cannot authorize its candidate under the new choice');
  await h.context.updateAction('update-install', { disabled: false });
  assert.equal(h.posts.length, 1, 'direct stale-candidate action also fails closed');
  assert.match(h.node('update-error').textContent, /候选已失效.*重新检查/);
  assert.deepEqual(h.draft, before);
});

test('invalid channel drafts cannot create additional request fields or a custom source', async () => {
  const h = harness();
  await h.poll(state('idle', { candidate: null }));
  h.select('https://evil.invalid/releases');
  await h.poll(state('idle', { candidate: null }));
  assert.equal(h.node('update-channel-select').value, 'stable');
  h.responses.push(state('current', { candidate: null }));
  await h.context.updateAction('update-check', h.node('update-check'));
  assert.deepEqual({ ...h.posts[0].body }, { channel: 'stable' });
  assert.equal(h.posts.length, 1);
  assert.doesNotMatch(JSON.stringify(h.posts), /evil|url|feed|subscription/);
});
