import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../lib/store.mjs';
import { Engine } from '../lib/engine.mjs';
import { LocalAccessService, FULL_ACCESS_CONFIRMATION } from '../lib/local-access.mjs';
import { startServer } from '../server.mjs';

// All file contents, credential-shaped paths, command arguments and outputs in
// this independent review are synthetic fixtures below newly created temp dirs.
// No test grants allFiles or reads real home-directory credentials.
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = (file, content = 'synthetic harmless fixture') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
};
async function fixture(t, options = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luheng-local-security-'));
  const root = path.join(base, 'scope');
  const outside = path.join(base, 'outside');
  const data = path.join(base, 'application-data');
  for (const dir of [root, outside]) fs.mkdirSync(dir, { mode: 0o700 });
  const store = new Store(data);
  const service = new LocalAccessService(store, options);
  const engines = [];
  t.after(async () => { for (const engine of engines) await engine.close(); await service.close(); store.close(); fs.rmSync(base, { recursive: true, force: true }); });
  return { base, root, outside, data, store, service, engines, configure: mode => service.configure({ mode, roots: [root], onboardingComplete: true }) };
}
const command = (h, script, timeoutMs = 2000) => ({ kind: 'command', executable: process.execPath, args: ['-e', script], cwd: h.root, timeoutMs });
const rawDatabase = h => ['agent.sqlite', 'agent.sqlite-wal'].map(name => {
  try { return fs.readFileSync(path.join(h.data, name)); } catch { return Buffer.alloc(0); }
});
async function terminalTask(engine, store, id) {
  for (let i = 0; i < 500; i++) {
    const task = store.get('tasks', id);
    if (['completed', 'failed', 'cancelled', 'awaiting_approval', 'needs_attention'].includes(task?.status) && !engine.running.has(id)) return task;
    await wait(5);
  }
  throw new Error('synthetic task did not reach an expected state');
}

