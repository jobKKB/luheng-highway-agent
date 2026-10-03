// CI probe only. No production-code changes or downloads. Execute "probe" using
// the INSTALLED application EXE with ELECTRON_RUN_AS_NODE=1, never the CI Node.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const within = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith('../') && !r.startsWith('..\\') && !isAbsolute(r); };
export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inventory(root, prefix = '') {
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Inventory root must be a real directory');
  const result = {};
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name), stat = lstatSync(path), key = prefix + name;
    assert.ok(!stat.isSymbolicLink(), `Links are not allowed: ${key}`);
    if (stat.isDirectory()) Object.assign(result, await inventory(path, `${key}/`));
    else { assert.ok(stat.isFile(), `Not a regular file: ${key}`); result[key] = { size: stat.size, sha256: await sha256(path) }; }
  }
  return result;
}
export async function bindPayload(unpacked, installed) {
  const source = await inventory(unpacked), target = await inventory(installed);
  const extras = Object.keys(target).filter(name => !Object.hasOwn(source, name));
  // Generated NSIS support files are not part of electron-builder's win-unpacked.
  assert.ok(extras.includes('Uninstall Luheng Office Agent.exe'), 'Generated NSIS uninstaller missing');
  assert.ok(extras.every(name => ['Uninstall Luheng Office Agent.exe', 'uninstallerIcon.ico'].includes(name)), `Unexpected installed files: ${extras}`);
  for (const [name, expected] of Object.entries(source)) assert.deepEqual(target[name], expected, `Installed payload differs: ${name}`);
  return { status: 'installed-payload-bound', filesChecked: Object.keys(source).length, installedSupportFiles: Object.fromEntries(extras.map(name => [name, target[name]])), files: source };
}
// Small independent OOXML ZIP validator adapted from tests/office-artifacts.test.mjs.
export function unpackOOXML(buffer) {
  assert.ok(Buffer.isBuffer(buffer) && buffer.length >= 22);
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50, 'Missing ZIP end record');
  assert.equal(buffer.readUInt16LE(end + 20), 0, 'Unexpected ZIP comment');
  const entries = buffer.readUInt16LE(end + 10), parts = new Map();
  let cursor = buffer.readUInt32LE(end + 16);
  assert.ok(entries > 0 && entries < 100);
  for (let i = 0; i < entries; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    assert.equal(buffer.readUInt16LE(cursor + 10), 8, 'Expected deflated OOXML');
    const size = buffer.readUInt32LE(cursor + 20), rawSize = buffer.readUInt32LE(cursor + 24);
    assert.ok(rawSize < 10 * 1024 * 1024, 'Unexpected OOXML part size');
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42), name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const data = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = inflateRawSync(buffer.subarray(data, data + size), { maxOutputLength: 10 * 1024 * 1024 });
    assert.equal(raw.length, rawSize);
    let crc = 0xffffffff;
    for (const byte of raw) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    assert.equal((crc ^ 0xffffffff) >>> 0, buffer.readUInt32LE(cursor + 16), 'ZIP CRC mismatch');
    assert.ok(!parts.has(name)); parts.set(name, raw.toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end); return parts;
}
async function probe(installed, workDir, out) {
  assert.equal(process.platform, 'win32', 'Native probe requires Windows');
  assert.ok(process.versions.electron, 'Probe must use packaged Electron, not system Node');
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Bundled Node must be >=24');
  assert.ok(process.versions.sqlite, 'Bundled Node must include SQLite');
  assert.equal(resolve(process.execPath).toLowerCase(), join(installed, 'Luheng Office Agent.exe').toLowerCase());
  assert.ok(!within(installed, out) && !within(installed, workDir), 'Probe output and state must be outside the installation');
  const backend = join(installed, 'resources', 'backend');
  const expected = JSON.parse(readFileSync(join(backend, 'package.json'), 'utf8'));
  assert.equal(expected.version, '0.6.0-beta.2', 'This gate is pinned to the exact generic workspace candidate');
  const manifest = JSON.parse(readFileSync(join(installed, 'resources', 'bundle-manifest.json'), 'utf8'));
  const executable = resolve(installed, 'resources', 'browser-runtime', manifest.browserExecutable);
  assert.ok(within(join(installed, 'resources', 'browser-runtime'), executable));
  assert.equal(await sha256(executable), manifest.browserExecutableSha256);
  for (const key of ['HIGHWAY_CHROMIUM_PATH', 'CHROME_EXECUTABLE', 'CHROMIUM_PATH', 'NODE_PATH']) delete process.env[key];
  process.env.HIGHWAY_BUNDLED_BROWSER = '1';
  process.env.HIGHWAY_BUNDLED_BROWSER_EXECUTABLE = executable;
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(installed, 'resources', 'browser-runtime');
  const require = createRequire(join(backend, 'package.json')), packages = {};
  for (const name of Object.keys(expected.dependencies)) {
    const entry = require.resolve(name); assert.ok(within(join(backend, 'node_modules'), entry));
    require(name); // Execute dependency entry points with the bundled runtime.
    packages[name] = { version: require(`${name}/package.json`).version, entry: relative(backend, entry).replaceAll('\\', '/') };
    assert.equal(packages[name].version, expected.dependencies[name]);
  }
  const { startServer } = await import(pathToFileURL(join(backend, 'server.mjs')).href);
  let app, runtimeBrowser;
  try {
    const call = (name,args,id) => ({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
    app = await startServer({ port: 0, dataDir: workDir, stepDelay: 1, completion: async request => ({message:{role:'assistant',content:null,
      tool_calls: request.messages.some(message=>message.role==='tool')
        ? [call('agent_finish',{status:'completed',summary:'Synthetic generic report created for native runtime verification.',claimType:'action',evidenceToolCallIds:['native-save']},'native-finish')]
        : [call('workspace_save',{name:'native-generic.txt',content:'SYNTHETIC GENERIC REPORT; test-only, no business demo.'},'native-save')]}}) });
    // Explicit non-local synthetic role for persistent document export; native
    // local-operation privacy is tested separately below using exact approvals.
    app.store.put('agents','coordinator',{...app.store.get('agents','coordinator'),permissions:['knowledge.read','workspace.write']});
    const get = async (path, cookie) => {
      const r = await fetch(app.url + path, { headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(10000) });
      assert.ok(r.ok, `GET ${path}: ${r.status}`); return r;
    };
    const health = await (await get('/health')).json();
    assert.equal(health.ok, true); assert.equal(health.localOnly, true); assert.equal(health.version, expected.version);
    const cookie = (await get('/')).headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
    const state = await (await get('/api/state', cookie)).json(); assert.equal(state.system.version, expected.version);
    const post = async (path, body) => {
      const response = await fetch(app.url + path, { method: 'POST', headers: { cookie, origin: app.url, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
      const result = await response.json(); assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`); return result;
    };
    const task = await post('/api/tasks', { prompt: 'Create a synthetic generic test report' });
    const deadline = Date.now() + 30000;
    while (!['completed', 'failed', 'cancelled'].includes(app.engine.task(task.id).status)) {
      assert.ok(Date.now() < deadline, 'Synthetic API tool report exceeded 30 seconds'); await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(app.engine.task(task.id).status, 'completed');
    const artifacts = [];
    for (const format of ['docx', 'xlsx']) {
      const exported = await post(`/api/tasks/${task.id}/export`, { format });
      const response = await get(exported.url, cookie), data = Buffer.from(await response.arrayBuffer());
      assert.equal(data.length, exported.size); assert.ok(data.length > 1000);
      assert.equal(response.headers.get('content-type').split(';')[0], exported.mimeType);
      const parts = unpackOOXML(data);
      assert.ok(parts.has('[Content_Types].xml'));
      assert.ok(parts.has(format === 'docx' ? 'word/document.xml' : 'xl/worksheets/sheet1.xml'));
      assert.ok([...parts.values()].every(xml => !/vbaProject|TargetMode="External"|<w:instrText/.test(xml)));
      artifacts.push({ format, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), parts: parts.size, mimeType: exported.mimeType });
    }
    // Exercise only synthetic files and exact harmless commands inside this
    // disposable runner. This is a host-process permission feature, not an OS sandbox.
    const selected = join(workDir, '..', 'native-selected-files');
    mkdirSync(selected, { recursive: false });
    const localMarker = 'LUHENG_NATIVE_LOCAL_ONLY_731';
    const localFile = join(selected, 'approved.txt');
    const localInitial = await (await get('/api/local-access/state', cookie)).json();
    assert.equal(localInitial.mode, 'disabled');
    await post('/api/local-access/configure', { mode: 'confirm', roots: [selected], allFiles: false, onboardingComplete: true });
    const approveLocal = async operation => {
      assert.equal(operation.pending, true); assert.equal(operation.operation.status, 'pending');
      return post(`/api/local-access/operations/${operation.operation.id}/approve`, { digest: operation.operation.digest });
    };
    const proposed = await post('/api/local-access/operations', { kind: 'write', path: localFile, content: localMarker });
    assert.equal(existsSync(localFile), false, 'Pending approval must not write a file');
    assert.equal((await approveLocal(proposed)).operation.status, 'completed');
    assert.equal(readFileSync(localFile, 'utf8'), localMarker);
    const read = await post('/api/local-access/operations', { kind: 'read', path: localFile });
    assert.equal(read.result.content, localMarker);
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    assert.ok(systemRoot && isAbsolute(systemRoot));
    const command = async code => approveLocal(await post('/api/local-access/operations', {
      kind: 'command', executable: join(systemRoot, 'System32', 'cmd.exe'),
      args: ['/d', '/c', code], cwd: selected, timeoutMs: 5000,
    }));
    const commandOK = await command('echo LUHENG_NATIVE_LOCAL_ONLY_731');
    assert.equal(commandOK.result.exitCode, 0); assert.equal(commandOK.operation.status, 'completed');
    assert.match(commandOK.result.stdout, /LUHENG_NATIVE_LOCAL_ONLY_731/);
    const commandFailed = await command('exit /b 7');
    assert.equal(commandFailed.result.exitCode, 7); assert.equal(commandFailed.operation.status, 'failed');
    assert.ok(!JSON.stringify(app.store.db.prepare('SELECT * FROM records').all()).includes(localMarker), 'Local payload entered SQLite records');
    const databaseFiles = readdirSync(workDir).filter(name => /\.(?:sqlite|db)(?:-(?:wal|shm))?$/.test(name));
    assert.ok(databaseFiles.length, 'Expected synthetic database files for raw-byte privacy check');
    for (const name of databaseFiles) {
      const file = join(workDir, name); assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
      assert.ok(!readFileSync(file).includes(Buffer.from(localMarker)), 'Local payload entered SQLite or WAL bytes');
    }
    const revoked = await post('/api/local-access/revoke', {}); assert.equal(revoked.mode, 'disabled');
    const localAccess = { filePermissionRootIsTemporary: true, commandCwdIsTemporary: true, pendingWriteDidNotExecute: true,
      exactWriteApproval: true, readVerified: true, commandExitCode: 0, nonzeroCommandClassifiedFailed: true,
      sqlitePayloadExcluded: true, sqliteRawBytesExcluded: true, databaseFilesChecked: databaseFiles.length,
      revoked: true, executionBoundary: 'host_process_no_os_sandbox' };
    // Verify the packaged Playwright + pinned Chromium directly on synthetic
    // HTML. There is no removed business fixture or legacy Broker invocation.
    runtimeBrowser = await require('playwright').chromium.launch({executablePath:executable,headless:true,chromiumSandbox:true});
    assert.equal(runtimeBrowser.version(), manifest.browserVersion);
    const cdp = await runtimeBrowser.newBrowserCDPSession();
    const { arguments: args } = await cdp.send('Browser.getBrowserCommandLine');
    assert.ok(args.some(arg => resolve(arg).toLowerCase() === executable.toLowerCase()), 'Running browser command does not identify the bundled executable');
    const bypasses = args.filter(arg => /^--(?:no-sandbox|disable-(?:setuid|gpu|seccomp-filter|namespace)-sandbox)(?:=|$)/.test(arg));
    assert.deepEqual(bypasses, [], 'Chromium launched with a sandbox bypass');
    await cdp.detach();
    const page = await runtimeBrowser.newPage();
    await page.setContent('<!doctype html><html lang="zh-CN"><title>路衡通用候选验收</title><main>LUHENG_NATIVE_GENERIC_TEST_ONLY</main></html>');
    assert.equal(await page.locator('main').innerText(),'LUHENG_NATIVE_GENERIC_TEST_ONLY');
    const screenshot = await page.screenshot();
    assert.equal(screenshot.subarray(1, 4).toString(), 'PNG');
    const result = { status: 'native-runtime-passed', checkedAt: new Date().toISOString(), version: expected.version,
      platform: process.platform, arch: process.arch, node: process.versions.node, electron: process.versions.electron, sqlite: process.versions.sqlite,
      health, stateVersion: state.system.version, executable: process.execPath, packages, artifacts, localAccess,
      browser: { version: runtimeBrowser.version(), sha256: manifest.browserExecutableSha256, sandboxRequested: true, sandboxBypassFlags: bypasses, syntheticHtmlRead: true, screenshotBytes: screenshot.length },
      limitations: ['Bundled backend is tested in Electron run-as-node mode, not through the desktop utility-process IPC', 'Sandbox requested with no bypass flags; Windows restricted-token internals are not inspected', 'OOXML structure and download tested; Microsoft Office visual rendering not tested', 'Only fabricated local data; no real model, mail or external website integration'] };
    await runtimeBrowser.close(); runtimeBrowser = null;
    await app.close(); app = null;
    writeFileSync(out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: result.status, version: result.version, node: result.node, browser: result.browser.version }));
  } finally { await runtimeBrowser?.close(); await app?.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, a, b, c] = process.argv.slice(2);
    assert.ok(a && b && c, 'Usage: bind UNPACKED INSTALLED REPORT | probe INSTALLED DATA_DIR REPORT');
    if (mode === 'bind') {
      const release = resolve(a), installed = resolve(b), out = resolve(c);
      assert.ok(!within(release, out) && !within(installed, out));
      writeFileSync(out, JSON.stringify(await bindPayload(release, installed), null, 2) + '\n', { flag: 'wx' });
    } else { assert.equal(mode, 'probe'); await probe(resolve(a), resolve(b), resolve(c)); }
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
}
