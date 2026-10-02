// All executables in these tests are non-runnable synthetic PE headers, not release artifacts.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { dirname, resolve, join } = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, symlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { desktopFiles, inspectPE, verifyWindowsRelease } = require('../../scripts/verify-windows-release.mjs');
const sourceRoot = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(join(sourceRoot, 'package.json')));
const asar = createRequire(join(sourceRoot, 'desktop/package.json'))('@electron/asar');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function put(file, value) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); }
function putJSON(file, value) { put(file, JSON.stringify(value)); }
function pe(arch = 'x64') {
  const b = Buffer.alloc(512); b.write('MZ'); b.writeUInt32LE(128, 0x3c); b.write('PE\0\0', 128);
  b.writeUInt16LE(({ x64: 0x8664, ia32: 0x14c, arm64: 0xaa64 })[arch], 132);
  b.writeUInt16LE(1, 134); b.writeUInt16LE(arch === 'ia32' ? 224 : 240, 148); b.writeUInt16LE(arch === 'ia32' ? 0x10b : 0x20b, 152);
  return b;
}
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'luheng-windows-SYNTHETIC-'));
  t.after(() => { asar.uncacheAll(); rmSync(root, { recursive: true, force: true }); });
  const release = join(root, 'win-unpacked'), resources = join(release, 'resources'), backend = join(resources, 'backend');
  const installer = join(root, `Luheng-Office-Agent-${pkg.version}-windows-x64.exe`);
  put(installer, pe('ia32')); put(join(release, 'Luheng Office Agent.exe'), pe());
  for (const name of ['resources.pak', 'icudtl.dat', 'v8_context_snapshot.bin', 'locales/en-US.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak']) put(join(release, name), 'synthetic');
  for (const name of ['server.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'lib', 'public']) { mkdirSync(backend, { recursive: true }); cpSync(join(sourceRoot, name), join(backend, name), { recursive: true }); }
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    putJSON(join(backend, 'node_modules', name, 'package.json'), { name, version, main: 'index.js' });
    put(join(backend, 'node_modules', name, 'index.js'), '// Synthetic entry; must never execute.\nthrow new Error("fixture executed");');
  }
  const descriptor = { name: 'chromium', revision: '1208', browserVersion: '145.0.7632.6' };
  putJSON(join(backend, 'node_modules/playwright-core/package.json'), { name: 'playwright-core', version: pkg.dependencies.playwright });
  putJSON(join(backend, 'node_modules/playwright-core/browsers.json'), { browsers: [descriptor] });
  const runtime = join(resources, 'browser-runtime'), browserExecutable = `chromium-${descriptor.revision}/chrome-win64/chrome.exe`;
  put(join(runtime, browserExecutable), pe());
  const runtimeFiles = [browserExecutable];
  for (const name of ['chrome.dll', 'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'locales/en-US.pak']) {
    const relative = `chromium-${descriptor.revision}/chrome-win64/${name}`; runtimeFiles.push(relative); put(join(runtime, relative), 'synthetic');
  }
  const manifest = { target: 'win32', arch: 'x64', containsUserData: false, browserExecutable, browserVersion: descriptor.browserVersion, browserRevision: descriptor.revision, browserSource: 'synthetic-test-only', playwrightVersion: pkg.dependencies.playwright, browserExecutableSha256: hash(join(runtime, browserExecutable)) };
  putJSON(join(runtime, 'runtime-sha256.json'), { version: manifest.browserVersion, source: manifest.browserSource, files: Object.fromEntries(runtimeFiles.map(name => [name, hash(join(runtime, name))])) });
  const manifestPath = join(resources, 'bundle-manifest.json'); putJSON(manifestPath, manifest);
  const asarSource = join(root, 'asar-fixture');
  for (const name of desktopFiles) put(join(asarSource, name), readFileSync(join(sourceRoot, 'desktop', name)));
  const archive = join(resources, 'app.asar'); await asar.createPackage(asarSource, archive);
  const verify = () => verifyWindowsRelease({ release, installer, sourceRoot });
  return { root, release, installer, backend, runtime, manifest, manifestPath, asarSource, archive, verify };
}
test('synthetic preflight accepts ia32 NSIS stub and reports no installer/native readiness', async t => {
  const f = await fixture(t), result = f.verify();
  assert.equal(result.app.arch, 'x64'); assert.equal(result.browser.arch, 'x64'); assert.equal(result.installer.arch, 'ia32');
  assert.equal(result.installerBindingVerified, false); assert.equal(result.nativeWindowsExecutionVerified, false); assert.equal(result.deliverableReady, false);
  assert.equal(result.status, 'static-preflight-passed');
});
test('rejects non-PE, wrong architecture and truncated PE headers', async t => {
  const f = await fixture(t), exe = join(f.release, 'Luheng Office Agent.exe');
  for (const [data, pattern] of [[Buffer.from('ELF linux'), /Not a Windows PE/], [pe('arm64'), /architecture arm64/], [pe().subarray(0, 160), /Truncated PE/]]) { put(exe, data); assert.throws(f.verify, pattern); }
  put(exe, pe('ia32')); assert.throws(f.verify, /architecture ia32/);
  assert.throws(() => inspectPE(f.installer), /architecture ia32/);
});
test('rejects target, architecture, version and executable hash mismatches', async t => {
  const f = await fixture(t);
  for (const [key, value, pattern] of [['target', 'linux', /target must be win32/], ['arch', 'arm64', /arch must be x64/], ['browserVersion', '0.0', /version mismatch/], ['browserRevision', '9999', /revision mismatch/], ['browserExecutableSha256', '0'.repeat(64), /SHA256 mismatch/]]) {
    putJSON(f.manifestPath, { ...f.manifest, [key]: value }); assert.throws(f.verify, pattern);
  }
  putJSON(f.manifestPath, f.manifest);
  putJSON(join(f.backend, 'package.json'), { ...pkg, version: '0.0.0' }); assert.throws(f.verify, /backend version mismatch/);
});
test('rejects missing runtime companions, extra runtime files and changed hashed content', async t => {
  const f = await fixture(t), companion = join(f.runtime, 'chromium-1208/chrome-win64/resources.pak');
  rmSync(companion); assert.throws(f.verify, /ENOENT/); put(companion, 'changed'); assert.throws(f.verify, /Runtime SHA256 mismatch/);
  put(companion, 'synthetic'); put(join(f.runtime, 'unexpected.txt'), 'extra'); assert.throws(f.verify, /hash inventory mismatch/);
});
test('rejects missing dependency and incorrect pinned dependency version', async t => {
  const f = await fixture(t), dependency = join(f.backend, 'node_modules/imapflow');
  putJSON(join(dependency, 'package.json'), { name: 'imapflow', version: '0.0.0', main: 'index.js' });
  assert.throws(f.verify, /dependency version mismatch/);
  rmSync(dependency, { recursive: true }); assert.throws(f.verify, /ENOENT/);
});
test('rejects missing desktop ASAR file and ASAR version mismatch', async t => {
  const f = await fixture(t); rmSync(join(f.asarSource, 'window-state.cjs')); await asar.createPackage(f.asarSource, f.archive);
  assert.throws(f.verify, /Missing desktop file.*window-state/);
  put(join(f.asarSource, 'window-state.cjs'), readFileSync(join(sourceRoot, 'desktop/window-state.cjs')));
  putJSON(join(f.asarSource, 'package.json'), { version: '0.0.0', main: 'main.cjs' }); await asar.createPackage(f.asarSource, f.archive);
  assert.throws(f.verify, /ASAR version mismatch/);
});
test('rejects known credential/test contamination, traversal and symlinks', async t => {
  const f = await fixture(t);
  for (const name of ['.env', 'credentials.vault', 'tests/fixture.txt', 'data/agent.sqlite']) {
    put(join(f.backend, name), 'synthetic'); assert.throws(f.verify, /artifact|contamination/); rmSync(join(f.backend, name));
  }
  putJSON(f.manifestPath, { ...f.manifest, browserExecutable: '../escape.exe' }); assert.throws(f.verify, /Unsafe relative path/);
  putJSON(f.manifestPath, f.manifest); symlinkSync(f.asarSource, join(f.release, 'outside-directory'), process.platform === 'win32' ? 'junction' : 'dir'); assert.throws(f.verify, /Symbolic link/);
});
test('CLI fails clearly for missing inputs and exits 2 after static-only checks', async t => {
  const script = join(sourceRoot, 'scripts/verify-windows-release.mjs');
  let run = spawnSync(process.execPath, [script], { encoding: 'utf8' }); assert.equal(run.status, 1); assert.match(run.stderr, /Both win-unpacked/);
  const f = await fixture(t); run = spawnSync(process.execPath, [script, f.release, f.installer], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stderr); assert.equal(JSON.parse(run.stdout).deliverableReady, false);
});