test('security: default disabled and read-only enforcement cannot be changed through operation fields', async t => {
  const h = await fixture(t);
  const file = write(path.join(h.root, 'report.txt'));
  assert.equal(h.service.state().mode, 'disabled');
  await assert.rejects(h.service.propose({ kind: 'read', path: file }), /权限/);
  h.configure('read_only');
  assert.equal((await h.service.propose({ kind: 'read', path: file })).result.content, 'synthetic harmless fixture');
  await assert.rejects(h.service.propose({ kind: 'write', path: file, content: 'replacement' }), /只读/);
  await assert.rejects(h.service.propose(command(h, 'process.stdout.write("safe")')), /只读/);
  for (const extra of [{ mode: 'full' }, { approved: true }, { allFiles: true }, { shell: true }, { env: {} }, { actor: 'user' }]) {
    await assert.rejects(h.service.propose({ kind: 'read', path: file, ...extra }), /参数/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic harmless fixture');
});

test('security: scope normalization and path traversal stay within explicit absolute directories', async t => {
  const h = await fixture(t);
  const allowed = write(path.join(h.root, 'nested', 'report.txt'));
  const outside = write(path.join(h.outside, 'report.txt'), 'outside synthetic fixture');
  for (const roots of [['relative'], [path.parse(h.root).root], [allowed], [h.root + '\0']]) {
    assert.throws(() => h.service.configure({ mode: 'read_only', roots }), /路径|绝对|文件夹|整盘/);
  }
  assert.throws(() => h.service.configure({ mode: 'read_only', roots: [h.root], allFiles: 'false' }), /选项/);
  h.service.configure({ mode: 'read_only', roots: [h.root + path.sep, h.root, path.join(h.root, 'nested', '..')] });
  assert.deepEqual(h.service.state().roots, [h.root]);
  assert.equal((await h.service.propose({ kind: 'read', path: path.join(h.root, 'nested', '..', 'nested', 'report.txt') })).result.content, 'synthetic harmless fixture');
  for (const target of [outside, path.join(h.root, '..', 'outside', 'report.txt'), h.root + '-sibling/report.txt']) {
    await assert.rejects(h.service.propose({ kind: 'read', path: target }));
  }
});

test('security: symlink ancestors, link roots and hardlinked files are denied without modifying targets', async t => {
  const h = await fixture(t);
  const outside = write(path.join(h.outside, 'report.txt'), 'outside unchanged');
  const link = path.join(h.root, 'linked');
  fs.symlinkSync(h.outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => h.service.configure({ mode: 'read_only', roots: [link] }), /链接|联接/);
  h.configure('confirm');
  for (const kind of ['read', 'write', 'list']) {
    await assert.rejects(h.service.propose({ kind, path: kind === 'list' ? link : path.join(link, 'report.txt'), ...(kind === 'write' ? { content: 'should never appear' } : {}) }), /链接|联接/);
  }
  const hard = path.join(h.root, 'hard-report.txt');
  fs.linkSync(outside, hard);
  for (const kind of ['read', 'write']) await assert.rejects(h.service.propose({ kind, path: hard, ...(kind === 'write' ? { content: 'should never appear' } : {}) }), /硬链接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside unchanged');
});

test('security: linked authorized root and linked pending target are rechecked at execution time', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  const file = write(path.join(h.root, 'report.txt'), 'original');
  const outside = write(path.join(h.outside, 'report.txt'), 'outside unchanged');
  const pending = await h.service.propose({ kind: 'write', path: file, content: 'approved content' });
  // Windows directory junctions need no symlink privilege; replacing the exact
  // pending file path with a junction still exercises execution-time link denial.
  fs.unlinkSync(file); fs.symlinkSync(process.platform === 'win32' ? h.outside : outside, file, process.platform === 'win32' ? 'junction' : 'file');
  await assert.rejects(h.service.approve(pending.operation.id), /链接|联接/);
  fs.rmSync(h.root, { recursive: true }); fs.symlinkSync(h.outside, h.root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(h.service.propose({ kind: 'read', path: path.join(h.root, 'report.txt') }), /链接|联接/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside unchanged');
});

test('security: application data and known credential-shaped files are refused using synthetic fixtures', async t => {
  const h = await fixture(t, { protectedPaths: [] });
  h.configure('read_only');
  const protectedSynthetic = write(path.join(h.data, 'synthetic-private.txt'));
  await assert.rejects(h.service.propose({ kind: 'read', path: protectedSynthetic }), /内部数据库/);
  for (const name of ['.env', '.env.local', '.ssh/config', '.aws/config', '.gnupg/pubring.kbx', '.codex/config.toml', '.azure/token.txt', '.kube/config', 'credentials.json', 'client.pem', 'signing.key', 'Login Data', 'Cookies']) {
    const file = write(path.join(h.root, name));
    await assert.rejects(h.service.propose({ kind: 'read', path: file }), /凭据/);
  }
});

test('security: common credential stores cannot bypass the direct-file denylist', async t => {
  const h = await fixture(t);
  h.configure('read_only');
  for (const name of ['.npmrc', '.netrc', '.git-credentials', '.docker/config.json', '.config/gcloud/application_default_credentials.json']) {
    const file = write(path.join(h.root, name), 'fake named credential fixture only');
    await assert.rejects(h.service.propose({ kind: 'read', path: file }), /凭据/, `credential-shaped fixture ${name} must be denied`);
  }
});

test('security: full-mode challenges bind exact scope, current revision, confirmation and single use', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  assert.throws(() => h.service.configure({ mode: 'full', roots: [h.root], confirmation: FULL_ACCESS_CONFIRMATION }), /二次确认/);
  const request = h.service.requestFullAccess({ roots: [h.root] });
  for (const input of [
    { roots: [h.outside], confirmation: FULL_ACCESS_CONFIRMATION },
    { roots: [h.root], allFiles: true, confirmation: FULL_ACCESS_CONFIRMATION },
    { roots: [h.root], confirmation: 'yes' },
  ]) assert.throws(() => h.service.configure({ mode: 'full', challenge: request.challenge, ...input }), /二次确认/);
  h.service.configure({ mode: 'full', roots: [h.root], challenge: request.challenge, confirmation: FULL_ACCESS_CONFIRMATION });
  assert.equal(h.service.state().mode, 'full');
  assert.equal(h.service.state().allFiles, false);
  assert.throws(() => h.service.configure({ mode: 'full', roots: [h.root], challenge: request.challenge, confirmation: FULL_ACCESS_CONFIRMATION }), /二次确认/);
  const fresh = h.service.requestFullAccess({ roots: [h.root] });
  h.configure('confirm');
  assert.throws(() => h.service.configure({ mode: 'full', roots: [h.root], challenge: fresh.challenge, confirmation: FULL_ACCESS_CONFIRMATION }), /二次确认/);
  const expired = h.service.requestFullAccess({ roots: [h.root] });
  h.service.challenges.get(expired.challenge).expiresAt = Date.now() - 1;
  assert.throws(() => h.service.configure({ mode: 'full', roots: [h.root], challenge: expired.challenge, confirmation: FULL_ACCESS_CONFIRMATION }), /二次确认/);
});

test('security: confirm writes use a detached exact snapshot and consume approval once', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  const file = path.join(h.root, 'new-report.txt');
  const input = { kind: 'write', path: file, content: 'exact approved fixture' };
  const proposed = await h.service.propose(input);
  assert.equal(fs.existsSync(file), false);
  input.content = 'mutated caller input'; proposed.operation.snapshot.content = 'mutated public snapshot';
  const [first, replay] = await Promise.allSettled([h.service.approve(proposed.operation.id), h.service.approve(proposed.operation.id)]);
  assert.equal(first.status, 'fulfilled'); assert.equal(replay.status, 'rejected');
  assert.equal(fs.readFileSync(file, 'utf8'), 'exact approved fixture');
  const rejected = await h.service.propose({ kind: 'write', path: file, content: 'never write this' });
  h.service.reject(rejected.operation.id);
  await assert.rejects(h.service.approve(rejected.operation.id), /失效|已处理/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'exact approved fixture');
});

test('security: payload tampering, expiry and revoke invalidate pending operations', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  const file = path.join(h.root, 'never-written.txt');
  const tampered = await h.service.propose({ kind: 'write', path: file, content: 'one' });
  h.service.operations.get(tampered.operation.id).payload.content = 'two';
  await assert.rejects(h.service.approve(tampered.operation.id), /内容已变化/);
  const expired = await h.service.propose({ kind: 'write', path: file, content: 'one' });
  h.service.operations.get(expired.operation.id).expiresAt = Date.now() - 1;
  await assert.rejects(h.service.approve(expired.operation.id), /失效/);
  const revoked = await h.service.propose({ kind: 'write', path: file, content: 'one' });
  h.service.revoke();
  await assert.rejects(h.service.approve(revoked.operation.id), /失效/);
  assert.equal(fs.existsSync(file), false);
});

test('security: text/output limits and memory-held synthetic secrets fail closed or redact', async t => {
  const secret = 'FAKE_LOCAL_SECRET_FOR_REVIEW_713';
  const h = await fixture(t, { getSecrets: () => [secret] });
  h.configure('confirm');
  const oversized = write(path.join(h.root, 'large.txt'), 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(h.service.propose({ kind: 'read', path: oversized }), /256KiB/);
  const binary = write(path.join(h.root, 'binary.txt'), 'test\0fixture');
  await assert.rejects(h.service.propose({ kind: 'read', path: binary }), /纯文本/);
  const redacted = write(path.join(h.root, 'redact.txt'), `${secret}\npassword=fake-credential-value\n-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----`);
  const result = await h.service.propose({ kind: 'read', path: redacted });
  assert.ok(!result.result.content.includes(secret));
  assert.ok(!result.result.content.includes('fake-credential-value'));
  assert.ok(!result.result.content.includes('synthetic'));
  await assert.rejects(h.service.propose({ kind: 'write', path: path.join(h.root, 'write.txt'), content: secret }), /内存凭据/);
  await assert.rejects(h.service.propose(command(h, `process.stdout.write(${JSON.stringify(secret)})`)), /内存凭据/);
});

test('security: commands execute exact argv without shell interpolation and stripped credential environment', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  const previous = process.env.HIGHWAY_SECURITY_REVIEW_SECRET;
  const oldOptions = process.env.NODE_OPTIONS;
  process.env.HIGHWAY_SECURITY_REVIEW_SECRET = 'FAKE_ENV_SHOULD_NOT_REACH_CHILD';
  process.env.NODE_OPTIONS = '--this-is-not-a-real-node-option';
  t.after(() => { if (previous === undefined) delete process.env.HIGHWAY_SECURITY_REVIEW_SECRET; else process.env.HIGHWAY_SECURITY_REVIEW_SECRET = previous; if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions; });
  const literal = 'literal; $(echo should-not-run) | &';
  const proposed = await h.service.propose({ ...command(h, 'process.stdout.write(JSON.stringify({argv:process.argv[1], leaked:process.env.HIGHWAY_SECURITY_REVIEW_SECRET||null, nodeOptions:process.env.NODE_OPTIONS||null, home:process.env.HOME||null}))'), args: ['-e', 'process.stdout.write(JSON.stringify({argv:process.argv[1], leaked:process.env.HIGHWAY_SECURITY_REVIEW_SECRET||null, nodeOptions:process.env.NODE_OPTIONS||null, home:process.env.HOME||null}))', literal] });
  const result = await h.service.approve(proposed.operation.id);
  assert.deepEqual(JSON.parse(result.result.stdout), { argv: literal, leaked: null, nodeOptions: null, home: null });
  assert.equal(result.result.executionBoundary, 'host_process_no_os_sandbox');
});

test('security: quoted and backslashed in-memory credentials cannot be written or passed as command argv', async t => {
  const secrets = ['FAKE_REVIEW_QUOTED_PASSWORD_"713', 'FAKE_REVIEW_BACKSLASH_PASSWORD_\\714'];
  const h = await fixture(t, { getSecrets: () => secrets });
  h.configure('confirm');
  for (const secret of secrets) {
    await assert.rejects(h.service.propose({ kind: 'write', path: path.join(h.root, 'never-secret.txt'), content: secret }), /内存凭据/);
    await assert.rejects(h.service.propose({ ...command(h, 'process.stdout.write("safe")'), args: ['-e', 'process.stdout.write("safe")', secret] }), /内存凭据/);
  }
});

test('security: newly registered credentials invalidate matching pending payloads before exposure or execution', async t => {
  let secrets = [];
  const h = await fixture(t, { getSecrets: () => secrets });
  h.configure('confirm');
  const marker = 'FAKE_LATE_REGISTERED_REVIEW_CREDENTIAL_971';
  const file = path.join(h.root, 'never-secret.txt');
  const writeOp = await h.service.propose({ kind: 'write', path: file, content: marker });
  const commandOp = await h.service.propose({ ...command(h, 'process.stdout.write("safe")'), args: ['-e', 'process.stdout.write("safe")', marker] });
  secrets = [marker];
  const state = h.service.state();
  assert.equal(state.pending.length, 0);
  assert.equal(JSON.stringify(state).includes(marker), false);
  for (const operation of [writeOp.operation, commandOp.operation]) {
    await assert.rejects(h.service.approve(operation.id), /失效|已处理/);
    assert.equal(h.store.get('local_operations', operation.id).status, 'invalidated');
  }
  assert.equal(fs.existsSync(file), false);
  for (const bytes of rawDatabase(h)) assert.equal(bytes.includes(Buffer.from(marker)), false);
});

test('security: executable/cwd changes and disallowed timeout parameters are rejected', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  for (const timeoutMs of [0, 99, 60001, 1.5, '1000']) await assert.rejects(h.service.propose(command(h, 'process.stdout.write("safe")', timeoutMs)), /超时/);
  await assert.rejects(h.service.propose({ ...command(h, 'process.stdout.write("safe")'), cwd: h.outside }), /范围/);
  const executable = path.join(h.root, process.platform === 'win32' ? 'copied-node.exe' : 'copied-node');
  fs.copyFileSync(fs.realpathSync(process.execPath), executable); fs.chmodSync(executable, 0o700);
  const proposed = await h.service.propose({ ...command(h, 'process.stdout.write("safe")'), executable });
  fs.utimesSync(executable, new Date(0), new Date(0));
  await assert.rejects(h.service.approve(proposed.operation.id), /程序在审批后已变化/);
});

