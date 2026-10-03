// Cross-platform checks for the LOCKED 0.4.0 -> 0.5.0 Windows upgrade acceptance helpers.
// Native install/upgrade/uninstall, registry, GUI and ACL stages only run in the manual
// windows-upgrade-acceptance workflow; nothing here touches the user's profile or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import * as up from '../scripts/verify-windows-upgrade.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const tool = join(repo, 'scripts', 'verify-windows-upgrade.mjs');
const LOCK = JSON.parse(readFileSync(join(repo, 'scripts', 'windows-upgrade-lock.json'), 'utf8'));
const WORKFLOW = readFileSync(join(repo, '.github', 'workflows', 'windows-upgrade-acceptance.yml'), 'utf8');
const PS1 = readFileSync(join(repo, 'scripts', 'verify-windows-upgrade.ps1'), 'utf8');
const REPO_VERSION = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
const NOW = Date.parse('2026-06-01T00:00:00Z');
const clone = value => JSON.parse(JSON.stringify(value));
const sha = data => createHash('sha256').update(data).digest('hex');
const temp = label => mkdtempSync(join(tmpdir(), `luheng-upgrade-test-${label}-`));
const CI_ENV = { GITHUB_ACTIONS: 'true', RUNNER_OS: 'Windows', RUNNER_ENVIRONMENT: 'github-hosted' };
const cleanEnv = extra => { const env = { ...process.env }; for (const key of [...Object.keys(CI_ENV), 'GH_TOKEN', 'GITHUB_TOKEN', 'ELECTRON_RUN_AS_NODE']) delete env[key]; return { ...env, ...extra }; };

// ------------------------------------------------------------------ lock
test('lock pins exactly 0.4.0/c6244b6 -> 0.5.0/d822591 (no relabel, no latest)', () => {
  assert.deepEqual(LOCK, {
    schema: 'luheng-windows-upgrade-lock/v1', repository: 'jobKKB/luheng-highway-agent',
    from: { version: '0.4.0', runNumber: 7, runId: 37018138122, commit: 'c6244b63439346287a5bd0dde2dac42a24baa2df',
      artifact: { id: 11232716427, name: 'luheng-windows-unsigned-prototype', zipBytes: 243730534, zipSha256: 'cff6b32a85bf69e0ad647c0efddb03bb2e72dfe8b7bb1155ec81fea0a94f7089', expiresAt: '2026-10-16T14:17:09Z' },
      installer: { name: 'Luheng-Office-Agent-0.4.0-windows-x64.exe', bytes: 244012810, sha256: 'bfe14f5a9c22bd1863b8500f80249d44ff8da818d4ccbc413d8040a6cbd584b7' } },
    to: { version: '0.5.0', runNumber: 11, runId: 37088470380, commit: 'd822591c5e58de5b08c802b2ac4d5508c8200260',
      artifact: { id: 11261364641, name: 'luheng-windows-unsigned-prototype', zipBytes: 243759530, zipSha256: '7a28c58e51bbdf0c871db150e1bc666452b9163257d652ce7fa48626f5a3f767', expiresAt: '2026-10-17T02:15:53Z' },
      installer: { name: 'Luheng-Office-Agent-0.5.0-windows-x64.exe', bytes: 244042045, sha256: '3f00bb736b351cd7f0daf7eeb977f5ebd02b5f80655492a122908e09dbc0505e' } },
  });
  assert.deepEqual(up.PINNED, { from: '0.4.0', to: '0.5.0' });
  assert.equal(up.validateLock(clone(LOCK), { now: NOW }).to.version, '0.5.0');
});
test('validateLock rejects every tampered or expired lock', () => {
  const cases = [
    [l => { l.schema = 'v2'; }, /Unknown lock schema/],
    [l => { l.extra = 1; }, /unexpected keys/],
    [l => { l.to.version = '0.5.1'; }, /pinned to 0\.5\.0/],
    [l => { l.from.version = '0.3.0'; }, /pinned to 0\.4\.0/],
    [l => { l.to.runId = '37088470380'; }, /runId must be a positive integer/],
    [l => { l.from.commit = 'c6244b6'; }, /full lowercase SHA/],
    [l => { l.to.artifact.name = 'other'; }, /locked artifact name/],
    [l => { l.to.artifact.zipSha256 = 'X'.repeat(64); }, /zipSha256 is invalid/],
    [l => { l.to.artifact.expiresAt = '2026-10-17'; }, /expiresAt is invalid/],
    [l => { l.to.installer.name = 'Luheng-Office-Agent-0.5.1-windows-x64.exe'; }, /does not match 0\.5\.0/],
    [l => { l.to.installer.extra = true; }, /unexpected keys/],
    [l => { l.to.runId = l.from.runId; }, /runId must differ/],
    [l => { l.to.installer.sha256 = l.from.installer.sha256; }, /installer SHA-256 must differ/],
    [l => { l.repository = 'evil repo'; }, /repository is invalid/],
  ];
  for (const [mutate, pattern] of cases) { const lock = clone(LOCK); mutate(lock); assert.throws(() => up.validateLock(lock, { now: NOW }), pattern); }
  assert.throws(() => up.validateLock(clone(LOCK), { now: Date.parse('2026-10-16T14:17:10Z') }), /expired at 2026-10-16T14:17:09Z/);
});
test('artifact metadata must match id, name, size, expiry, run, commit, URL and digest', () => {
  const entry = LOCK.to, repository = LOCK.repository;
  const good = { id: entry.artifact.id, name: entry.artifact.name, size_in_bytes: entry.artifact.zipBytes, expired: false, expires_at: entry.artifact.expiresAt,
    workflow_run: { id: entry.runId, head_sha: entry.commit }, archive_download_url: `https://api.github.com/repos/${repository}/actions/artifacts/${entry.artifact.id}/zip` };
  assert.match(up.verifyArtifactMetadata(entry, good, { repository, now: NOW }).digest, /not-provided/);
  assert.equal(up.verifyArtifactMetadata(entry, { ...good, digest: `sha256:${entry.artifact.zipSha256}` }, { repository, now: NOW }).digest, 'matched');
  const cases = [
    [{ id: 1 }, /id differs/], [{ name: 'x' }, /name differs/], [{ size_in_bytes: 1 }, /size differs/], [{ expired: true }, /expired; refusing/],
    [{ expires_at: '2026-10-18T00:00:00Z' }, /expiry differs/], [{ workflow_run: { id: 1, head_sha: entry.commit } }, /locked workflow run/],
    [{ workflow_run: { id: entry.runId, head_sha: LOCK.from.commit } }, /head SHA differs/], [{ archive_download_url: 'https://example.com/a.zip' }, /download URL/],
    [{ digest: 'sha256:' + '0'.repeat(64) }, /digest differs/],
  ];
  for (const [patch, pattern] of cases) assert.throws(() => up.verifyArtifactMetadata(entry, { ...good, ...patch }, { repository, now: NOW }), pattern);
  assert.throws(() => up.verifyArtifactMetadata(entry, good, { repository, now: Date.parse('2026-10-18T00:00:00Z') }), /expired; refusing/);
});

