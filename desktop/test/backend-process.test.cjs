'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');

function messageOf(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out waiting for ${type}`)); }, 5000);
    function message(m) {
      if (m.type === type) { clearTimeout(timer); child.off('message', message); resolve(m); }
    }
    child.on('message', message);
  });
}

test('sidecar imports backend, uses ephemeral loopback port and closes with parent', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'highway-sidecar-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const serverPath = join(dir, 'fake-server.mjs');
  writeFileSync(serverPath, `import http from 'node:http';\nexport async function startServer({host,port,dataDir,desktopToken}) {\nif(host!=='127.0.0.1'||port!==0||!dataDir||desktopToken.length<32) throw Error('bad contract');\nconst server=http.createServer((req,res)=>res.end('desktop fixture'));\nawait new Promise(resolve=>server.listen(port,host,resolve));\nreturn {server,port:server.address().port,close:()=>new Promise(resolve=>server.close(resolve))};\n}`);
  const child = fork(join(__dirname, '..', 'backend-process.mjs'), [], { silent: true });
  t.after(() => child.kill());
  const ready = messageOf(child, 'ready');
  child.send({ type: 'start', serverPath, dataDir: dir, desktopToken: 'a'.repeat(64) });
  const result = await ready;
  assert.equal((await fetch(`http://127.0.0.1:${result.port}`).then(r => r.text())), 'desktop fixture');
  const exited = once(child, 'exit');
  child.send({ type: 'shutdown' });
  const [code] = await exited;
  assert.equal(code, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${result.port}`));
});

test('sidecar refuses unauthenticated startup', async t => {
  const child = fork(join(__dirname, '..', 'backend-process.mjs'), [], { silent: true });
  t.after(() => child.kill());
  const error = messageOf(child, 'error');
  const exited = once(child, 'exit');
  child.send({ type: 'start', serverPath: '/tmp/not-used.mjs', dataDir: '/tmp/test', desktopToken: '' });
  assert.match((await error).message, /authentication/);
  assert.equal((await exited)[0], 1);
});

test('sidecar does not expose a backend startup exception or invalid credential payload', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'highway-sidecar-error-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const serverPath = join(dir, 'fake-server.mjs');
  const secret = 'SYNTHETIC-SECRET-MUST-NOT-APPEAR-IN-STARTUP-ERROR';
  writeFileSync(serverPath, `export async function startServer() { throw new Error('${secret}'); }`);
  for (const persistedCredentials of [null, { version: 1, entries: [{ secret }] }]) {
    const child = fork(join(__dirname, '..', 'backend-process.mjs'), [], { silent: true });
    t.after(() => child.kill());
    const error = messageOf(child, 'error'), exited = once(child, 'exit');
    child.send({ type: 'start', serverPath, dataDir: dir, desktopToken: 'a'.repeat(64), persistedCredentials });
    assert.equal(JSON.stringify(await error).includes(secret), false);
    assert.equal((await exited)[0], 1);
  }
});