test('security: timeout and excessive stdout terminate harmless processes', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  for (const [script, timeoutMs, error, maximumElapsed] of [
    ['setInterval(()=>{},100)', 150, /执行时限/, 4000],
    ['process.stdout.write("x".repeat(80*1024));setInterval(()=>{},100)', 5000, /输出超过/, 8000],
  ]) {
    const proposed = await h.service.propose(command(h, script, timeoutMs));
    const before = Date.now();
    await assert.rejects(h.service.approve(proposed.operation.id), error);
    assert.ok(Date.now() - before < maximumElapsed);
    assert.equal(h.service.running.size, 0);
  }
});

test('security: revoke terminates managed process group and prevents later fixture-file loop writes', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  const marker = path.join(h.root, 'loop.txt');
  const descendant = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),20)`;
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},100)`;
  const proposed = await h.service.propose(command(h, script, 7500));
  const outcome = h.service.approve(proposed.operation.id).then(value => ({ value }), error => ({ error }));
  const startupDeadline = Date.now() + 5000;
  while (!fs.existsSync(marker) && Date.now() < startupDeadline) await wait(10);
  assert.ok(fs.existsSync(marker), 'harmless descendant loop must have started');
  h.service.revoke();
  const settled = await outcome;
  assert.match(settled.error?.message || '', /撤销|取消/);
  await wait(100); const size = fs.statSync(marker).size;
  await wait(150); assert.equal(fs.statSync(marker).size, size);
  assert.equal(h.service.running.size, 0);
  assert.equal(h.service.state().mode, 'disabled');
});

