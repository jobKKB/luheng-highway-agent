'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
function received(child, type) { return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('test response timeout')), 3000); const listener = message => { if (message?.type === type) { clearTimeout(timer); child.off('message', listener); resolve(message); } }; child.on('message', listener); }); }
async function fixture(t, { busy = false, fail = false, neverClose = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'luheng-update-sidecar-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const serverPath = join(dir, 'fake-server.mjs');
  writeFileSync(serverPath, `export async function startServer() { let gated = false; return { port: 54321, version:'0.6.0', prepareForUpdate(){gated=${!busy};return {ready:gated}},releaseUpdateGate(){gated=false},async close(){${neverClose ? "await new Promise(()=>{});" : fail ? "throw new Error('PRIVATE backend error');" : "if(!gated)throw Error('update not prepared');"}}}; }`);
  const child = fork(join(__dirname, '../backend-process.mjs'), [], { silent: true }); t.after(() => child.kill('SIGKILL'));
  const ready = received(child, 'ready'); child.send({ type: 'start', serverPath, dataDir: dir, desktopToken: 'a'.repeat(64) }); assert.equal((await ready).version, '0.6.0');
  return { child };
}
test('sidecar cannot shut down for update before readiness or after release', async t => {
  const { child } = await fixture(t);
  let reply = received(child, 'update:closed'); child.send({ type: 'update:shutdown', id: 1 }); assert.equal((await reply).ok, false); assert.equal(child.exitCode, null);
  reply = received(child, 'update:prepared'); child.send({ type: 'update:prepare', id: 2 }); assert.equal((await reply).ready, true);
  reply = received(child, 'update:released'); child.send({ type: 'update:release', id: 3 }); await reply;
  reply = received(child, 'update:closed'); child.send({ type: 'update:shutdown', id: 4 }); assert.equal((await reply).ok, false); assert.equal(child.exitCode, null);
});
test('sidecar update flush ack precedes actual clean exit; busy work does not close', async t => {
  for (const busy of [true, false]) {
    const { child } = await fixture(t, { busy }); let reply = received(child, 'update:prepared'); child.send({ type: 'update:prepare', id: 1 }); assert.equal((await reply).ready, !busy);
    reply = received(child, 'update:closed'); const exited = busy ? null : once(child, 'exit'); child.send({ type: 'update:shutdown', id: 2 }); assert.equal((await reply).ok, !busy);
    if (exited) assert.equal((await exited)[0], 0); else assert.equal(child.exitCode, null);
  }
});
test('sidecar close failure has no success ack and exposes no backend exception', async t => {
  const { child } = await fixture(t, { fail: true }); let reply = received(child, 'update:prepared'); child.send({ type: 'update:prepare', id: 1 }); await reply;
  reply = received(child, 'update:closed'); const exited = once(child, 'exit'); child.send({ type: 'update:shutdown', id: 2 }); const result = await reply; assert.equal(result.ok, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/); assert.equal((await exited)[0], 1);
});
test('update shutdown has no normal 4-second force-exit fallback or false completed message', async t => {
  const source = readFileSync(join(__dirname, '../backend-process.mjs'), 'utf8');
  const update = source.slice(source.indexOf("if (['update:prepare'"), source.indexOf("if (message?.type === 'shutdown')"));
  assert.doesNotMatch(update, /setTimeout|kill\(/); assert.match(update, /await backend.close\(\); send\(\{ type: 'update:closed'/);
  const { child } = await fixture(t, { neverClose: true }); const reply = received(child, 'update:prepared'); child.send({ type: 'update:prepare', id: 1 }); await reply;
  let closed = false; child.on('message', message => { if (message.type === 'update:closed') closed = true; }); child.send({ type: 'update:shutdown', id: 2 }); await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(closed, false); assert.equal(child.exitCode, null);
});
