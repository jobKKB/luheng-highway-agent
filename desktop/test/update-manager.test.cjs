'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, linkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { UpdateManager, publicUpdateState } = require('../update-manager.cjs');
const { createUpdateFiles, WINDOWS_INSPECT_SCRIPT, WINDOWS_INSTALL_SCRIPT, INSTALL_GUID } = require('../update-files.cjs');
const { createDesktopClient, createDesktopHandler } = require('../bridge.cjs');
const policy = require('../update-policy.cjs');
const bytes = Buffer.from('MZ-synthetic-updater-test-data-NEVER-EXECUTE');
const repository = { id: policy.REPOSITORY_ID, full_name: policy.REPOSITORY, owner: { id: policy.REPOSITORY_OWNER_ID, login: policy.REPOSITORY_OWNER_LOGIN }, private: false, url: policy.API_ROOT, html_url: policy.REPOSITORY_URL };
function release(version = '0.6.0') { return { id: 123, draft: false, prerelease: true, tag_name: 'v' + version, url: policy.API_ROOT + '/releases/123', html_url: policy.releaseURL(version), published_at: '2026-10-03T10:00:00Z', body: 'Synthetic <b>notes</b>', assets: [{ id: 456, state: 'uploaded', name: policy.assetName(version), size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), content_type: 'application/octet-stream', url: policy.API_ROOT + '/releases/assets/456', browser_download_url: policy.assetDownloadURL(version) }] }; }
async function fixture(t, { response, lifecycle = {}, currentVersion = '0.5.2', supported = true, releaseVersion = '0.6.0', releaseList, repositoryResponse = repository, ...options } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'luheng-update-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = await createUpdateFiles({ stateRoot: dir, privateDirectoryModule: resolve(__dirname, '../../lib/private-directory.mjs'), platform: 'linux' });
  let fetches = 0, opens = 0; const events = [];
  const native = { executable: '/fixture/current.exe', confirm: async () => { events.push('confirm'); return true; }, prepare: async () => { events.push('prepare'); return { ready: true }; }, shutdown: async () => { events.push('shutdown'); return true; }, launch: async file => { events.push('shell'); assert.ok(file.endsWith('installer.exe')); return ''; }, exit: async () => events.push('exit'), release: async () => events.push('release'), recover: async () => events.push('recover'), ...lifecycle };
  files.installSpace = async () => {};
  const transport = { fetchReleases: async () => { fetches++; return { repository: repositoryResponse, releases: releaseList || [release(releaseVersion)] }; }, openAssetStream: async args => { opens++; return response ? response(args) : { statusCode: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, stream: Readable.from([bytes.subarray(0, 1), bytes.subarray(1, 9), bytes.subarray(9)]) }; } };
  const manager = new UpdateManager({ currentVersion, supported, files, transport, lifecycle: native, journal: files.journal, cooldownMs: 1, ...options });
  t.after(() => manager.close());
  const check = async () => { manager.checkUpdate({ channel: 'preview' }); await manager.waitForIdle(); assert.equal(manager.status().phase, 'available'); return manager.status().candidate.id; };
  const download = async () => { const id = await check(); manager.downloadUpdate({ candidateId: id }); await manager.waitForIdle(); return id; };
  return { dir, files, manager, events, check, download, get fetches() { return fetches; }, get opens() { return opens; } };
}
test('manager revalidates transport-sanitized repository with the fixed owner', async t => {
  const f = await fixture(t, { repositoryResponse: policy.validateRepository(repository) });
  await f.check(); assert.equal(f.fetches, 1); assert.equal(f.opens, 0);
  assert.equal(f.manager.status().candidate.version, '0.6.0');
});
test('manager rejects missing, changed or invalid fixed owner before offering or downloading', async t => {
  const missingOwner = { ...repository }; delete missingOwner.owner;
  for (const repositoryResponse of [missingOwner, { ...repository, owner: null },
    { ...repository, owner: { ...repository.owner, id: 1 } },
    { ...repository, owner: { ...repository.owner, id: '137971851' } },
    { ...repository, owner: { ...repository.owner, id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...repository, owner: { ...repository.owner, login: 'other' } }]) {
    const f = await fixture(t, { repositoryResponse });
    f.manager.checkUpdate({ channel: 'preview' }); await f.manager.waitForIdle();
    assert.equal(f.manager.status().phase, 'error'); assert.equal(f.manager.status().error.code, 'INVALID_SOURCE');
    assert.equal(f.manager.status().candidate, undefined); assert.equal(f.manager.candidate, null);
    assert.equal(f.fetches, 1); assert.equal(f.opens, 0); assert.deepEqual(f.events, []);
  }
});
test('user check/download/install has verified bytes, native confirmation, flush before Shell, and no success receipt', async t => {
  const f = await fixture(t); assert.equal(f.fetches, 0);
  const id = await f.download(); assert.equal(f.manager.status().phase, 'ready'); assert.equal(f.opens, 1);
  assert.equal(f.manager.status().candidate.releaseNotes, 'Synthetic notes');
  const publicState = JSON.stringify(f.manager.status()); assert.ok(!publicState.includes(f.dir)); assert.ok(!publicState.includes('downloadUrl')); assert.ok(!publicState.includes('assetId'));
  f.manager.installUpdate({ candidateId: id }); f.manager.installUpdate({ candidateId: id }); await f.manager.waitForIdle();
  assert.deepEqual(f.events, ['confirm', 'prepare', 'shutdown', 'shell', 'exit']); assert.equal(f.manager.status().phase, 'launch-pending');
  assert.equal((await f.files.journal.read()).version, '0.6.0');
  await f.manager.verifyStartup('0.5.2'); assert.equal(f.manager.status().phase, 'error');
  const next = new UpdateManager({ currentVersion: '0.6.0', supported: true, files: f.files, journal: f.files.journal });
  await next.verifyStartup('0.6.0'); assert.equal(next.status().phase, 'updated'); assert.equal(await f.files.journal.read(), null);
});
test('cancel native confirmation leaves ready and never gates, shuts down or launches', async t => {
  const f = await fixture(t, { lifecycle: { confirm: async () => false } }); const id = await f.download();
  f.manager.installUpdate({ candidateId: id }); await f.manager.waitForIdle(); assert.equal(f.manager.status().phase, 'ready'); assert.deepEqual(f.events, []);
});
test('active work blocks before shutdown/Shell and installer can retry after work ends', async t => {
  let ready = false; const f = await fixture(t, { lifecycle: { prepare: async () => ({ ready }) } }); const id = await f.download();
  f.manager.installUpdate({ candidateId: id }); await f.manager.waitForIdle(); assert.equal(f.manager.status().phase, 'blocked'); assert.deepEqual(f.events, ['confirm']);
  ready = true; f.manager.installUpdate({ candidateId: id }); await f.manager.waitForIdle(); assert.deepEqual(f.events, ['confirm', 'confirm', 'shutdown', 'shell', 'exit']);
});
test('unconfirmed flush never launches installer, clears marker, and asks current-version recovery', async t => {
  const f = await fixture(t, { lifecycle: { shutdown: async () => false } }); const id = await f.download();
  f.manager.installUpdate({ candidateId: id }); await f.manager.waitForIdle(); assert.equal(f.manager.status().error.code, 'SHUTDOWN'); assert.deepEqual(f.events, ['confirm', 'prepare', 'recover']); assert.equal(await f.files.journal.read(), null);
});
test('Shell rejection does not become updated or trigger another installer attempt', async t => {
  const f = await fixture(t, { lifecycle: { launch: async () => 'user declined system prompt' } }); const id = await f.download();
  f.manager.installUpdate({ candidateId: id }); await f.manager.waitForIdle(); assert.equal(f.manager.status().error.code, 'LAUNCH'); assert.deepEqual(f.events, ['confirm', 'prepare', 'shutdown', 'recover']); assert.equal(await f.files.journal.read(), null);
  assert.throws(() => f.manager.installUpdate({ candidateId: id }));
});
test('pending OS Shell promise holds single-flight and cannot dispatch another installer', async t => {
  let finish; let launches = 0;
  const f = await fixture(t, { lifecycle: { launch: () => { launches++; return new Promise(resolve => { finish = resolve; }); } } }); const id = await f.download();
  f.manager.installUpdate({ candidateId: id });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(f.manager.status().phase, 'launch-pending'); f.manager.installUpdate({ candidateId: id }); f.manager.checkUpdate(); assert.equal(launches, 1);
  finish(''); await f.manager.waitForIdle(); assert.equal(launches, 1);
});
test('ready file replacement/hash tampering is refused before native confirmation', async t => {
  const f = await fixture(t); const id = await f.download(); writeFileSync(f.manager.record.file, Buffer.alloc(bytes.length, 0));
  f.manager.installUpdate({ candidateId: id }); await f.manager.waitForIdle(); assert.equal(f.manager.status().error.code, 'FILE_CHANGED'); assert.deepEqual(f.events, []);
});
for (const [name, response] of [
  ['hash mismatch', () => ({ statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, stream: Readable.from([Buffer.from('MZ' + 'x'.repeat(bytes.length - 2))]) })],
  ['HTML type', () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, stream: Readable.from([bytes]) })],
  ['wrong content-length', () => ({ statusCode: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length + 1) }, stream: Readable.from([bytes]) })],
  ['short bytes', () => ({ statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, stream: Readable.from([bytes.subarray(0, 5)]) })],
  ['too many bytes', () => ({ statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, stream: Readable.from([Buffer.concat([bytes, bytes])]) })],
  ['not EXE', () => ({ statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, stream: Readable.from([Buffer.alloc(bytes.length, 0)]) })],
]) test(`invalid ${name} never becomes ready and clears only owned partial`, async t => {
  const f = await fixture(t, { response }); const id = await f.download(); assert.equal(f.manager.status().phase, 'error'); assert.equal(f.manager.status().error.code, 'DOWNLOAD_INVALID'); assert.equal(f.manager.record, null); assert.throws(() => f.manager.installUpdate({ candidateId: id })); assert.deepEqual(f.events, []);
});
test('download cancellation closes stream/file and retry starts from zero without resume', async t => {
  let stream, requests = 0;
  const f = await fixture(t, { response: () => { requests++; stream = requests === 1 ? new Readable({ read() {} }) : Readable.from([bytes]); return { statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, stream }; } }); const id = await f.check();
  f.manager.downloadUpdate({ candidateId: id }); while (!stream) await new Promise(resolve => setTimeout(resolve, 1)); stream.push(bytes.subarray(0, 2));
  f.manager.cancelUpdate(); await f.manager.waitForIdle(); assert.equal(f.manager.status().phase, 'cancelled'); assert.equal(f.manager.record, null); assert.ok(stream.destroyed);
  f.manager.downloadUpdate({ candidateId: id }); await f.manager.waitForIdle(); assert.equal(f.manager.status().phase, 'ready'); assert.equal(requests, 2);
});
test('download total/idle timeout cannot execute and reports retriable timeout', async t => {
  const f = await fixture(t, { response: () => ({ statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, stream: new Readable({ read() {} }) }), idleTimeoutMs: 15, downloadTimeoutMs: 30 }); await f.download(); assert.equal(f.manager.status().error.code, 'TIMEOUT'); assert.equal(f.manager.record, null);
});
test('checking is single-flight; prerelease current and numeric comparison never downgrade', async t => {
  const f = await fixture(t, { currentVersion: '0.6.0-candidate.2' }); f.manager.checkUpdate({ channel: 'preview' }); f.manager.checkUpdate({ channel: 'preview' }); await f.manager.waitForIdle(); assert.equal(f.fetches, 1); assert.equal(f.manager.status().phase, 'available');
  for (const version of ['0.6.0', '0.7.0']) { const n = await fixture(t, { currentVersion: version }); n.manager.checkUpdate({ channel: 'preview' }); await n.manager.waitForIdle(); assert.equal(n.manager.status().phase, 'current'); }
});
test('unsupported platform has no network, arbitrary renderer candidate/path/flags are rejected', async t => {
  const f = await fixture(t, { supported: false }); f.manager.checkUpdate(); assert.equal(f.fetches, 0); assert.equal(f.manager.status().phase, 'unsupported');
  for (const input of [{ candidateId: 'a'.repeat(32), path: '/tmp/exe' }, { candidateId: 'https://evil' }, { candidateId: 'a'.repeat(32), confirmed: true }, {}]) assert.throws(() => f.manager.installUpdate(input));
});
test('private updater RPC double-sanitizes state and refuses URL/confirmed smuggling', async t => {
  const f = await fixture(t); const id = await f.download();
  const handler = createDesktopHandler({ updater: f.manager }); let client;
  client = createDesktopClient(message => queueMicrotask(async () => client.receive(await handler(message))));
  assert.equal((await client.api.updateStatus()).candidate.id, id);
  assert.equal((await client.api.cancelUpdate()).phase, 'ready');
  for (const payload of [{ candidateId: id, url: 'https://evil' }, { candidateId: id, confirmed: true }, { candidateId: 'b'.repeat(32) }]) {
    const result = await handler({ type: 'desktop:request', id: 4, method: 'installUpdate', payload }); assert.equal(result.ok, false); assert.ok(!JSON.stringify(result).includes('evil'));
  }
  client.close();
});
test('public state cannot reveal private cache/CDN/auth fields or raw exceptions', async t => {
  const f = await fixture(t); await f.download(); const state = publicUpdateState({ ...f.manager.state, accidental: 'private', error: { code: 'unknown PRIVATE SECRET', message: 'SECRET', retryable: true } });
  assert.ok(!JSON.stringify(state).includes('SECRET')); assert.ok(!JSON.stringify(state).includes('downloadUrl')); assert.ok(!JSON.stringify(state).includes(f.dir));
});
test('owned cache denies symlink/hardlink paths and changed journal without touching targets', async t => {
  const f = await fixture(t); const id = await f.download(); const file = f.manager.record.file, content = readFileSync(file), outside = join(f.dir, 'outside.exe'); writeFileSync(outside, content); rmSync(file); symlinkSync(outside, file);
  await assert.rejects(f.files.verify(f.manager.record, f.manager.candidate)); await f.files.discard(f.manager.record); assert.deepEqual(readFileSync(outside), content); assert.ok(existsSync(file));
  rmSync(file); linkSync(outside, file); await assert.rejects(f.files.verify(f.manager.record, f.manager.candidate)); assert.deepEqual(readFileSync(outside), content); assert.ok(id);
});
test('Windows policy code retains Internet zone/current-user-only checks without installer spawn or security bypass', () => {
  assert.match(WINDOWS_INSPECT_SCRIPT, /ZoneId=3/); assert.match(WINDOWS_INSPECT_SCRIPT, /ReparsePoint/); assert.match(WINDOWS_INSPECT_SCRIPT, /GetOwner/); assert.match(WINDOWS_INSTALL_SCRIPT, /CurrentUser/); assert.match(WINDOWS_INSTALL_SCRIPT, /LocalMachine/); assert.match(WINDOWS_INSTALL_SCRIPT, /OpenSubKey/); assert.equal(INSTALL_GUID, '20be089a-e364-59fe-9bf1-70ea22b78d3f');
  const main = readFileSync(join(__dirname, '../main.cjs'), 'utf8'); assert.match(main, /launch: file => shell\.openPath\(file\)/); assert.ok(!/spawn\(.*installer|Unblock-File|runas|--silent|\/S\b/.test(main));
});
test('file tampering during delayed backend shutdown is rechecked before normal Shell launch', async t => {
  let f; f = await fixture(t, { lifecycle: { shutdown: async () => { writeFileSync(f.manager.record.file, Buffer.alloc(bytes.length, 0)); return true; } } });
  const id = await f.download(); f.manager.installUpdate({ candidateId: id }); await f.manager.waitForIdle();
  assert.equal(f.manager.status().error.code, 'FILE_CHANGED'); assert.deepEqual(f.events, ['confirm', 'prepare', 'recover']);
});
test('next startup cleans owned orphan partials but refuses unknown files and linked targets', async t => {
  const f = await fixture(t), root = join(f.dir, 'updates');
  const owned = join(root, 'a'.repeat(32)), unknown = join(root, 'b'.repeat(32)), linked = join(root, 'c'.repeat(32));
  for (const directory of [owned, unknown, linked]) mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(owned, 'installer.exe.partial'), bytes); writeFileSync(join(unknown, 'user-file.txt'), 'keep');
  const outside = join(f.dir, 'user-outside.txt'); writeFileSync(outside, 'untouched'); symlinkSync(outside, join(linked, 'installer.exe.partial'));
  await createUpdateFiles({ stateRoot: f.dir, privateDirectoryModule: resolve(__dirname, '../../lib/private-directory.mjs'), platform: 'linux' });
  assert.equal(existsSync(owned), false); assert.equal(readFileSync(join(unknown, 'user-file.txt'), 'utf8'), 'keep'); assert.equal(readFileSync(outside, 'utf8'), 'untouched'); assert.ok(existsSync(join(linked, 'installer.exe.partial')));
});