test('security: concurrent commands stay bounded and service close awaits managed process termination', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await h.service.propose(command(h, 'setInterval(()=>{},100)', 3000))).operation.id);
  const first = h.service.approve(ids[0]).then(value => ({ value }), error => ({ error }));
  const second = h.service.approve(ids[1]).then(value => ({ value }), error => ({ error }));
  assert.equal(h.service.running.size, 2);
  await assert.rejects(h.service.approve(ids[2]), /并发上限/);
  assert.equal(h.service.operations.get(ids[2]).status, 'failed');
  assert.equal(h.service.running.size, 2, 'the rejected third command must never start');
  assert.ok(!h.service.state().pending.some(operation => operation.id === ids[2]));
  await assert.rejects(h.service.approve(ids[2]), /失效|已处理/);
  await h.service.close();
  assert.equal(h.service.running.size, 0);
  assert.equal(h.service.inflight.size, 0);
  assert.ok((await first).error); assert.ok((await second).error);
  assert.equal(h.service.operations.get(ids[2]).status, 'failed');
  await assert.rejects(h.service.propose(command(h, 'process.stdout.write("safe")')), /权限|关闭/);
});

test('security: historical operation memory is pruned without retaining unbounded session payloads', async t => {
  const h = await fixture(t);
  h.configure('read_only');
  const file = write(path.join(h.root, 'report.txt'));
  for (let i = 0; i < 130; i++) await h.service.propose({ kind: 'read', path: file });
  // Pruning runs before inserting the newest record; retention is bounded to
  // the previous 100 records plus that one newly completed operation.
  assert.ok(h.service.operations.size <= 101);
  assert.ok(h.service.state().operations.length <= 100);
});

