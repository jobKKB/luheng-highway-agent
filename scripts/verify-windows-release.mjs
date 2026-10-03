// Offline, read-only Windows package preflight. Never starts Electron, Chromium or the installer.
// A passing preflight does NOT bind installer payload to win-unpacked or prove native readiness.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const defaultSource = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const desktopFiles = ['main.cjs', 'security.cjs', 'backend-process.mjs', 'bridge.cjs', 'vault.cjs', 'lifecycle.cjs', 'window-state.cjs', 'update-policy.cjs', 'update-transport.cjs', 'update-files.cjs', 'update-manager.cjs', 'assets/tray.png', 'package.json'];
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const within = (root, file) => { const r = relative(root, file); return r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(r); };
function member(root, name) {
  assert.ok(typeof name === 'string' && name && !name.includes('\\') && !/[:\x00-\x1f]/.test(name) && !name.split('/').some(p => !p || p === '..' || p === '.'), `Unsafe relative path: ${name}`);
  const file = resolve(root, name); assert.ok(within(root, file), `Path outside package: ${name}`); return file;
}
function files(root, prefix = '') {
  const result = [];
  for (const name of readdirSync(root).sort()) {
    const file = join(root, name), rel = prefix + name, stat = lstatSync(file);
    assert.ok(!stat.isSymbolicLink(), `Symbolic link is not allowed: ${rel}`);
    assert.ok(stat.isFile() || stat.isDirectory(), `Unsupported filesystem entry: ${rel}`);
    if (stat.isDirectory()) result.push(...files(file, `${rel}/`)); else result.push(rel);
  }
  return result;
}
function requireFile(root, name, { allowEmpty = false } = {}) { const file = member(root, name); assert.ok(lstatSync(file).isFile() && (allowEmpty || lstatSync(file).size > 0), `Missing or empty file: ${name}`); return file; }
export function inspectPE(file, allowed = ['x64']) {
  const b = readFileSync(file); assert.ok(b.length >= 64 && b.toString('ascii', 0, 2) === 'MZ', `Not a Windows PE executable: ${file}`);
  const offset = b.readUInt32LE(0x3c);
  assert.ok(offset >= 64 && offset + 26 <= b.length && b.toString('ascii', offset, offset + 4) === 'PE\0\0', `Invalid PE header: ${file}`);
  const machine = b.readUInt16LE(offset + 4), arch = ({ 0x8664: 'x64', 0x14c: 'ia32', 0xaa64: 'arm64' })[machine];
  const optionalSize = b.readUInt16LE(offset + 20), sections = b.readUInt16LE(offset + 6), magic = b.readUInt16LE(offset + 24);
  assert.ok(sections > 0 && optionalSize >= (arch === 'ia32' ? 96 : 112) && offset + 24 + optionalSize + sections * 40 <= b.length, `Truncated PE headers: ${file}`);
  assert.equal(magic, arch === 'ia32' ? 0x10b : 0x20b, `PE optional header mismatch: ${file}`);
  assert.ok(allowed.includes(arch), `Unexpected PE architecture ${arch || machine.toString(16)}: ${file}`);
  return { arch, machine: `0x${machine.toString(16)}` };
}
export function verifyWindowsRelease({ release, installer, sourceRoot = defaultSource }) {
  assert.ok(release && installer, 'Both win-unpacked directory and NSIS installer paths are required');
  release = resolve(release); installer = resolve(installer); sourceRoot = resolve(sourceRoot);
  const entries = files(release); // Also rejects links before any packaged path is read.
  assert.ok(!lstatSync(installer).isSymbolicLink() && lstatSync(installer).isFile(), 'Installer must be a regular file');
  const pkg = json(join(sourceRoot, 'package.json')), desktopPkg = json(join(sourceRoot, 'desktop/package.json'));
  assert.equal(desktopPkg.version, pkg.version, 'Source desktop/backend versions differ');
  assert.equal(installer.split(/[\\/]/).at(-1), `Luheng-Office-Agent-${pkg.version}-windows-x64.exe`, 'Installer filename version/target mismatch');
  const app = inspectPE(requireFile(release, 'Luheng Office Agent.exe'));
  // NSIS commonly uses an ia32 bootstrap executable even for an x64 application payload.
  const bootstrap = inspectPE(installer, ['ia32', 'x64']);
  for (const name of ['resources.pak', 'icudtl.dat', 'v8_context_snapshot.bin', 'locales/en-US.pak', 'chrome_100_percent.pak', 'chrome_200_percent.pak']) requireFile(release, name);
  const resources = join(release, 'resources'), backend = join(resources, 'backend'), runtime = join(resources, 'browser-runtime');
  const manifest = json(requireFile(resources, 'bundle-manifest.json'));
  assert.equal(manifest.target, 'win32', 'Browser manifest target must be win32'); assert.equal(manifest.arch, 'x64', 'Browser manifest arch must be x64');
  assert.equal(manifest.containsUserData, false, 'Browser manifest must declare containsUserData:false');
  const browserFile = requireFile(runtime, manifest.browserExecutable), browser = inspectPE(browserFile);
  assert.equal(sha256(browserFile), manifest.browserExecutableSha256, 'Browser executable SHA256 mismatch');
  for (const name of ['chrome.dll', 'icudtl.dat', 'resources.pak', 'v8_context_snapshot.bin', 'locales/en-US.pak']) requireFile(dirname(browserFile), name);
  const runtimeHashes = json(requireFile(runtime, 'runtime-sha256.json'));
  assert.equal(runtimeHashes.version, manifest.browserVersion, 'Browser runtime version mismatch');
  assert.equal(runtimeHashes.source, manifest.browserSource, 'Browser runtime source mismatch');
  const actualRuntime = files(runtime).filter(p => p !== 'runtime-sha256.json').sort();
  assert.deepEqual(Object.keys(runtimeHashes.files).sort(), actualRuntime, 'Browser runtime hash inventory mismatch');
  // Playwright records legitimate zero-byte completion/dependency markers. The
  // complete inventory and SHA256 still bind their exact bytes; executable and
  // required browser companions above remain strictly nonempty.
  for (const [name, hash] of Object.entries(runtimeHashes.files)) { assert.match(hash, /^[a-f0-9]{64}$/); assert.equal(sha256(requireFile(runtime, name, { allowEmpty: true })), hash, `Runtime SHA256 mismatch: ${name}`); }
  const backendPkg = json(requireFile(backend, 'package.json'));
  assert.equal(backendPkg.version, pkg.version, 'Packaged backend version mismatch');
  assert.deepEqual(backendPkg.dependencies, pkg.dependencies, 'Packaged backend dependency declarations differ');
  for (const name of ['server.mjs', 'LICENSE', 'THIRD_PARTY_NOTICES.md', ...files(join(sourceRoot, 'lib')).map(p => `lib/${p}`), ...files(join(sourceRoot, 'public')).map(p => `public/${p}`)]) {
    assert.equal(sha256(requireFile(backend, name)), sha256(join(sourceRoot, name)), `Packaged backend source mismatch: ${name}`);
  }
  const backendRequire = createRequire(join(backend, 'package.json')), packages = {};
  for (const name of Object.keys(pkg.dependencies)) {
    const packagePath = requireFile(backend, `node_modules/${name}/package.json`), installed = json(packagePath);
    assert.equal(installed.version, pkg.dependencies[name], `Packaged dependency version mismatch: ${name}`);
    const entry = backendRequire.resolve(name);
    assert.ok(within(realpathSync(join(backend, 'node_modules')), realpathSync(entry)), `Dependency resolves outside packaged backend: ${name}`);
    packages[name] = { version: installed.version, entry: relative(backend, entry).split('\\').join('/') };
  }
  const core = json(requireFile(backend, 'node_modules/playwright-core/package.json'));
  assert.equal(core.version, packages.playwright.version, 'Playwright/core version mismatch');
  assert.equal(manifest.playwrightVersion, core.version, 'Manifest Playwright version mismatch');
  const chromium = json(requireFile(backend, 'node_modules/playwright-core/browsers.json')).browsers.find(b => b.name === 'chromium');
  assert.ok(chromium, 'Missing Chromium descriptor');
  assert.equal(manifest.browserVersion, chromium.browserVersion, 'Manifest Chromium version mismatch');
  assert.equal(String(manifest.browserRevision), String(chromium.revision), 'Manifest Chromium revision mismatch');
  assert.equal(manifest.browserExecutable, `chromium-${chromium.revision}/chrome-win64/chrome.exe`, 'Unexpected pinned Windows Chromium executable path');
  const asar = createRequire(join(sourceRoot, 'desktop/package.json'))('@electron/asar');
  const archive = requireFile(resources, 'app.asar'); asar.uncache(archive);
  const archiveFiles = asar.listPackage(archive).map(p => p.replace(/^[/\\]/, '').replaceAll('\\', '/'));
  for (const name of desktopFiles) {
    assert.ok(archiveFiles.includes(name), `Missing desktop file in app.asar: ${name}`);
    const entry = asar.statFile(archive, name, false); assert.ok(!entry.link && !entry.unpacked, `Unexpected linked/unpacked desktop file: ${name}`);
    const content = asar.extractFile(archive, name); assert.ok(content.length, `Empty desktop file: ${name}`);
    if (name === 'package.json') { const p = JSON.parse(content); assert.equal(p.version, pkg.version, 'ASAR version mismatch'); assert.equal(p.main, 'main.cjs'); }
    else assert.deepEqual(content, readFileSync(join(sourceRoot, 'desktop', name)), `Desktop source mismatch: ${name}`);
  }
  // Bounded known-artifact screen, not a proof that arbitrary secrets are absent.
  const knownState = /(^|\/)(\.env(?:\..*)?|credentials\.vault|desktop-preferences\.json|window-state\.json|Cookies|Login Data|Local State|[^/]+\.(?:sqlite(?:-wal|-shm)?|db|log|pfx|p12))$/i;
  for (const name of [...entries, ...archiveFiles.map(p => `app.asar/${p}`)]) {
    assert.ok(!knownState.test(name), `Known user-state/credential artifact: ${name}`);
    const firstParty = !name.includes('/node_modules/');
    assert.ok(!firstParty || !/(^|\/)(?:tests?|fixtures|\.git|\.runtime|user-data|browser-session)(\/|$)/i.test(name), `Source/test/user-data contamination: ${name}`);
  }
  return {
    status: 'static-preflight-passed', checkedAt: new Date().toISOString(), version: pkg.version,
    app, browser, installer: { ...bootstrap, sha256: sha256(installer) }, packages,
    browserVersion: manifest.browserVersion, runtimeFilesChecked: actualRuntime.length,
    installerBindingVerified: false, nativeWindowsExecutionVerified: false, deliverableReady: false,
    limitations: ['Installer payload not extracted or bound to win-unpacked', 'No install, launch, uninstall, signature or native Windows execution tested', 'Known-artifact path checks are not an exhaustive secret scan; dependency entry resolution does not execute or prove all transitive imports'],
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [release, installer, report] = process.argv.slice(2);
    const result = verifyWindowsRelease({ release, installer });
    const output = JSON.stringify(result, null, 2) + '\n';
    if (report) { const target = resolve(report); assert.ok(!within(resolve(release), target) && target !== resolve(installer), 'Report must not overwrite package inputs'); writeFileSync(target, output, { flag: 'wx' }); }
    process.stdout.write(output);
    // Exit 2 explicitly means preflight passed but installer readiness is unverified.
    process.exitCode = 2;
  } catch (error) { console.error(`Windows package preflight failed: ${error.message}`); process.exitCode = 1; }
}