test('default stable requires an explicit preview check before showing unsigned prerelease', async t => {
  const f = await fixture(t); assert.equal(f.manager.status().channel, 'stable'); f.manager.checkUpdate(); await f.manager.waitForIdle();
  assert.equal(f.manager.status().error.code, 'NO_RELEASE'); assert.equal(f.manager.status().candidate, undefined);
  f.manager.checkUpdate({ channel: 'preview' }); await f.manager.waitForIdle(); assert.equal(f.manager.status().channel, 'preview'); assert.equal(f.manager.status().phase, 'available');
});
test('beta1 to beta2 preview is strictly newer and cannot cross into stable, download accepts only opaque current-channel id', async t => {
  const f = await fixture(t, { currentVersion: '0.6.0-beta.1', releaseVersion: '0.6.0-beta.2' }); const id = await f.download();
  assert.equal(f.manager.status().candidate.version, '0.6.0-beta.2'); assert.equal(f.manager.status().phase, 'ready');
  assert.throws(() => f.manager.downloadUpdate({ candidateId: id, channel: 'stable' }));
  f.manager.checkUpdate({ channel: 'stable' }); assert.equal(f.manager.status().channel, 'stable'); assert.equal(f.manager.status().candidate, undefined);
  assert.throws(() => f.manager.installUpdate({ candidateId: id })); await f.manager.waitForIdle();
  assert.equal(f.manager.status().error.code, 'NO_RELEASE'); assert.equal(f.manager.record, null);
});
test('same-version beta and beta downgrade never produce an installable candidate', async t => {
  for (const version of ['0.6.0-beta.2', '0.6.0-beta.3', '0.6.0']) {
    const f = await fixture(t, { currentVersion: version, releaseVersion: '0.6.0-beta.2' }); f.manager.checkUpdate({ channel: 'preview' }); await f.manager.waitForIdle();
    assert.equal(f.manager.status().phase, 'current'); assert.equal(f.manager.status().candidate, undefined);
  }
});
test('beta pending marker can confirm only actual same desktop/backend target after restart', async t => {
  const f = await fixture(t, { currentVersion: '0.6.0-beta.1', releaseVersion: '0.6.0-beta.2' }); const id = await f.download();
  f.manager.installUpdate({ candidateId: id }); await f.manager.waitForIdle(); assert.equal((await f.files.journal.read()).version, '0.6.0-beta.2');
  const next = new UpdateManager({ currentVersion: '0.6.0-beta.2', supported: true, files: f.files, journal: f.files.journal });
  await next.verifyStartup('0.6.0-beta.1'); assert.equal(next.status().phase, 'error');
  await next.verifyStartup('0.6.0-beta.2'); assert.equal(next.status().phase, 'updated');
});
test('private check RPC accepts only the exact two channels; cannot smuggle candidate URL or confirmed', async t => {
  const f = await fixture(t); const handler = createDesktopHandler({ updater: f.manager }); let client;
  client = createDesktopClient(message => queueMicrotask(async () => client.receive(await handler(message))));
  assert.equal((await client.api.updateStatus()).channel, 'stable'); assert.equal((await client.api.checkUpdate({ channel: 'preview' })).channel, 'preview'); await f.manager.waitForIdle();
  for (const payload of [{ channel: 'nightly' }, { channel: 'Preview' }, { channel: 'preview', confirmed: true }, { channel: 'preview', url: 'https://evil.invalid' }]) {
    const result = await handler({ type: 'desktop:request', id: 7, method: 'checkUpdate', payload }); assert.equal(result.ok, false);
  }
  client.close();
});