test('security: native operation SQLite records omit file content, argv and outputs', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  const fileMarker = 'REVIEW_LOCAL_FILE_CONTENT_MUST_STAY_MEMORY_913';
  const commandMarker = 'REVIEW_COMMAND_ARGUMENT_AND_OUTPUT_MEMORY_927';
  const writeOp = await h.service.propose({ kind: 'write', path: path.join(h.root, 'report.txt'), content: fileMarker });
  await h.service.approve(writeOp.operation.id);
  const commandOp = await h.service.propose(command(h, `process.stdout.write(${JSON.stringify(commandMarker)})`));
  assert.equal((await h.service.approve(commandOp.operation.id)).result.stdout, commandMarker);
  assert.ok(!JSON.stringify(h.store.all('local_operations')).includes(fileMarker));
  assert.ok(!JSON.stringify(h.store.all('local_operations')).includes(commandMarker));
  for (const bytes of rawDatabase(h)) for (const marker of [fileMarker, commandMarker]) assert.equal(bytes.includes(Buffer.from(marker)), false);
});

test('security: restart downgrades full mode and never replays session-only pending approvals', async t => {
  const h = await fixture(t);
  const request = h.service.requestFullAccess({ roots: [h.root] });
  h.service.configure({ mode: 'full', roots: [h.root], challenge: request.challenge, confirmation: FULL_ACCESS_CONFIRMATION });
  const restarted = new LocalAccessService(h.store);
  assert.equal(restarted.state().mode, 'confirm'); assert.equal(restarted.state().allFiles, false);
  const file = path.join(h.root, 'never-replayed.txt');
  const proposed = await restarted.propose({ kind: 'write', path: file, content: 'safe fixture' });
  const next = new LocalAccessService(h.store);
  await assert.rejects(next.approve(proposed.operation.id), /失效|不存在/);
  assert.equal(h.store.get('local_operations', proposed.operation.id).status, 'invalidated');
  assert.equal(fs.existsSync(file), false);
  await restarted.close(); await next.close();
});