// ------------------------------------------------------------------ ZIP
function zipFile(entries, { zip64 = false, descriptor = false, encrypted = false, corruptCrc = false } = {}) {
  const locals = [], centrals = []; let offset = 0;
  for (const { name, data, method = 0 } of entries) {
    const body = method === 8 ? zlib.deflateRawSync(data) : data, nameBuf = Buffer.from(name);
    let crc = up.crc32Update(0, data); if (corruptCrc) crc = (crc ^ 1) >>> 0;
    const flags = (descriptor ? 8 : 0) | (encrypted ? 1 : 0);
    const localExtra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) { localExtra.writeUInt16LE(1, 0); localExtra.writeUInt16LE(16, 2); localExtra.writeBigUInt64LE(BigInt(data.length), 4); localExtra.writeBigUInt64LE(BigInt(body.length), 12); }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(zip64 ? 45 : 20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : zip64 ? 0xFFFFFFFF : body.length, 18); local.writeUInt32LE(descriptor ? 0 : zip64 ? 0xFFFFFFFF : data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(localExtra.length, 28);
    const parts = [local, nameBuf, localExtra, body];
    if (descriptor) { const d = Buffer.alloc(16); d.writeUInt32LE(0x08074b50, 0); d.writeUInt32LE(crc, 4); d.writeUInt32LE(body.length, 8); d.writeUInt32LE(data.length, 12); parts.push(d); }
    const blob = Buffer.concat(parts); locals.push(blob);
    const extra = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
    if (zip64) { extra.writeUInt16LE(1, 0); extra.writeUInt16LE(24, 2); extra.writeBigUInt64LE(BigInt(data.length), 4); extra.writeBigUInt64LE(BigInt(body.length), 12); extra.writeBigUInt64LE(BigInt(offset), 20); }
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(45, 4); central.writeUInt16LE(zip64 ? 45 : 20, 6); central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(zip64 ? 0xFFFFFFFF : body.length, 20); central.writeUInt32LE(zip64 ? 0xFFFFFFFF : data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(extra.length, 30); central.writeUInt32LE(zip64 ? 0xFFFFFFFF : offset, 42);
    centrals.push(Buffer.concat([central, nameBuf, extra]));
    offset += blob.length;
  }
  const cd = Buffer.concat(centrals), cdOffset = offset, tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32); record.writeBigUInt64LE(BigInt(cd.length), 40); record.writeBigUInt64LE(BigInt(cdOffset), 48);
    const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8); locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(zip64 ? 0xFFFF : entries.length, 8); eocd.writeUInt16LE(zip64 ? 0xFFFF : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xFFFFFFFF : cd.length, 12); eocd.writeUInt32LE(zip64 ? 0xFFFFFFFF : cdOffset, 16);
  return Buffer.concat([...locals, cd, ...tail, eocd]);
}
test('locked installer extraction: stored, deflate, data descriptor and ZIP64 succeed', async () => {
  const dir = temp('zip'), name = 'Luheng-Office-Agent-0.5.0-windows-x64.exe';
  try {
    const data = Buffer.concat([Buffer.from('MZ synthetic installer '), Buffer.alloc(70000, 7)]);
    const lock = { installer: { name, bytes: data.length, sha256: sha(data) } };
    for (const [label, options, method] of [['stored', {}, 0], ['deflate', {}, 8], ['descriptor', { descriptor: true }, 8], ['zip64', { zip64: true }, 0]]) {
      const zip = join(dir, `${label}.zip`), out = join(dir, `${label}.exe`);
      writeFileSync(zip, zipFile([{ name, data, method }], options));
      const result = await up.extractLockedInstaller(zip, lock, out);
      assert.equal(result.sha256, sha(data), label); assert.equal(result.method, method); assert.deepEqual(readFileSync(out), data);
      assert.equal((await up.checkInstallerFile({ installer: lock.installer }, out)).sha256, sha(data));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('locked installer extraction fails closed and never leaves partial output', async () => {
  const dir = temp('zipbad'), name = 'Luheng-Office-Agent-0.5.0-windows-x64.exe';
  try {
    const data = Buffer.from('MZ synthetic installer payload '.repeat(100)), lock = { installer: { name, bytes: data.length, sha256: sha(data) } };
    let n = 0;
    const expectFail = async (zipBuffer, pattern, lockValue = lock) => {
      const zip = join(dir, `case-${++n}.zip`), out = join(dir, `case-${n}.exe`); writeFileSync(zip, zipBuffer);
      await assert.rejects(up.extractLockedInstaller(zip, lockValue, out), pattern); assert.equal(existsSync(out), false, `partial output left for ${pattern}`);
    };
    await expectFail(zipFile([{ name, data }, { name: 'second.txt', data: Buffer.from('x') }]), /exactly one file, found 2/);
    await expectFail(zipFile([{ name: 'evil.exe', data }]), /entry name differs/);
    await expectFail(zipFile([{ name: `../${name}`, data }]), /entry name differs/);
    await expectFail(zipFile([{ name, data }], { corruptCrc: true }), /CRC-32 mismatch/);
    await expectFail(zipFile([{ name, data, method: 8 }], { descriptor: true, corruptCrc: true }), /CRC-32 mismatch/);
    await expectFail(zipFile([{ name, data }]), /size differs/, { installer: { ...lock.installer, bytes: data.length + 1 } });
    await expectFail(zipFile([{ name, data }]), /SHA-256 differs/, { installer: { ...lock.installer, sha256: '0'.repeat(64) } });
    await expectFail(zipFile([{ name, data }], { encrypted: true }), /Encrypted/);
    await expectFail(Buffer.from('not a zip at all, definitely not'), /end of central directory not found/);
    await expectFail(Buffer.alloc(5), /too small/);
    await expectFail(zipFile([{ name: 'x.exe', data }]), /Unsafe installer name/, { installer: { ...lock.installer, name: '..\\x.exe' } });
    const zip = join(dir, 'existing.zip'), out = join(dir, 'existing.exe');
    writeFileSync(zip, zipFile([{ name, data }])); writeFileSync(out, 'keep me');
    await assert.rejects(up.extractLockedInstaller(zip, lock, out), /already exists/);
    assert.equal(readFileSync(out, 'utf8'), 'keep me');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ static workflow / driver checks
// Text checks run on an in-memory LF view (a Windows checkout may be CRLF); file bytes and the lock are never rewritten.
const lf = text => text.replace(/\r\n/g, '\n');
const crlf = text => lf(text).replace(/\n/g, '\r\n');
function checkWorkflowText(raw) {
  const text = lf(raw);
  const block = key => { const m = text.match(new RegExp(`^${key}:\\n((?:[ #].*\\n?)*)`, 'm')); return m ? m[1].split('\n').filter(l => l.trim() && !l.trim().startsWith('#')).map(l => l.trimEnd()) : null; };
  assert.deepEqual(block('on'), ['  workflow_dispatch:']);
  assert.deepEqual(block('permissions'), ['  contents: read', '  actions: read']);
  assert.doesNotMatch(text, /secrets\.|action-gh-release|gh release|\/releases|contents:\s*write|packages:\s*write|id-token|pull_request|schedule:|\bpush:/);
  assert.match(text, /persist-credentials: false/);
  const steps = text.split('\n      - ').slice(1);
  const tokenSteps = steps.filter(s => /github\.token|GH_TOKEN|GITHUB_TOKEN/.test(s));
  assert.equal(tokenSteps.length, 1); assert.match(tokenSteps[0], /^name: Fetch and verify locked installers/);
  assert.equal((text.match(/\$\{\{\s*github\.token\s*\}\}/g) || []).length, 1);
  assert.match(text, /verify-windows-upgrade\.mjs fetch --lock scripts\/windows-upgrade-lock\.json/);
  assert.match(text, /\.\/scripts\/verify-windows-upgrade\.ps1 -InputDirectory/);
}
test('workflow is manual-only, read-only, token scoped to the fetch step, no release', () => checkWorkflowText(WORKFLOW));
let modes;
const toolModes = () => (modes ??= spawnSync(process.execPath, [tool], { encoding: 'utf8', env: cleanEnv() }).stderr.match(/Usage: ([^\n]+?) --option/)[1].split(' | '));
function checkDriverText(raw) {
  const text = lf(raw);
  for (const guard of ["-not $IsWindows", "$env:GITHUB_ACTIONS -ne 'true'", "$env:RUNNER_OS -ne 'Windows'", "$env:RUNNER_ENVIRONMENT -ne 'github-hosted'",
    "Existing Luheng app data found; refusing", "Existing per-user Luheng installation found; refusing", "A Luheng Office Agent process is already running; refusing"]) assert.ok(text.includes(guard), guard);
  assert.doesNotMatch(text, /SilentlyContinue|Get-ItemProperty|\bGet-Process\b|\bTest-Path\b(?!Strict)|Invoke-WebRequest|Invoke-RestMethod|\bcurl\b|\bwget\b|taskkill/i);
  for (const needle of ["[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', $false)",
    "[Diagnostics.Process]::GetProcessesByName('Luheng Office Agent')", "Get-CimInstance -ClassName Win32_Process", ".Kill($true)", "catch [System.Management.Automation.ItemNotFoundException]",
    "GetFileSystemInfos()", "[IO.FileAttributes]::ReparsePoint", "$expires -is [DateTime]", "[DateTimeOffset]::Parse(", "commandLineSha256", "Assert-RealDirectoryChain $runnerTemp"])
    assert.ok(text.includes(needle), needle);
  assert.match(text, /-RawArguments "\/S \/currentuser \/D=\$install"\)/);
  assert.match(text, /-RawArguments "\/S \/currentuser _\?=\$install"\)/);
  assert.match(text, /function Install-Locked\(\[string\]\$Installer\) \{\n  Assert-OwnedWork\n/);
  assert.match(text, /function Invoke-Uninstall \{\n  Assert-OwnedWork\n/);
  const removals = text.split('\n').filter(line => /Remove-Item/.test(line));
  assert.equal(removals.length, 3);
  assert.ok(removals.some(l => /Assert-OwnedData; Remove-Item -LiteralPath \$data -Recurse -Force/.test(l)));
  assert.ok(removals.some(l => /Assert-OwnedWork; Remove-Item -LiteralPath \$work -Recurse -Force/.test(l)));
  assert.ok(removals.some(l => /Remove-Item -LiteralPath \$uninstallerCopy -Force/.test(l)));
  assert.equal((text.match(/Assert-ProfileAcl '/g) || []).length, 3);
  for (const run of [1, 2]) assert.ok(text.includes('"verify-recovery-v04-run$run"') && text.includes(`foreach ($run in @(1, 2))`));
  assert.ok(text.includes("'verify-recovery-v04-run3'") && text.includes("'--manifest', $upgradeReport"));
  // Every mode the driver invokes must exist in the Node tool.
  const usage = toolModes();
  const invoked = [...text.matchAll(/@\(\$tool, '([a-z0-9-]+)'|@\('([a-z0-9-]+)', '--install'/g)].map(m => m[1] || m[2]);
  assert.ok(invoked.length >= 8); for (const mode of invoked) assert.ok(usage.includes(mode), `driver uses unknown mode ${mode}`);
  for (const mode of ['seed-recovery-v04', 'verify-recovery-v04', 'scan']) assert.ok(usage.includes(mode));
}
test('PowerShell driver: guards, fail-closed enumeration, owned cleanup, locked arguments', () => checkDriverText(PS1));
test('static text checks: same content passes as LF and CRLF; tampered security content fails in both; raw bytes untouched', () => {
  const tamper = (text, from, to) => { assert.ok(text.includes(from), `tamper anchor missing: ${from}`); return text.replace(from, to); };
  const wf = lf(WORKFLOW), ps = lf(PS1);
  const workflowTampers = [
    ['push trigger', tamper(wf, 'on:\n  workflow_dispatch:\n', 'on:\n  workflow_dispatch:\n  push:\n')],
    ['reusable-workflow trigger', tamper(wf, 'on:\n  workflow_dispatch:\n', 'on:\n  workflow_dispatch:\n  workflow_call:\n')],
    ['write permission', tamper(wf, '  contents: read\n', '  contents: write\n')],
    ['persisted credentials', tamper(wf, 'persist-credentials: false', 'persist-credentials: true')],
    ['token in a second step', tamper(wf, '      - name: Upgrade, interrupted recovery and reinstall acceptance\n', '      - name: Upgrade, interrupted recovery and reinstall acceptance\n        env:\n          GH_TOKEN: ${{ github.token }}\n')],
  ];
  const driverTampers = [
    ['Install-Locked without ownership check', tamper(ps, 'function Install-Locked([string]$Installer) {\n  Assert-OwnedWork\n', 'function Install-Locked([string]$Installer) {\n')],
    ['Invoke-Uninstall without ownership check', tamper(ps, 'function Invoke-Uninstall {\n  Assert-OwnedWork\n', 'function Invoke-Uninstall {\n')],
    ['silent enumeration', tamper(ps, 'Get-CimInstance -ClassName Win32_Process -ErrorAction Stop', 'Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue')],
    ['extra deletion', `${ps}Remove-Item -LiteralPath $env:APPDATA -Recurse -Force\n`],
    ['quoted install directory', tamper(ps, '-RawArguments "/S /currentuser /D=$install")', '-RawArguments "/S /currentuser /D=`"$install`"")')],
  ];
  for (const form of [lf, crlf]) {
    const name = form === lf ? 'LF' : 'CRLF';
    assert.equal(form(wf).includes('\r\n'), form === crlf, `${name} control is not ${name}`);
    checkWorkflowText(form(wf)); checkDriverText(form(ps));
    for (const [label, text] of workflowTampers) assert.throws(() => checkWorkflowText(form(text)), assert.AssertionError, `${name}: ${label} was accepted`);
    for (const [label, text] of driverTampers) assert.throws(() => checkDriverText(form(text)), assert.AssertionError, `${name}: ${label} was accepted`);
  }
  assert.equal(readFileSync(join(repo, '.github', 'workflows', 'windows-upgrade-acceptance.yml'), 'utf8'), WORKFLOW, 'workflow bytes changed');
  assert.equal(readFileSync(join(repo, 'scripts', 'verify-windows-upgrade.ps1'), 'utf8'), PS1, 'driver bytes changed');
  assert.deepEqual(JSON.parse(readFileSync(join(repo, 'scripts', 'windows-upgrade-lock.json'), 'utf8')), LOCK, 'lock changed');
});

// ------------------------------------------------------------------ migration 4 on a raw 0.4-schema database
const V04_AGENT = (id, permissions, enabled = true) => ({ id, name: `agent-${id}`, role: 'r', personality: 'p', permissions, enabled, modelConfig: { inherit: true } });
async function migrate(agents) {
  const dir = temp('mig4');
  const db = new DatabaseSync(join(dir, 'agent.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT); CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(kind,id));');
  for (const version of [1, 2, 3]) db.prepare('INSERT INTO migrations VALUES(?,?)').run(version, `2026-01-0${version}T00:00:00.000Z`);
  const put = (kind, id, value) => db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind, id, JSON.stringify(value));
  for (const agent of agents) put('agents', agent.id, agent);
  put('settings', 'main', { mode: 'demo', budget: 23 }); put('memories', 'm1', { id: 'm1', title: '合成', scope: 'workspace', ownerAgentId: null });
  put('tasks', 't1', { id: 't1', status: 'completed' });
  const before = up.readSnapshot(db); db.close();
  const { Store } = await import(pathToFileURL(join(repo, 'lib', 'store.mjs')).href);
  try {
    let store = new Store(dir); const after = clone(up.readSnapshot(store.db)); store.close();
    store = new Store(dir); const reopened = clone(up.readSnapshot(store.db)); store.close();
    return { before, after, reopened };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('repository Store migration 4 expands only unchanged enabled 0.4 defaults (matrix + idempotent)', async () => {
  const D = up.V04_BUILTIN_DEFAULTS;
  const cases = [
    { label: 'defaults', agents: [V04_AGENT('coordinator', [...D.coordinator]), V04_AGENT('researcher', [...D.researcher]), V04_AGENT('writer', [...D.writer])],
      expected: { coordinator: [...D.coordinator, 'files.read', 'files.write', 'commands.run'], researcher: ['knowledge.read', 'browser.read', 'files.read'], writer: ['knowledge.read', 'workspace.write', 'mail.draft', 'files.read', 'files.write'] } },
    { label: 'narrowed', agents: [V04_AGENT('researcher', ['knowledge.read'])], expected: { researcher: ['knowledge.read'] } },
    { label: 'disabled', agents: [V04_AGENT('writer', [...D.writer], false)], expected: { writer: [...D.writer] } },
    { label: 'custom', agents: [V04_AGENT('custom-1', [...D.writer])], expected: { 'custom-1': [...D.writer] } },
    { label: 'missing', agents: [], expected: {} },
    { label: 'extra', agents: [V04_AGENT('researcher', ['knowledge.read', 'browser.read', 'mail.read'])], expected: { researcher: ['knowledge.read', 'browser.read', 'mail.read'] } },
    { label: 'duplicate', agents: [V04_AGENT('researcher', ['knowledge.read', 'knowledge.read'])], expected: { researcher: ['knowledge.read', 'knowledge.read'] } },
    { label: 'reordered', agents: [V04_AGENT('writer', ['mail.draft', 'knowledge.read', 'workspace.write'])], expected: { writer: ['mail.draft', 'knowledge.read', 'workspace.write', 'files.read', 'files.write'] } },
  ];
  for (const { label, agents, expected } of cases) {
    const { before, after, reopened } = await migrate(agents);
    assert.deepEqual(after.migrations.slice(0, 3), before.migrations, `${label}: migration rows rewritten`);
    assert.deepEqual(after.migrations.map(m => m.version), [1, 2, 3, 4], label);
    assert.deepEqual(reopened, after, `${label}: reopening is not idempotent`);
    assert.deepEqual(Object.fromEntries(Object.entries(after.records.agents || {}).map(([id, a]) => [id, a.permissions])), expected, `${label}: permissions`);
    assert.deepEqual(after.records.agents || {}, up.expectedMigration4(before.records.agents), `${label}: oracle disagrees with Store`);
    for (const kind of ['settings', 'memories', 'tasks']) assert.deepEqual(after.records[kind], before.records[kind], `${label}: ${kind} changed`);
    for (const [id, agent] of Object.entries(after.records.agents || {})) assert.deepEqual({ ...agent, permissions: null }, { ...before.records.agents[id], permissions: null }, `${label}: ${id} other fields changed`);
  }
});

// ------------------------------------------------------------------ diff oracles
const SEED = { reminders: { catchUp: 'r-catch' }, schedules: { catchUp: 's-catch' }, catchUpAt: '2026-10-01T00:00:00.000Z' };
function upgradeFixture() {
  const before = { tables: ['migrations', 'records'], migrations: [1, 2, 3].map(version => ({ version, applied_at: 'x' })), records: {
    agents: { coordinator: V04_AGENT('coordinator', [...up.V04_BUILTIN_DEFAULTS.coordinator]), researcher: V04_AGENT('researcher', ['knowledge.read']) },
    reminders: { 'r-catch': { id: 'r-catch', status: 'scheduled' }, 'r-future': { id: 'r-future', status: 'scheduled' } },
    schedules: { 's-catch': { id: 's-catch', nextRunAt: SEED.catchUpAt, runCount: 0 } },
    tasks: { t1: { id: 't1', status: 'completed' } }, memories: { m1: { id: 'm1', content: '合成' } } } };
  const after = clone(before);
  after.migrations.push({ version: 4, applied_at: 'y' });
  after.records.agents = up.expectedMigration4(before.records.agents);
  after.records.local_access = { policy: { mode: 'disabled', roots: [], allFiles: false, configured: false, revision: 1 } };
  after.records.notifications = { 'reminder-r-catch': { id: 'reminder-r-catch', reminderId: 'r-catch' } };
  after.records.schedule_occurrences = { o1: { id: 'o1', scheduleId: 's-catch', scheduledFor: SEED.catchUpAt, status: 'created', taskId: 't2', coalesced: false } };
  after.records.tasks.t2 = { id: 't2', scheduleOccurrenceId: 'o1', status: 'completed' };
  after.records.reminders['r-catch'] = { id: 'r-catch', status: 'fired', firedAt: 'z' };
  after.records.schedules['s-catch'] = { id: 's-catch', nextRunAt: '2027-10-01T00:00:00.000Z', runCount: 1, lastOccurrenceId: 'o1', lastTaskId: 't2', lastRunAt: 'z' };
  after.records.audit = { a1: { id: 'a1' } };
  return { before, after };
}
test('upgradeDiff accepts exactly the documented changes and flags every other change', () => {
  const { before, after } = upgradeFixture();
  assert.deepEqual(up.upgradeDiff(before, after, SEED).violations, []);
  const cases = [
    [a => { a.records.memories.m1.content = 'changed'; }, /unexpected change memories\/m1/],
    [a => { delete a.records.tasks.t1; }, /removed tasks\/t1/],
    [a => { a.records.agents.researcher.permissions.push('files.read'); }, /agent researcher does not match/],
    [a => { a.records.schedule_occurrences.o2 = { ...a.records.schedule_occurrences.o1, id: 'o2' }; }, /exactly one catch-up occurrence/],
    [a => { a.records.reminders['r-future'].status = 'fired'; }, /unexpected change reminders\/r-future/],
    [a => { a.records.local_access.policy.mode = 'confirm'; }, /unexpected new local_access\/policy/],
    [a => { a.records.tasks.t3 = { id: 't3', status: 'queued' }; }, /unexpected new tasks\/t3/],
    [a => { delete a.records.notifications; }, /catch-up reminder did not fire/],
  ];
  for (const [mutate, pattern] of cases) { const a = clone(after); mutate(a); assert.match(up.upgradeDiff(before, a, SEED).violations.join('; '), pattern); }
});
test('steadyStateDiff allows only audit, policy revision bump and session lease reset', () => {
  const base = { tables: ['migrations', 'records'], migrations: [1, 2, 3, 4].map(version => ({ version, applied_at: 'x' })), records: {
    local_access: { policy: { mode: 'disabled', roots: [], revision: 3 } }, sessions: { s1: { id: 's1', writeLease: true, status: 'manual', url: 'x' } }, tasks: { t1: { id: 't1', status: 'completed' } } } };
  const ok = clone(base); ok.records.local_access.policy.revision = 4; ok.records.sessions.s1 = { ...ok.records.sessions.s1, writeLease: false, status: 'agent' }; ok.records.audit = { a: {} };
  assert.deepEqual(up.steadyStateDiff(base, ok).violations, []);
  const cases = [
    [a => { a.records.local_access.policy.mode = 'confirm'; a.records.local_access.policy.revision = 4; }, /unexpected change local_access\/policy/],
    [a => { a.records.local_access.policy.revision = 2; }, /unexpected change local_access\/policy/],
    [a => { a.records.sessions.s1.url = 'y'; }, /unexpected change sessions\/s1/],
    [a => { a.records.tasks.t2 = { id: 't2' }; }, /unexpected new tasks\/t2/],
    [a => { a.migrations.pop(); }, /migrations changed/],
    [a => { a.tables.push('extra'); }, /tables changed/],
  ];
  for (const [mutate, pattern] of cases) { const a = clone(base); mutate(a); assert.match(up.steadyStateDiff(base, a).violations.join('; '), pattern); }
});

// ------------------------------------------------------------------ raw scans
test('raw scans find UTF-8, UTF-16LE, base64 and unkeyed digests, and refuse links', () => {
  const dir = temp('scan');
  try {
    const marker = 'LUHENG-TEST-' + 'a1'.repeat(12), payload = { name: 'local_write_file', args: { path: 'C:/x', content: marker } };
    const needles = up.scanNeedles({ markers: [marker], digestInputs: [payload] });
    assert.ok(needles.includes(up.rawHash(payload)) && needles.includes(up.rawHash(payload).toUpperCase()) && needles.includes(Buffer.from(marker).toString('base64')));
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'clean.bin'), 'nothing here');
    writeFileSync(join(dir, 'nested', 'utf16.log'), Buffer.from(`x ${marker} y`, 'utf16le'));
    writeFileSync(join(dir, 'digest.txt'), `audit ${up.rawHash(payload)}`);
    writeFileSync(join(dir, 'b64.txt'), Buffer.from(marker).toString('base64'));
    assert.deepEqual(up.scanForSentinels(dir, needles).sort(), [join(dir, 'b64.txt'), join(dir, 'digest.txt'), join(dir, 'nested', 'utf16.log')].sort());
    assert.equal(up.jsonHits({ ok: true, note: up.rawHash(payload) }, needles), 1);
    assert.throws(() => up.scanNeedles({ markers: ['short'] }), /distinctive/);
    let linked = false; try { symlinkSync(join(dir, 'clean.bin'), join(dir, 'link.bin')); linked = true; } catch {}
    if (linked) assert.throws(() => up.scanForSentinels(dir, needles), /Links are not allowed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ real repository backend: mail boundary + recovery
test('SMTP boundary is reachable with the same account (positive control: a replay would be counted)', async () => {
  const dir = temp('smtp'), counters = up.createEffectCounters(), plan = [];
  const { app, http, smtp } = await up.startBackend(repo, join(dir, 'data'), { expectVersion: REPO_VERSION, counters, smtpPlan: plan, mailTimeoutMs: 5000 });
  try {
    const password = 'synthetic-test-only-' + 'c3'.repeat(16);
    assert.equal((await http.post('/api/mail/config', up.mailConfig(password))).data.hasCredentials.smtp, true);
    const draft = async subject => (await http.post('/api/mail/drafts', { accountId: 'main', to: [up.MAIL_FIXTURE.to], subject, text: '合成测试邮件正文。' })).data;
    const refused = await draft('升级验收拒绝连接');
    const approval = (await http.post(`/api/mail/drafts/${refused.id}/request-send`, {})).data;
    const outcome = (await http.post(`/api/mail/approvals/${approval.id}`, { decision: 'approve' })).data;
    assert.equal(counters.smtp, 1); assert.equal(outcome.status, 'failed'); assert.equal(app.store.get('mail_outbox', refused.id).attempts, 1);
    plan.push('accept');
    const accepted = await draft('升级验收接受');
    const approval2 = (await http.post(`/api/mail/drafts/${accepted.id}/request-send`, {})).data;
    assert.equal((await http.post(`/api/mail/approvals/${approval2.id}`, { decision: 'approve' })).data.status, 'sent');
    assert.equal(counters.smtp, 2); assert.equal(smtp.accepted.length, 1);
    assert.equal((await http.post(`/api/mail/drafts/${accepted.id}/request-send`, {}, { ok: false })).status >= 400, true);
    assert.equal(counters.smtp, 2);
    assert.deepEqual(up.scanForSentinels(join(dir, 'data'), up.scanNeedles({ markers: [password, up.smtpAuthMarker(password)] })), []);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
// Seed-side hook (runs inside the seed): persist the seed; for a supervised (Windows full) seed, ask the supervisor to
// bind the in-flight command and block until it has. Only then does it return, so the helper's crashNow() SIGKILLs.
const seededHook = (seedFile, bind) => `s => {
  const { existsSync, renameSync, writeFileSync } = process.getBuiltinModule('node:fs');
  writeFileSync(${JSON.stringify(seedFile)}, JSON.stringify(s), { flag: 'wx' });
  const bind = ${JSON.stringify(bind)};
  if (!bind) return;
  if (!s.childPid) process.exit(3);
  writeFileSync(bind.requestFile + '.tmp', JSON.stringify({ childPid: s.childPid, effects: s.effects, sentinel: s.sentinels.command }), { flag: 'wx' });
  renameSync(bind.requestFile + '.tmp', bind.requestFile);
  const pause = new Int32Array(new SharedArrayBuffer(4)), deadline = Date.now() + bind.waitMs;
  while (!existsSync(bind.boundFile)) { if (Date.now() > deadline) process.exit(3); Atomics.wait(pause, 0, 0, 50); }
}`;
async function crashSeed(dir, variant) {
  const files = join(dir, `recovery-${variant}`, 'files'), data = join(dir, `recovery-${variant}`, 'data'), seedFile = join(dir, `seed-${variant}.json`);
  mkdirSync(files, { recursive: true });
  // Windows: the product spawns commands non-detached, so libuv's kill-on-close job ends them with the seed. The full
  // variant's in-flight command is therefore bound (held handle + full identity) BEFORE the seed may crash.
  const bind = process.platform === 'win32' && variant === 'full'
    ? { requestFile: join(dir, 'bind-request.json'), boundFile: join(dir, 'bound.json'), consumeFile: join(dir, 'consume'), waitMs: 90000 } : null;
  const code = `const lib = await import(${JSON.stringify(pathToFileURL(tool).href)});
    await lib.seedRecovery({ backendDir: ${JSON.stringify(repo)}, dataDir: ${JSON.stringify(data)}, filesDir: ${JSON.stringify(files)}, variant: ${JSON.stringify(variant)},
      expectVersion: ${JSON.stringify(REPO_VERSION)}, commandExecutable: process.execPath, onSeeded: ${seededHook(seedFile, bind)} });`;
  const notBeforeMs = Date.now();
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: cleanEnv() });
  let stderr = ''; child.stdout.resume(); child.stderr.setEncoding('utf8').on('data', d => { stderr += d; });
  const supervisor = bind ? startSupervisor(dir, child.pid, notBeforeMs, bind) : null;
  let timedOut = false; const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
  const [status, signal] = await new Promise(resolve => child.on('close', (code, sig) => resolve([code, sig])));
  clearTimeout(timer);
  try {
    const hardKilled = !timedOut && (signal === 'SIGKILL' || (process.platform === 'win32' && status === 1));
    assert.ok(hardKilled, `seed ${variant} did not end in its deliberate hard kill: status=${status} signal=${signal} timedOut=${timedOut} ${stderr.slice(-800)}`);
    return { seed: JSON.parse(readFileSync(seedFile, 'utf8')), data, seedPid: child.pid, notBeforeMs, supervisor };
  } catch (error) { if (supervisor) error.message += ` [supervisor: ${await supervisor.finish()}]`; throw error; }
}
// In-flight command cleanup: one-shot and never by a bare PID.
// Windows: a test-only pwsh supervisor binds the command BEFORE the crash (driver's own Open-ProcessHandle +
// Register-OrphanCommand, handle StartTime = CIM creation); afterwards only that held handle is trusted: a terminal
// HasExited, or Stop-IdentifiedProcess through the same handle if it is still alive.
// POSIX: Node has no pidfd API, so verify-then-kill(pid) cannot be made race-free; the (setsid) command is never
// signalled and is left to its own 600 s timer (its only write target is effects.log, whose directory the test deletes).
const PWSH = (() => {
  const dirs = [...(process.platform === 'win32' && process.env.ProgramFiles ? [join(process.env.ProgramFiles, 'PowerShell', '7')] : []), ...(process.env.PATH || '').split(delimiter)];
  for (const dir of dirs) { const file = join(dir, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh'); if (isAbsolute(dir) && existsSync(file)) return file; }
  return null;
})();
function psFunction(name) {
  // Exact function text from the driver (source-bound): one-liners, or up to the next top-level "}".
  const lines = PS1.split(/\r?\n/), start = lines.findIndex(l => l.startsWith(`function ${name} `) || l.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `driver lacks function ${name}`);
  if (!lines[start].trimEnd().endsWith('{')) return `${lines[start]}\n`;
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.ok(end > start, `unterminated driver function ${name}`);
  return `${lines.slice(start, end + 1).join('\n')}\n`;
}
function runPwsh(body, env) {
  assert.ok(PWSH, 'pwsh 7 is required for handle-held process cleanup on Windows');
  const dir = temp('pwsh'), file = join(dir, 'driver-functions.ps1');
  try {
    writeFileSync(file, psScript(body));
    const r = spawnSync(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', timeout: 120000, windowsHide: true, env: cleanEnv(env) });
    assert.equal(r.status, 0, `pwsh failed: ${r.error || ''} ${r.stderr?.slice(-1500)}`);
    return r.stdout.trim();
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const psScript = body => `Set-StrictMode -Version Latest\n$ErrorActionPreference = 'Stop'\n$utf8 = [Text.UTF8Encoding]::new($false)\n${body}`;
const SUPERVISOR_FUNCTIONS = ['Get-ProcessIdentity', 'Open-ProcessHandle', 'Stop-IdentifiedProcess', 'Register-OrphanCommand'];
const SUPERVISOR_PS = `function Wait-File([string]$Path, [int]$Seconds, [string]$Abort = '') {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while (-not [IO.File]::Exists($Path)) {
    if (($Abort -and [IO.File]::Exists($Abort)) -or [DateTime]::UtcNow -gt $deadline) { return $false }
    Start-Sleep -Milliseconds 50
  }
  return $true
}
function Invoke-SupervisedCommand($T) {
  if (-not (Wait-File $T.requestFile 170 $T.consumeFile)) { return 'refused: the seed never asked for a bind' }
  $req = [IO.File]::ReadAllText($T.requestFile) | ConvertFrom-Json
  try { $held = Open-ProcessHandle ([int]$req.childPid) } catch [ArgumentException], [InvalidOperationException] { return "refused: in-flight command PID $($req.childPid) was not running before the bind" }
  try {
    $seedRecord = [pscustomobject]@{ Id = [int]$T.seedPid; StartTimeUtc = [DateTime]::UnixEpoch.AddMilliseconds([double]$T.notBeforeMs) }
    $record = Register-OrphanCommand $seedRecord ([pscustomobject]@{ childPid = [int]$req.childPid; effects = [string]$req.effects; sentinels = [pscustomobject]@{ command = [string]$req.sentinel } })
    $created = [DateTime]::Parse($record.creationDateUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
    if ($held.HasExited -or [Math]::Abs(($held.StartTime.ToUniversalTime() - $created).Ticks) -gt 10000) { return 'refused: the held handle is not the registered in-flight command' }
    $bound = [ordered]@{ pid = $record.pid; parentProcessId = $record.parentProcessId; creationDateUtc = $record.creationDateUtc; executablePath = $record.executablePath; commandLineSha256 = $record.commandLineSha256 }
    [IO.File]::WriteAllText("$($T.boundFile).tmp", (ConvertTo-Json -Compress -InputObject $bound), $utf8)
    [IO.File]::Move("$($T.boundFile).tmp", [string]$T.boundFile)
    [void](Wait-File $T.consumeFile 290)
    if ($held.HasExited) { return 'exited-after-bind' }
    $verdict = Stop-IdentifiedProcess $record $held
    if ($verdict -ne 'exited-before-kill') { return $verdict }
    if ($held.HasExited) { return 'exited-after-bind' }   # e.g. CIM 0 rows: only the held handle can prove the exit
    return "refused: PID $($record.pid) is alive but its identity could not be re-read; not killed and not treated as exited"
  } catch { return 'refused: ' + $_.Exception.Message } finally { $held.Dispose() }
}
`;
const supervisorScript = () => `${SUPERVISOR_FUNCTIONS.map(psFunction).join('')}${SUPERVISOR_PS}
$t = $env:LUHENG_SUPERVISE | ConvertFrom-Json
$node = [string]$t.node; $orphans = [Collections.Generic.List[object]]::new()
Invoke-SupervisedCommand $t
`;
function startSupervisor(dir, seedPid, notBeforeMs, files) {
  assert.ok(PWSH, 'pwsh 7 is required to bind the in-flight command before the crash on Windows');
  const script = join(dir, 'supervisor.ps1'); writeFileSync(script, psScript(supervisorScript()));
  const target = { seedPid, notBeforeMs, node: realpathSync.native(process.execPath), ...files };
  const child = spawn(PWSH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: cleanEnv({ LUHENG_SUPERVISE: JSON.stringify(target) }) });
  let out = '', err = ''; child.stdout.setEncoding('utf8').on('data', d => { out += d; }); child.stderr.setEncoding('utf8').on('data', d => { err += d; });
  const closed = new Promise(resolve => { child.on('error', e => { err += String(e); resolve(-1); }); child.on('close', code => resolve(code)); });
  let finished = null;
  return {
    bound: () => (existsSync(files.boundFile) ? JSON.parse(readFileSync(files.boundFile, 'utf8')) : null),
    finish: () => (finished ??= (async () => {
      writeFileSync(files.consumeFile, '', { flag: 'wx' });
      const code = await closed;
      return code === 0 ? out.trim().split(/\r?\n/).pop() : `refused: supervisor exited ${code} ${err.slice(-800)}`;
    })()),
  };
}
const WINDOWS_RELEASED = ['exited-after-bind', 'killed-after-identity-recheck'];
async function releaseOrphan(target, { platform = process.platform } = {}) {
  if (platform !== 'win32') return 'left-running-not-signalled';
  if (!target.supervisor) throw new Error('in-flight command cleanup refused (no handle was bound before the crash)');
  const verdict = await target.supervisor.finish(), bound = target.supervisor.bound();
  if (!bound) throw new Error(`in-flight command cleanup refused (no handle was bound before the crash; ${verdict})`);
  if (bound.pid !== target.pid || bound.parentProcessId !== target.seedPid) throw new Error(`in-flight command cleanup refused (bound PID ${bound.pid}/parent ${bound.parentProcessId} is not command ${target.pid} of seed ${target.seedPid})`);
  if (!WINDOWS_RELEASED.includes(verdict)) throw new Error(`in-flight command cleanup refused (${verdict})`);
  return verdict;
}
function orphanCleanup({ seed, seedPid, notBeforeMs, supervisor = null }, release = releaseOrphan) {
  let state = 'none';
  if (seed.childPid) {
    assert.match(readFileSync(seed.effects, 'utf8'), new RegExp(`^C2-START ${seed.childPid}$`, 'm'), 'effects log does not name this in-flight command');
    state = 'pending';
  }
  const target = { pid: seed.childPid, seedPid, notBeforeMs, effects: seed.effects, sentinel: seed.sentinels?.command, supervisor };
  return {
    get state() { return state; },
    async consume() {
      if (state !== 'pending') throw new Error(`in-flight command cleanup is ${state}; refusing a second attempt`);
      state = 'consuming'; state = await release(target); return state;
    },
  };
}
test('in-flight command cleanup is one-shot, bound before the crash and never signals a bare PID (fake kill, no real process)', async () => {
  const dir = temp('orphan-control'), realKill = process.kill, signalled = [];
  process.kill = (...args) => { signalled.push(args); return true; };
  try {
    const effects = join(dir, 'effects.log'); writeFileSync(effects, 'C2-START 7001\n');
    const seed = { childPid: 7001, effects, sentinels: { command: 'SENTINEL-7001' } }, crashed = supervisor => ({ seed, seedPid: 900, notBeforeMs: 1, supervisor });
    const fake = (bound, verdict) => { const calls = []; return { calls, bound: () => bound, finish: async () => { calls.push(verdict); return verdict; } }; };
    const BOUND = { pid: 7001, parentProcessId: 900 };
    const posix = orphanCleanup(crashed(null), t => releaseOrphan(t, { platform: 'linux' }));
    assert.equal(await posix.consume(), 'left-running-not-signalled');
    await assert.rejects(posix.consume(), /refusing a second attempt/);   // a finally re-run after PID reuse
    for (const [label, supervisor, pattern] of [
      ['no supervisor', null, /no handle was bound before the crash/],
      ['never bound', fake(null, 'refused: the seed never asked for a bind'), /no handle was bound before the crash/],
      ['stale bound PID', fake({ pid: 7002, parentProcessId: 900 }, 'exited-after-bind'), /is not command 7001 of seed 900/],
      ['foreign bound parent', fake({ pid: 7001, parentProcessId: 8001 }, 'exited-after-bind'), /is not command 7001 of seed 900/],
      ['gone before bind', fake(BOUND, 'refused: in-flight command PID 7001 was not running before the bind'), /cleanup refused \(refused: in-flight command PID 7001 was not running/],
      ['changed after bind', fake(BOUND, 'refused: PID 7001 no longer matches its recorded creationDateUtc; refusing to kill it.'), /cleanup refused \(refused: PID 7001/],
      ['unknown verdict', fake(BOUND, 'already-exited'), /cleanup refused \(already-exited\)/],
      ['bare exited-before-kill (CIM 0 rows, held handle not proven exited)', fake(BOUND, 'exited-before-kill'), /cleanup refused \(exited-before-kill\)/],
      ['held alive, CIM 0 rows', fake(BOUND, 'refused: PID 7001 is alive but its identity could not be re-read; not killed and not treated as exited'), /cleanup refused \(refused: PID 7001 is alive but its identity could not be re-read/],
    ]) {
      const cleanup = orphanCleanup(crashed(supervisor), t => releaseOrphan(t, { platform: 'win32' }));
      await assert.rejects(cleanup.consume(), pattern, label);
      assert.equal(cleanup.state, 'consuming', label); await assert.rejects(cleanup.consume(), /refusing a second attempt/, label);
      if (supervisor) assert.equal(supervisor.calls.length, 1, label);
    }
    for (const verdict of ['exited-after-bind', 'killed-after-identity-recheck']) {
      const supervisor = fake(BOUND, verdict), cleanup = orphanCleanup(crashed(supervisor), t => releaseOrphan(t, { platform: 'win32' }));
      assert.equal(await cleanup.consume(), verdict); await assert.rejects(cleanup.consume(), /refusing a second attempt/);
      assert.equal(supervisor.calls.length, 1);
    }
    // Source binding: the supervisor is the driver's functions verbatim + glue that binds before it releases the seed.
    const script = supervisorScript();
    for (const name of SUPERVISOR_FUNCTIONS) assert.ok(script.includes(psFunction(name)), `supervisor lacks the driver's ${name}`);
    const at = needle => { const index = SUPERVISOR_PS.indexOf(needle); assert.ok(index >= 0, needle); return index; };
    assert.ok(at('Open-ProcessHandle ([int]$req.childPid)') < at('Register-OrphanCommand $seedRecord') && at('Register-OrphanCommand $seedRecord') < at('[IO.File]::Move(')
      && at('[IO.File]::Move(') < at('Wait-File $T.consumeFile 290') && at('Wait-File $T.consumeFile 290') < at("if ($held.HasExited) { return 'exited-after-bind' }"));
    const pass = at("if ($verdict -ne 'exited-before-kill') { return $verdict }"), trusted = SUPERVISOR_PS.indexOf("if ($held.HasExited) { return 'exited-after-bind' }", pass);
    assert.ok(at('$verdict = Stop-IdentifiedProcess $record $held') < pass && pass < trusted && trusted < SUPERVISOR_PS.indexOf('is alive but its identity could not be re-read', trusted)
      && !SUPERVISOR_PS.includes('return Stop-IdentifiedProcess'), 'exited-before-kill may become a release only through the same held handle');
    assert.deepEqual(WINDOWS_RELEASED, ['exited-after-bind', 'killed-after-identity-recheck']);
    // Seed-side hook, executed: it returns (letting crashNow kill the seed) only once the bound marker exists.
    const hook = { requestFile: join(dir, 'request.json'), boundFile: join(dir, 'bound.json'), consumeFile: join(dir, 'consume'), waitMs: 400 };
    const runHook = (name, bind, value = seed) => spawnSync(process.execPath, ['-e', `(${seededHook(join(dir, name), bind)})(${JSON.stringify(value)}); console.log('returned')`], { encoding: 'utf8', timeout: 30000, env: cleanEnv() });
    const unbound = runHook('seed-a.json', hook);
    assert.equal(unbound.status, 3); assert.doesNotMatch(unbound.stdout, /returned/);
    assert.deepEqual(JSON.parse(readFileSync(hook.requestFile, 'utf8')), { childPid: 7001, effects, sentinel: 'SENTINEL-7001' });
    writeFileSync(hook.boundFile, '{}');
    assert.equal(runHook('seed-b.json', { ...hook, requestFile: join(dir, 'request-b.json') }, { ...seed, childPid: undefined }).status, 3);
    const bound = runHook('seed-c.json', { ...hook, requestFile: join(dir, 'request-c.json') });
    assert.equal(bound.status, 0); assert.match(bound.stdout, /returned/);
    assert.equal(runHook('seed-d.json', null).stdout.trim(), 'returned');
    for (const name of ['seed-a.json', 'seed-c.json', 'seed-d.json']) assert.equal(JSON.parse(readFileSync(join(dir, name), 'utf8')).childPid, 7001);
    writeFileSync(effects, 'C2-START 7002\n');
    assert.throws(() => orphanCleanup(crashed(null)), /does not name this in-flight command/);
    assert.deepEqual(signalled, [], 'cleanup must never call process.kill');
  } finally { process.kill = realKill; rmSync(dir, { recursive: true, force: true }); }
});
// Descendant cleanup in the driver: anchors only with held, snapshot-bound handles; stale/reused PIDs are never killed.
test('driver descendant cleanup source invariants (held handle before identity; anchors only when bound; kill only via held handle)', () => {
  const bind = psFunction('Open-BoundDescendant'), walk = psFunction('Get-VerifiedDescendants'), stop = psFunction('Stop-IdentifiedProcess');
  assert.ok(bind.indexOf('Open-ProcessHandle $cpid') >= 0 && bind.indexOf('Open-ProcessHandle $cpid') < bind.indexOf('Get-ProcessIdentity $cpid'), 'handle must be held before the current identity is read');
  for (const needle of ['$p.StartTime.ToUniversalTime() - $created', '$now.parentProcessId -eq [int]$Row.ParentProcessId', "$now.creationDateUtc -ceq $created.ToString('o')", '-not $p.HasExited'])
    assert.ok(bind.includes(needle), needle);
  const anchorLines = walk.split('\n').map((line, i, all) => [line, all[i - 1] || '']).filter(([line]) => line.includes('$anchors[$cpid] ='));
  assert.equal(anchorLines.length, 1); assert.match(anchorLines[0][1], /if \(\$b\.state -eq 'bound'\) \{$/);
  assert.doesNotMatch(walk, /Get-ProcessIdentity|Get-CimInstance|\.Kill\(/);
  assert.match(walk, /\$unproven\[\$cpid\] = \$created/); assert.match(walk, /reason = 'ancestor-not-proven'; killable = \$false/);
  assert.match(stop, /if \(\$Held\) \{ \$p = \$Held \}/);
  assert.deepEqual([...PS1.matchAll(/\.Kill\(([^)]*)\)/g)].map(m => m[0]), ['.Kill($true)', '.Kill()']);
  assert.ok(PS1.includes('Stop-IdentifiedProcess $d.identity $d.process'));
});
const MODEL_FUNCTIONS = ['Get-RowIdentity', 'Open-BoundDescendant', 'Get-VerifiedDescendants', 'Stop-IdentifiedProcess', 'Register-OrphanCommand', 'Stop-OrphanCommand'];
const processModelScript = () => `${MODEL_FUNCTIONS.map(psFunction).join('')}${SUPERVISOR_PS}
$s = $env:LUHENG_PS_SCENARIO | ConvertFrom-Json
$base = [DateTime]::new(2026, 10, 3, 0, 0, 0, [DateTimeKind]::Utc)
function At([int]$Seconds) { return $base.AddSeconds($Seconds) }
function Find($Map, [int]$Id) { $e = $Map.PSObject.Properties[[string]$Id]; if ($e) { return $e.Value }; return $null }
$appExe = 'C:\\fake\\Luheng Office Agent.exe'; $node = 'C:\\fake\\node.exe'
$kills = [Collections.Generic.List[int]]::new(); $identities = $s.identities; $found = @(); $opened = [Collections.Generic.List[object]]::new(); $stopPhase = $false
$owned = @($s.owned | ForEach-Object { [pscustomobject]@{ Id = [int]$_.pid; StartTimeUtc = (At $_.start) } })
function Get-ProcessSnapshot { return @($s.snapshot | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.pid; ParentProcessId = [int]$_.parent; CreationDate = (At $_.created).ToLocalTime(); ExecutablePath = [string]$_.exe } }) }
function Open-ProcessHandle([int]$ProcessId) {
  $h = Find $s.handles $ProcessId
  if (-not $h) { throw [ArgumentException]::new("Process with an Id of $ProcessId is not running.") }
  $fake = [pscustomobject]@{ Id = $ProcessId; Handle = [IntPtr]::new(1); HasExited = [bool]$h.exited; ExitAfterBind = [bool]$h.exitAfterBind; ExitOnStopRead = [bool]$h.exitOnStopRead; StartTime = (At $h.start).ToLocalTime() }
  $script:opened.Add($fake)
  $fake | Add-Member -MemberType ScriptMethod -Name Kill -Value { $script:kills.Add($this.Id); $this.HasExited = $true }
  $fake | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($ms) return $true }
  $fake | Add-Member -MemberType ScriptMethod -Name Dispose -Value { }
  return $fake
}
function Get-ProcessIdentity([int]$ProcessId) {
  if ($script:stopPhase) { foreach ($h in $script:opened) { if ($h.Id -eq $ProcessId -and $h.ExitOnStopRead) { $h.HasExited = $true } } }   # exits while being re-read
  $i = Find $script:identities $ProcessId
  if (-not $i) { return $null }
  return [pscustomobject]@{ pid = $ProcessId; parentProcessId = [int]$i.parent; creationDateUtc = (At $i.created).ToString('o'); executablePath = [string]$i.exe; commandLineSha256 = [string]$i.cmd; commandLine = [string]$i.cmd }
}
function Wait-File([string]$Path, [int]$Seconds, [string]$Abort = '') {
  if ($Path -like '*consume') {   # time passes: the seed crashes; a job-bound command ends with it
    $script:stopPhase = $true
    foreach ($h in $script:opened) { if ($h.ExitAfterBind) { $h.HasExited = $true } }
    if ($s.PSObject.Properties['identitiesAtStop']) { $script:identities = $s.identitiesAtStop }
    return $true
  }
  return [IO.File]::Exists($Path)
}
$out = [Collections.Generic.List[string]]::new()
if ($s.mode -eq 'supervisor') {
  $orphans = [Collections.Generic.List[object]]::new()
  $dir = Join-Path ([IO.Path]::GetTempPath()) ('luheng-supervisor-model-' + [guid]::NewGuid()); [void](New-Item -ItemType Directory -Path $dir)
  $T = [pscustomobject]@{ seedPid = 900; notBeforeMs = ((At 10) - [DateTime]::UnixEpoch).TotalMilliseconds; requestFile = (Join-Path $dir 'request.json'); boundFile = (Join-Path $dir 'bound.json'); consumeFile = (Join-Path $dir 'consume') }
  if (-not $s.PSObject.Properties['noRequest']) { [IO.File]::WriteAllText($T.requestFile, (ConvertTo-Json -Compress -InputObject ([ordered]@{ childPid = 1001; effects = 'C:\\fake\\files\\effects.log'; sentinel = 'SENTINEL-1001' }))) }
  $out.Add([string](Invoke-SupervisedCommand $T)); $out.Add('bound=' + [IO.File]::Exists($T.boundFile))
  Remove-Item -LiteralPath $dir -Recurse -Force
} elseif ($s.mode -eq 'orphan') {
  $orphans = [Collections.Generic.List[object]]::new(); $record = $null
  $seed = [pscustomobject]@{ childPid = 1001; effects = 'C:\\fake\\files\\effects.log'; sentinels = [pscustomobject]@{ command = 'SENTINEL-1001' } }
  try { $record = Register-OrphanCommand ([pscustomobject]@{ Id = 900; StartTimeUtc = (At 10) }) $seed } catch { $out.Add('refused: ' + $_.Exception.Message) }
  if ($record) {
    if ($s.PSObject.Properties['identitiesAtStop']) { $script:identities = $s.identitiesAtStop }
    foreach ($attempt in 1..2) { try { $out.Add([string](Stop-OrphanCommand $record)) } catch { $out.Add('refused: ' + $_.Exception.Message) } }
  }
} else {
  $found = @(Get-VerifiedDescendants)
  if ($s.PSObject.Properties['identitiesAtStop']) { $script:identities = $s.identitiesAtStop }
  foreach ($d in $found) { if ($d.killable) { try { $out.Add([string](Stop-IdentifiedProcess $d.identity $d.process)) } catch { $out.Add('refused: ' + $_.Exception.Message) } } }
}
[ordered]@{ found = @($found | ForEach-Object { [ordered]@{ pid = $_.identity.pid; killable = $_.killable; reason = $_.reason } }); outcomes = @($out); kills = @($kills) } | ConvertTo-Json -Depth 6 -Compress
`;
const NODE_FAKE = 'C:\\fake\\node.exe', C2_LINE = 'node.exe -e C2 C:\\fake\\files\\effects.log SENTINEL-1001';
const row = (pid, parent, created, exe = NODE_FAKE) => ({ pid, parent, created, exe });
const live = (start, exited = false, exitAfterBind = false, exitOnStopRead = false) => ({ start, exited, exitAfterBind, exitOnStopRead });
const ident = (parent, created, exe = NODE_FAKE, cmd = `cmd-${parent}-${created}`) => ({ parent, created, exe, cmd });
const KILLED = 'killed-after-identity-recheck';
const PROCESS_MODEL = {
  // Auditor's timeline: old child 1001 (parent 900, created 20) exited; PID 1001 is now an unrelated pinned node.exe.
  'stale snapshot, PID reused (handle and CIM both new)': [{ snapshot: [row(1001, 900, 20), row(1002, 1001, 25), row(1004, 900, 5)], handles: { 1001: live(50), 1002: live(25), 1004: live(5) }, identities: { 1001: ident(8001, 50), 1002: ident(1001, 25), 1004: ident(900, 5) } },
    { found: [[1001, false, 'pid-reused-or-changed'], [1002, false, 'ancestor-not-proven']], outcomes: [], kills: [] }],
  'handle StartTime matches but current parent differs': [{ snapshot: [row(1001, 900, 20), row(1002, 1001, 25)], handles: { 1001: live(20), 1002: live(25) }, identities: { 1001: ident(8001, 20), 1002: ident(1001, 25) } },
    { found: [[1001, false, 'pid-reused-or-changed'], [1002, false, 'ancestor-not-proven']], outcomes: [], kills: [] }],
  'CIM row matches snapshot but held handle is a newer process': [{ snapshot: [row(1001, 900, 20)], handles: { 1001: live(50) }, identities: { 1001: ident(900, 20) } },
    { found: [[1001, false, 'pid-reused-or-changed']], outcomes: [], kills: [] }],
  'exited ancestor: its live child is reported, never adopted': [{ snapshot: [row(1001, 900, 20), row(1002, 1001, 25)], handles: { 1002: live(25) }, identities: { 1002: ident(1001, 25) } },
    { found: [[1002, false, 'ancestor-not-proven']], outcomes: [], kills: [] }],
  'positive control: bound chain is killed once each via the held handle': [{ snapshot: [row(1001, 900, 20), row(1002, 1001, 25), row(1003, 900, 30, 'C:\\other\\tool.exe')], handles: { 1001: live(20), 1002: live(25), 1003: live(30) }, identities: { 1001: ident(900, 20), 1002: ident(1001, 25), 1003: ident(900, 30, 'C:\\other\\tool.exe') } },
    { found: [[1001, true, 'bound'], [1002, true, 'bound'], [1003, false, 'bound']], outcomes: [KILLED, KILLED], kills: [1001, 1002] }],
  'identity changes after binding: refused, sibling still verified': [{ snapshot: [row(1001, 900, 20), row(1002, 1001, 25)], handles: { 1001: live(20), 1002: live(25) }, identities: { 1001: ident(900, 20), 1002: ident(1001, 25) }, identitiesAtStop: { 1001: ident(900, 20, NODE_FAKE, 'changed'), 1002: ident(1001, 25) } },
    { found: [[1001, true, 'bound'], [1002, true, 'bound']], outcomes: ['refused: PID 1001 no longer matches its recorded commandLineSha256; refusing to kill it.', KILLED], kills: [1002] }],
  'orphan command: one kill, second consume is a no-op': [{ mode: 'orphan', handles: { 1001: live(20) }, identities: { 1001: ident(900, 20, NODE_FAKE, C2_LINE) } },
    { found: [], outcomes: [KILLED, KILLED], kills: [1001] }],
  'orphan command: PID reused before kill is refused and never retried': [{ mode: 'orphan', handles: { 1001: live(50) }, identities: { 1001: ident(900, 20, NODE_FAKE, C2_LINE) }, identitiesAtStop: { 1001: ident(8001, 50, NODE_FAKE, C2_LINE) } },
    { found: [], outcomes: ['refused: PID 1001 no longer matches its recorded parentProcessId; refusing to kill it.', 'kill-attempted'], kills: [] }],
  'supervisor: bound before the crash, command ends with the seed (trusted held-handle exit)': [{ mode: 'supervisor', handles: { 1001: live(20, false, true) }, identities: { 1001: ident(900, 20, NODE_FAKE, C2_LINE) } },
    { found: [], outcomes: ['exited-after-bind', 'bound=True'], kills: [] }],
  'supervisor: bound and still alive, killed once through the held handle after recheck': [{ mode: 'supervisor', handles: { 1001: live(20) }, identities: { 1001: ident(900, 20, NODE_FAKE, C2_LINE) } },
    { found: [], outcomes: [KILLED, 'bound=True'], kills: [1001] }],
  'supervisor: PID already gone before the bind': [{ mode: 'supervisor', handles: {}, identities: {} },
    { found: [], outcomes: ['refused: in-flight command PID 1001 was not running before the bind', 'bound=False'], kills: [] }],
  'supervisor: stale/reused PID (held handle newer than the CIM row)': [{ mode: 'supervisor', handles: { 1001: live(50) }, identities: { 1001: ident(900, 20, NODE_FAKE, C2_LINE) } },
    { found: [], outcomes: ['refused: the held handle is not the registered in-flight command', 'bound=False'], kills: [] }],
  'supervisor: foreign parent': [{ mode: 'supervisor', handles: { 1001: live(20) }, identities: { 1001: ident(8001, 20, NODE_FAKE, C2_LINE) } },
    { found: [], outcomes: ['refused: In-flight command was not started by the crashed seed process.', 'bound=False'], kills: [] }],
  'supervisor: different command line': [{ mode: 'supervisor', handles: { 1001: live(20) }, identities: { 1001: ident(900, 20, NODE_FAKE, 'node.exe -e other') } },
    { found: [], outcomes: ["refused: In-flight command line lacks this seed's unique marker or effects path.", 'bound=False'], kills: [] }],
  'supervisor: different executable': [{ mode: 'supervisor', handles: { 1001: live(20) }, identities: { 1001: ident(900, 20, 'C:\\other\\node.exe', C2_LINE) } },
    { found: [], outcomes: ['refused: In-flight command is not the pinned node.exe.', 'bound=False'], kills: [] }],
  'supervisor: created before the seed': [{ mode: 'supervisor', handles: { 1001: live(5) }, identities: { 1001: ident(900, 5, NODE_FAKE, C2_LINE) } },
    { found: [], outcomes: ['refused: In-flight command predates the seed process.', 'bound=False'], kills: [] }],
  'supervisor: bound, held process alive, CIM returns 0 rows at stop: refused, not killed': [{ mode: 'supervisor', handles: { 1001: live(20) }, identities: { 1001: ident(900, 20, NODE_FAKE, C2_LINE) }, identitiesAtStop: {} },
    { found: [], outcomes: ['refused: PID 1001 is alive but its identity could not be re-read; not killed and not treated as exited', 'bound=True'], kills: [] }],
  'supervisor: bound, CIM 0 rows because the held process really exited: trusted held-handle exit': [{ mode: 'supervisor', handles: { 1001: live(20, false, false, true) }, identities: { 1001: ident(900, 20, NODE_FAKE, C2_LINE) }, identitiesAtStop: {} },
    { found: [], outcomes: ['exited-after-bind', 'bound=True'], kills: [] }],
  'supervisor: identity changes after the bind while alive': [{ mode: 'supervisor', handles: { 1001: live(20) }, identities: { 1001: ident(900, 20, NODE_FAKE, C2_LINE) }, identitiesAtStop: { 1001: ident(8001, 50, NODE_FAKE, C2_LINE) } },
    { found: [], outcomes: ['refused: PID 1001 no longer matches its recorded parentProcessId; refusing to kill it.', 'bound=True'], kills: [] }],
  'supervisor: the seed never asks for a bind': [{ mode: 'supervisor', noRequest: true, handles: {}, identities: {} },
    { found: [], outcomes: ['refused: the seed never asked for a bind', 'bound=False'], kills: [] }],
  'orphan command: foreign parent is never registered': [{ mode: 'orphan', handles: { 1001: live(20) }, identities: { 1001: ident(8001, 20, NODE_FAKE, C2_LINE) } },
    { found: [], outcomes: ['refused: In-flight command was not started by the crashed seed process.'], kills: [] }],
};
test('driver process cleanup, exact PS functions over a fake process layer (no real kill): stale snapshots and reused PIDs are refused',
  { skip: PWSH ? false : 'pwsh 7 is not installed on this host (it is on windows-latest); the source invariants test above still runs' }, () => {
    for (const [name, [scenario, expected]] of Object.entries(PROCESS_MODEL)) {
      const result = JSON.parse(runPwsh(processModelScript(), { LUHENG_PS_SCENARIO: JSON.stringify({ mode: 'descendants', owned: [{ pid: 900, start: 10 }], snapshot: [], ...scenario }) }));
      assert.deepEqual({ found: result.found.map(f => [f.pid, f.killable, f.reason]), outcomes: result.outcomes, kills: result.kills }, expected, name);
    }
  });
for (const variant of ['pending', 'full']) {
  test(`interrupted ${variant} 0.5 profile: hard kill, then two restarts without replay (repository backend ${REPO_VERSION})`, async t => {
    const dir = temp(`recovery-${variant}`); let crashed, orphan;
    try {
      crashed = await crashSeed(dir, variant); const { seed } = crashed;
      orphan = orphanCleanup(crashed);
      assert.equal(seed.status, 'seeded-before-kill');
      if (variant === 'pending') assert.deepEqual(seed.atCrash.drafts, { mailSent: ['sent', 1], mailSending: ['sending', 1] });
      assert.equal(orphan.state, variant === 'full' ? 'pending' : 'none', 'only the full variant leaves an in-flight command');
      const effectsAtCrash = existsSync(seed.effects) ? readFileSync(seed.effects, 'utf8') : null;
      if (variant === 'full') {
        assert.ok(seed.operations.inFlightCommand, 'full seed must record the operation that was executing at the crash');
        assert.equal((effectsAtCrash.match(/^C2-START \d+$/gm) || []).length, 1);
        t.diagnostic(`in-flight command cleanup: ${await orphan.consume()}`);
      }
      for (const run of [1, 2]) {
        const report = await up.verifyRecovery({ backendDir: repo, dataDir: join(dir, `recovery-${variant}`, 'data'), seed, run, expectVersion: REPO_VERSION, quietMs: 300 });
        assert.equal(report.status, 'recovery-verified'); assert.deepEqual(report.counters, up.createEffectCounters());
        if (variant === 'pending') assert.deepEqual(report.mailFacts, clone(up.V05_PENDING_AFTER_RECOVERY));
        else assert.deepEqual(report.operations, { inFlightCommand: 'invalidated' });
        assert.equal(up.jsonHits(report, up.seedNeedles(seed)), 0, 'report must not carry private markers');
      }
      assert.equal(existsSync(seed.effects) ? readFileSync(seed.effects, 'utf8') : null, effectsAtCrash, 'command effects were appended after the crash');
    } finally {
      if (orphan) { if (orphan.state === 'pending') await orphan.consume(); } else if (crashed?.supervisor) await crashed.supervisor.finish();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// ------------------------------------------------------------------ CLI refusals
test('native modes refuse outside GitHub Actions and outside the installed app EXE; nothing is created', () => {
  const dir = temp('cli');
  try {
    const run = (args, env) => spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', env, timeout: 30000 });
    for (const mode of ['seed-v04', 'seed-recovery-v04']) {
      const data = join(dir, `${mode}-data`), args = [mode, '--install', join(dir, 'install'), '--data', data, '--out', join(dir, `${mode}.json`)];
      const local = run(args, cleanEnv());
      assert.equal(local.status, 2); assert.match(local.stderr, /Refusing: not running in GitHub Actions/);
      const ci = run(args, cleanEnv(CI_ENV));
      assert.equal(ci.status, 2); assert.match(ci.stderr, /Refusing: native mode requires Windows|Refusing: native mode must run under the installed app EXE/);
      assert.equal(existsSync(data), false); assert.equal(existsSync(join(dir, `${mode}.json`)), false);
    }
    const out = join(dir, 'fetched'), fetch = run(['fetch', '--lock', join(repo, 'scripts', 'windows-upgrade-lock.json'), '--out', out, '--report', join(dir, 'r.json')], cleanEnv(CI_ENV));
    assert.equal(fetch.status, 2); assert.match(fetch.stderr, /GH_TOKEN|expired/); assert.equal(existsSync(out), false);
    assert.match(run(['bogus'], cleanEnv()).stderr, /Usage: .*seed-recovery-v04.*verify-recovery-v04/);
    assert.match(run(['verify-recovery-v04', '--install', 'x'], cleanEnv(CI_ENV)).stderr, /Missing --data/);
    // Evidence scan mode (CI-node): clean tree passes, a planted digest fails.
    const seedFile = join(dir, 'seed.json'), root = join(dir, 'evidence'); mkdirSync(root);
    writeFileSync(seedFile, JSON.stringify({ sentinels: { a: 'LUHENG-SCAN-' + 'b2'.repeat(12) }, digestInputs: [['-e', 'x']] }));
    writeFileSync(join(dir, 'seeds.json'), JSON.stringify([seedFile])); writeFileSync(join(root, 'ok.log'), 'clean');
    assert.equal(run(['scan', '--root', root, '--seeds', join(dir, 'seeds.json'), '--out', join(dir, 'scan1.json')], cleanEnv(CI_ENV)).status, 0);
    writeFileSync(join(root, 'bad.log'), up.rawHash(['-e', 'x']));
    const bad = run(['scan', '--root', root, '--seeds', join(dir, 'seeds.json'), '--out', join(dir, 'scan2.json')], cleanEnv(CI_ENV));
    assert.equal(bad.status, 2); assert.match(bad.stderr, /Private markers found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