test('security: model-echoed native data remains visible only in live memory and never enters SQLite', async t => {
  const h = await fixture(t);
  h.configure('read_only');
  const marker = 'REVIEW_MODEL_ECHO_LOCAL_CONTENT_MUST_NOT_PERSIST_947';
  const file = write(path.join(h.root, 'report.txt'), marker);
  h.store.put('settings', 'main', { ...h.store.get('settings', 'main'), mode: 'api', model: 'synthetic', budget: 15 });
  let round = 0;
  const engine = new Engine(h.store, { async close() {}, async stop() {} }, {
    localAccess: h.service, delay: 1, getKey: () => '',
    completion: async () => round++ === 0 ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'review_read', type: 'function', function: { name: 'local_read_file', arguments: JSON.stringify({ path: file }) } }] } } : { message: { role: 'assistant', content: marker } },
  });
  h.engines.push(engine);
  const created = engine.create({ prompt: 'Read the synthetic review report and return its text' });
  const persisted = await terminalTask(engine, h.store, created.id);
  assert.equal(persisted.status, 'completed', persisted.error);
  assert.ok(engine.task(created.id).output.includes(marker), 'live result must remain usable');
  assert.equal(JSON.stringify(h.store.all('tasks')).includes(marker), false, 'SQLite task metadata must not persist model-echoed local text');
  assert.equal(JSON.stringify(h.store.all('audit')).includes(marker), false);
  for (const bytes of rawDatabase(h)) assert.equal(bytes.includes(Buffer.from(marker)), false);
});

test('security: provider errors echoing native data never enter persistent task/audit logs', async t => {
  const h = await fixture(t);
  h.configure('read_only');
  const marker = 'REVIEW_PROVIDER_ERROR_LOCAL_ECHO_MUST_NOT_PERSIST_953';
  const file = write(path.join(h.root, 'report.txt'), marker);
  h.store.put('settings', 'main', { ...h.store.get('settings', 'main'), mode: 'api', model: 'synthetic', budget: 15 });
  let round = 0;
  const engine = new Engine(h.store, { async close() {}, async stop() {} }, {
    localAccess: h.service, delay: 1, getKey: () => '',
    completion: async () => {
      if (round++ === 0) return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'review_read_error', type: 'function', function: { name: 'local_read_file', arguments: JSON.stringify({ path: file }) } }] } };
      throw new Error('synthetic provider echo: ' + marker);
    },
  });
  h.engines.push(engine);
  const created = engine.create({ prompt: 'Read the synthetic report fixture' });
  assert.equal((await terminalTask(engine, h.store, created.id)).status, 'failed');
  assert.ok(engine.task(created.id).error.includes(marker), 'live error detail remains useful');
  assert.equal(JSON.stringify(h.store.all('tasks')).includes(marker), false);
  assert.equal(JSON.stringify(h.store.all('audit')).includes(marker), false);
  for (const bytes of rawDatabase(h)) assert.equal(bytes.includes(Buffer.from(marker)), false);
});

test('security: revoked role permissions and tampered model calls cannot bypass exact task approval', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  h.store.put('settings', 'main', { ...h.store.get('settings', 'main'), mode: 'api', model: 'synthetic', budget: 30 });
  const file = path.join(h.root, 'never-write.txt');
  let round = 0;
  const engine = new Engine(h.store, { async close() {}, async stop() {} }, {
    localAccess: h.service, delay: 1, getKey: () => '',
    completion: async () => round++ < 2 ? { message: { role: 'assistant', content: null, tool_calls: [{ id: 'review_write_' + round, type: 'function', function: { name: 'local_write_file', arguments: JSON.stringify({ path: file, content: 'exact pending fixture' }) } }] } } : { message: { role: 'assistant', content: 'done' } },
  });
  h.engines.push(engine);
  const first = engine.create({ prompt: 'Write the synthetic review fixture' });
  assert.equal((await terminalTask(engine, h.store, first.id)).status, 'awaiting_approval');
  const firstApproval = h.store.all('approvals').find(a => a.taskId === first.id && a.type === 'local.write');
  assert.ok(firstApproval);
  engine.localTasks.get(first.id).toolQueue[0].function.arguments = JSON.stringify({ path: file, content: 'different content' });
  await assert.rejects(engine.decide(firstApproval.id, 'approve'), /不一致|失效/);
  assert.equal(fs.existsSync(file), false);
  engine.cancel(first.id);
  const second = engine.create({ prompt: 'Write another harmless synthetic review fixture' });
  assert.equal((await terminalTask(engine, h.store, second.id)).status, 'awaiting_approval');
  const secondApproval = h.store.all('approvals').find(a => a.taskId === second.id && a.type === 'local.write');
  const actor = h.store.get('agents', 'coordinator');
  h.store.put('agents', actor.id, { ...actor, permissions: actor.permissions.filter(p => p !== 'files.write') });
  await engine.decide(secondApproval.id, 'approve');
  assert.equal(fs.existsSync(file), false);
  assert.ok(['failed', 'needs_attention'].includes(h.store.get('tasks', second.id).status));
});

test('security: started failing commands retain an explicit possible-side-effect warning', async t => {
  const h = await fixture(t);
  h.configure('confirm');
  h.store.put('settings', 'main', { ...h.store.get('settings', 'main'), mode: 'api', model: 'synthetic', budget: 30 });
  const file = path.join(h.root, 'side-effect-fixture.txt');
  const payload = command(h, `require('node:fs').writeFileSync(${JSON.stringify(file)},'safe fixture effect');setInterval(()=>{},100)`, 150);
  const { kind, ...args } = payload;
  const engine = new Engine(h.store, { async close() {}, async stop() {} }, {
    localAccess: h.service, delay: 1, getKey: () => '',
    completion: async () => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'review_failure', type: 'function', function: { name: 'local_run_command', arguments: JSON.stringify(args) } }] } }),
  });
  h.engines.push(engine);
  const created = engine.create({ prompt: 'Run the harmless timeout review fixture' });
  assert.equal((await terminalTask(engine, h.store, created.id)).status, 'awaiting_approval');
  const approval = h.store.all('approvals').find(a => a.taskId === created.id && a.type === 'local.command');
  await engine.decide(approval.id, 'approve');
  assert.equal(fs.readFileSync(file, 'utf8'), 'safe fixture effect');
  assert.equal(h.store.get('tasks', created.id).status, 'needs_attention');
  assert.match(engine.task(created.id).error, /副作用|撤回|人工核实/);
});

test('security: full-mode command timeout preserves the same possible-side-effect warning', async t => {
  const h = await fixture(t);
  const challenge = h.service.requestFullAccess({ roots: [h.root] });
  h.service.configure({ mode: 'full', roots: [h.root], challenge: challenge.challenge, confirmation: FULL_ACCESS_CONFIRMATION });
  h.store.put('settings', 'main', { ...h.store.get('settings', 'main'), mode: 'api', model: 'synthetic', budget: 30 });
  const file = path.join(h.root, 'full-side-effect-fixture.txt');
  const { kind, ...args } = command(h, `require('node:fs').writeFileSync(${JSON.stringify(file)},'safe fixture effect');setInterval(()=>{},100)`, 150);
  const engine = new Engine(h.store, { async close() {}, async stop() {} }, {
    localAccess: h.service, delay: 1, getKey: () => '',
    completion: async () => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'review_full_failure', type: 'function', function: { name: 'local_run_command', arguments: JSON.stringify(args) } }] } }),
  });
  h.engines.push(engine);
  const created = engine.create({ prompt: 'Run the harmless full-mode timeout review fixture' });
  const persisted = await terminalTask(engine, h.store, created.id);
  assert.equal(fs.readFileSync(file, 'utf8'), 'safe fixture effect');
  assert.equal(persisted.status, 'needs_attention');
  assert.match(engine.task(created.id).error, /副作用|撤回|人工核实/);
});

test('security: full-mode partial file-I/O failure warns that fixture contents may already have changed', async t => {
  const h = await fixture(t);
  const challenge = h.service.requestFullAccess({ roots: [h.root] });
  h.service.configure({ mode: 'full', roots: [h.root], challenge: challenge.challenge, confirmation: FULL_ACCESS_CONFIRMATION });
  h.store.put('settings', 'main', { ...h.store.get('settings', 'main'), mode: 'api', model: 'synthetic', budget: 30 });
  const file = write(path.join(h.root, 'partial-write-fixture.txt'), 'original harmless fixture');
  const marker = 'REVIEW_PARTIAL_WRITE_FIXTURE_991';
  const engine = new Engine(h.store, { async close() {}, async stop() {} }, {
    localAccess: h.service, delay: 1, getKey: () => '',
    completion: async () => ({ message: { role: 'assistant', content: null, tool_calls: [{ id: 'review_partial_write', type: 'function', function: { name: 'local_write_file', arguments: JSON.stringify({ path: file, content: marker }) } }] } }),
  });
  h.engines.push(engine);
  const originalFsync = fs.fsyncSync;
  let persisted, created;
  try {
    // Deterministic synthetic failure after the authorized write, without filling
    // a disk or modifying any file outside this test's isolated temp directory.
    fs.fsyncSync = () => { throw new Error('synthetic review fsync failure'); };
    created = engine.create({ prompt: 'Write the harmless partial-I/O review fixture' });
    persisted = await terminalTask(engine, h.store, created.id);
  } finally { fs.fsyncSync = originalFsync; }
  assert.equal(fs.readFileSync(file, 'utf8'), marker);
  assert.equal(persisted.status, 'needs_attention');
  assert.match(engine.task(created.id).error, /副作用|撤回|人工核实/);
  for (const bytes of rawDatabase(h)) assert.equal(bytes.includes(Buffer.from(marker)), false);
});

test('security: local HTTP mutations require session, correct host/origin and exact operation schema', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'luheng-local-http-security-'));
  const root = path.join(base, 'scope'); fs.mkdirSync(root);
  const app = await startServer({ port: 0, dataDir: path.join(base, 'data'), stepDelay: 1, scheduleOptions: { startTimer: false } });
  t.after(async () => { await app.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const cookie = (await fetch(app.url + '/')).headers.get('set-cookie').split(';')[0];
  const request = async (route, body, extras = {}) => fetch(app.url + route, { method: 'POST', headers: { cookie, origin: app.url, 'content-type': 'application/json', ...extras }, body: JSON.stringify(body) });
  assert.equal((await request('/api/local-access/configure', { mode: 'read_only', roots: [root] }, { cookie: '' })).status, 401);
  assert.equal((await request('/api/local-access/configure', { mode: 'read_only', roots: [root] }, { origin: 'https://attacker.invalid' })).status, 403);
  const wrongHostStatus = await new Promise((resolve, reject) => {
    const req = http.request(app.url + '/api/local-access/configure', { method: 'POST', headers: { host: 'attacker.invalid', cookie, origin: app.url, 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(JSON.stringify({ mode: 'read_only', roots: [root] }));
  });
  assert.equal(wrongHostStatus, 403);
  assert.equal((await request('/api/local-access/configure', { mode: 'read_only', roots: [root], unexpected: true })).status, 400);
  assert.equal((await request('/api/local-access/configure', { mode: 'read_only', roots: [root] })).status, 200);
  const file = write(path.join(root, 'report.txt'));
  assert.equal((await request('/api/local-access/operations', { kind: 'write', path: file, content: 'never', approved: true })).status, 400);
  assert.equal((await request('/api/local-access/operations', { kind: 'command', executable: process.execPath, args: ['-e', 'process.stdout.write("safe")'], cwd: root })).status, 400);
  assert.equal(fs.readFileSync(file, 'utf8'), 'synthetic harmless fixture');
});
