'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { UpdateManager } = require('../update-manager.cjs');
const {
  createUpdateFiles, WINDOWS_NEW_FILE_OWNER_SCRIPT, WINDOWS_INSPECT_SCRIPT,
} = require('../update-files.cjs');
const policy = require('../update-policy.cjs');

const source = fs.readFileSync(path.resolve(__dirname, '../update-files.cjs'), 'utf8');
const privateDirectoryModule = path.resolve(__dirname, '../../lib/private-directory.mjs');
// These are deliberately synthetic bytes. No test launches or executes them.
const bytes = Buffer.from('MZ-synthetic-new-file-owner-regression-NEVER-EXECUTE');
const candidate = Object.freeze({
  version: '0.6.0-beta.2', sizeBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  downloadUrl: policy.assetDownloadURL('0.6.0-beta.2'),
  releaseUrl: policy.releaseURL('0.6.0-beta.2'),
  releaseDate: '2026-10-03T00:00:00Z', releaseNotes: 'Synthetic regression fixture',
  unsigned: true, channel: 'preview', id: 'd'.repeat(32),
});

function temporaryProfile(t) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'luheng-update-created-owner-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('new-file owner preparation uses a fixed, identity-bound owner-only Windows script', () => {
  assert.equal(typeof WINDOWS_NEW_FILE_OWNER_SCRIPT, 'string');
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /GetEnvironmentVariable\('LUHENG_UPDATE_PATH', 'Process'\)/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /LUHENG_UPDATE_EXPECTED_DEV/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /LUHENG_UPDATE_EXPECTED_INO/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /WindowsIdentity\]::GetCurrent\(\)\.User/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /CreateFileW/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /GetFileInformationByHandle/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /SetSecurityInfo/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /GetSecurityInfo/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /EqualSid/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /SetSecurityInfo\(file, 1u, 1u, expectedOwner, IntPtr\.Zero, IntPtr\.Zero, IntPtr\.Zero\)/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /GetSecurityInfo\(file, 1u, 1u,/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /value\.Links != 1[\s\S]*value\.SizeHigh != 0 \|\| value\.SizeLow != 0/);
  assert.match(WINDOWS_NEW_FILE_OWNER_SCRIPT, /LUHENG_UPDATE_NEW_FILE_READY/);
  assert.doesNotMatch(WINDOWS_NEW_FILE_OWNER_SCRIPT, /Set-Acl|SetAccessControl|AddAccessRule|SetAccessRuleProtection|AdjustTokenPrivileges|takeown|icacls|Unblock-File|Start-Process|Invoke-Expression/i);
});

test('owner preparation is confined to exclusive new partial and journal files before writing', () => {
  assert.match(source, /const initializeOwnedNewFile = async \(file, directory, handle, identity\)/);
  assert.equal((source.match(/\binitializeOwnedNewFile\b/g) || []).length, 3,
    'Only the helper declaration and two newly created file call sites are allowed');
  const initialize = source.slice(source.indexOf('const initializeOwnedNewFile'), source.indexOf('const freeSpace'));
  assert.match(initialize, /handle\.stat\(\{ bigint: true \}\)/);
  assert.match(initialize, /value\.nlink === 1n && value\.size === 0n/);
  assert.match(initialize, /value\.dev === held\.dev && value\.ino === held\.ino/);
  assert.match(initialize, /matches\(fs\.lstatSync\(file, \{ bigint: true \}\)\)/);
  assert.match(initialize, /LUHENG_UPDATE_EXPECTED_DEV: held\.dev\.toString\(\), LUHENG_UPDATE_EXPECTED_INO: held\.ino\.toString\(\)/);
  assert.ok(initialize.lastIndexOf('matches(await handle.stat(') > initialize.indexOf('runFixed(WINDOWS_NEW_FILE_OWNER_SCRIPT'));
  assert.ok(initialize.indexOf("windowsInspect(file, 'inspect')") > initialize.indexOf('runFixed(WINDOWS_NEW_FILE_OWNER_SCRIPT'));
  const journalWrite = source.slice(source.indexOf('async write(candidate)'), source.indexOf('async clear()'));
  assert.match(journalWrite, /fsp\.open\(temp, 'wx', 0o600\)/);
  assert.ok(journalWrite.indexOf('await initializeOwnedNewFile(') > journalWrite.indexOf('fsp.open('));
  assert.ok(journalWrite.indexOf('await initializeOwnedNewFile(') < journalWrite.indexOf('handle.writeFile('));
  const create = source.slice(source.indexOf('async create(candidate)'), source.indexOf('async finish(record, candidate)'));
  assert.match(create, /O_WRONLY[\s\S]*O_CREAT[\s\S]*O_EXCL/);
  assert.ok(create.indexOf('await initializeOwnedNewFile(') > create.indexOf('fsp.open('));
  assert.ok(create.indexOf('await initializeOwnedNewFile(') < create.indexOf('return { directory, partial, file, handle, identity }'));
});

test('owner initialization retains strict owner, DACL, identity, whole hash and MOTW verification', () => {
  assert.match(WINDOWS_INSPECT_SCRIPT, /GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)\.Value -ne \$user/);
  assert.match(WINDOWS_INSPECT_SCRIPT, /AccessControlType -ne 'Allow'/);
  assert.match(WINDOWS_INSPECT_SCRIPT, /IdentityReference\.Value -notin \$allowed/);
  assert.match(WINDOWS_INSPECT_SCRIPT, /ZoneId=3/);
  assert.match(source, /stat\.dev !== record\.identity\.dev \|\| stat\.ino !== record\.identity\.ino/);
  assert.match(source, /hash\.digest\('hex'\) !== candidate\.sha256/);
  assert.match(source, /windowsInspect\(record\.file, 'mark', candidate\.downloadUrl\)/);
  assert.match(source, /windowsInspect\(record\.file, 'verify-mark'\)/);
});

// This fixture uses ordinary local files and an injected subprocess result. It
// verifies failure propagation portably; it is not native Windows validation.
async function injectedFailureFixture(t) {
  const stateRoot = temporaryProfile(t);
  const fixtureModule = path.join(stateRoot, 'trusted-private-directory-fixture.mjs');
  fs.writeFileSync(fixtureModule, [
    "import { mkdirSync, chmodSync } from 'node:fs';",
    'export function preparePrivateDirectory(directory) {',
    '  mkdirSync(directory, { recursive: true, mode: 0o700 });',
    "  if (process.platform !== 'win32') chmodSync(directory, 0o700);",
    '}',
    '',
  ].join('\n'));
  const attempts = [];
  const run = (command, args, options) => {
    assert.equal(command, path.win32.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    assert.deepEqual(args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.equal(options.shell, false);
    if (args[4] === WINDOWS_NEW_FILE_OWNER_SCRIPT) {
      const file = options.env.LUHENG_UPDATE_PATH;
      assert.equal(fs.statSync(file).size, 0, 'Owner preparation precedes any download or journal bytes');
      attempts.push(file);
      return { status: 1, stdout: '', stderr: 'Synthetic owner preparation failure' };
    }
    assert.equal(args[4], WINDOWS_INSPECT_SCRIPT);
    return { status: 0, stdout: 'LUHENG_UPDATE_FILE_READY\n', stderr: '' };
  };
  const files = await createUpdateFiles({
    stateRoot, privateDirectoryModule: fixtureModule, platform: 'win32',
    env: { ...process.env, SystemRoot: 'C:\\Windows' }, run,
  });
  return { stateRoot, files, attempts };
}

test('portable owner-preparation failure stops download before ready or stream opening', async t => {
  const fixture = await injectedFailureFixture(t);
  let streamOpens = 0;
  const manager = new UpdateManager({
    currentVersion: '0.6.0-beta.1', supported: true, files: fixture.files,
    journal: fixture.files.journal,
    transport: { openAssetStream() { streamOpens++; throw new Error('Must not open the download stream'); } },
  });
  t.after(() => manager.close());
  manager.candidate = candidate;
  manager.transition('available', { channel: 'preview', candidate });
  manager.downloadUpdate({ candidateId: candidate.id });
  await manager.waitForIdle();
  assert.equal(manager.status().phase, 'error');
  assert.equal(manager.status().error.code, 'FILE_SECURITY');
  assert.equal(manager.record, null);
  assert.equal(streamOpens, 0);
  assert.equal(fixture.attempts.length, 1);
  assert.equal(await fixture.files.journal.read(), null);
  assert.equal(fs.existsSync(path.join(path.dirname(fixture.attempts[0]), 'installer.exe')), false);
});

test('portable owner-preparation failure does not publish a pending journal', async t => {
  const fixture = await injectedFailureFixture(t);
  await assert.rejects(fixture.files.journal.write(candidate), { code: 'FILE_SECURITY' });
  assert.equal(fixture.attempts.length, 1);
  assert.match(path.basename(fixture.attempts[0]), /^\.pending-[a-f0-9]{32}\.tmp$/);
  assert.equal(fs.existsSync(fixture.attempts[0]), false);
  assert.equal(fs.existsSync(path.join(fixture.stateRoot, 'updates', 'pending.json')), false);
  assert.equal(await fixture.files.journal.read(), null);
});

// Fixed, read-only observation. Paths and the optional ADS read mode travel only
// in environment variables, never in executable PowerShell source.
const WINDOWS_OWNER_SNAPSHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('LUHENG_OWNER_TEST_PATH', 'Process')
$readZone = [Environment]::GetEnvironmentVariable('LUHENG_OWNER_TEST_ZONE', 'Process')
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$item = Get-Item -LiteralPath $target -Force
$acl = [IO.File]::GetAccessControl($target)
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
 [ordered]@{
  sid = $_.IdentityReference.Value
  type = $_.AccessControlType.ToString()
  inherited = $_.IsInherited
  rights = [int]$_.FileSystemRights
  inheritance = [int]$_.InheritanceFlags
  propagation = [int]$_.PropagationFlags
 }
})
$zone = if ($readZone -eq '1') { Get-Content -LiteralPath $target -Stream Zone.Identifier -Raw -Encoding ASCII } else { $null }
[ordered]@{
 currentSid = $currentSid
 ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
 size = $item.Length
 rules = $rules
 zone = $zone
} | ConvertTo-Json -Depth 5 -Compress
`;

test('Internet MOTW uses Windows PowerShell literal NTFS stream APIs', () => {
  assert.match(WINDOWS_INSPECT_SCRIPT, /\$zoneText = \[string\]::Join\(\[Environment\]::NewLine, @\('\[ZoneTransfer\]', 'ZoneId=3', "HostUrl=\$source", ''\)\)/);
  assert.match(WINDOWS_INSPECT_SCRIPT, /Set-Content -LiteralPath \$target -Stream Zone\.Identifier -Encoding ASCII -Value \$zoneText -NoNewline/);
  for (const script of [WINDOWS_INSPECT_SCRIPT, WINDOWS_OWNER_SNAPSHOT_SCRIPT]) {
    assert.match(script, /Get-Content -LiteralPath \$target -Stream Zone\.Identifier -Raw -Encoding ASCII/);
    assert.doesNotMatch(script, /\[(?:System\.)?IO\.File\]::(?:ReadAllText|WriteAllText)|:Zone\.Identifier/);
    assert.doesNotMatch(script, /Unblock-File/i);
  }
});

function nativeSnapshot(file, readZone = false) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  assert.ok(systemRoot && path.win32.isAbsolute(systemRoot), 'A Windows system PowerShell path is required');
  const result = spawnSync(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_OWNER_SNAPSHOT_SCRIPT], {
      env: { ...process.env, LUHENG_OWNER_TEST_PATH: file, LUHENG_OWNER_TEST_ZONE: readZone ? '1' : '0' },
      encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 65536, shell: false,
    });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

function sortedRules(snapshot) {
  return [...snapshot.rules].sort((left, right) => left.sid.localeCompare(right.sid));
}

function assertCurrentUserAndInheritedAcl(snapshot) {
  assert.equal(snapshot.ownerSid, snapshot.currentSid, 'The file owner must be the actual process user SID');
  assert.equal(snapshot.rules.length, 3, 'Only current user, SYSTEM and Administrators inherited Allow entries are expected');
  assert.deepEqual(snapshot.rules.map(rule => rule.sid).sort(),
    [snapshot.currentSid, 'S-1-5-18', 'S-1-5-32-544'].sort());
  for (const rule of snapshot.rules) {
    assert.equal(rule.type, 'Allow');
    assert.equal(rule.inherited, true);
    assert.equal(rule.rights, 2032127); // FileSystemRights.FullControl
    assert.equal(rule.inheritance, 0); // File ACE: InheritanceFlags.None
    assert.equal(rule.propagation, 0); // PropagationFlags.None
  }
}

async function nativeFixture(t) {
  // The Windows PowerShell 5 subprocess must load its own built-in modules,
  // not PowerShell 7 modules inherited from the CI command shell.
  const previousModules = process.env.PSModulePath;
  process.env.PSModulePath = path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  t.after(() => { if (previousModules === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = previousModules; });
  const stateRoot = fs.mkdtempSync(path.join(tmpdir(), 'luheng-update-created-owner-'));
  const records = [];
  let files;
  t.after(async () => {
    for (const record of records) await files.discard(record);
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });
  const { preparePrivateDirectory } = await import(pathToFileURL(privateDirectoryModule).href);
  preparePrivateDirectory(stateRoot);
  const beforeOwnerPreparation = [];
  const run = (command, args, options) => {
    if (args[4] === WINDOWS_NEW_FILE_OWNER_SCRIPT) {
      const file = options.env.LUHENG_UPDATE_PATH;
      const snapshot = nativeSnapshot(file);
      assert.equal(snapshot.size, 0, 'Native owner preparation must happen while the newly opened file is empty');
      beforeOwnerPreparation.push({ file, snapshot });
    }
    // This is always the actual native subprocess result, never an injected success.
    const result = spawnSync(command, args, options);
    if (result.error || result.status !== 0) t.diagnostic(JSON.stringify({ nativeCommand: command, stage: args[4] === WINDOWS_NEW_FILE_OWNER_SCRIPT ? 'new-file-owner' : args[4] === WINDOWS_INSPECT_SCRIPT ? 'existing-inspect' : 'private-directory', status: result.status, error: result.error?.message, stdout: result.stdout, stderr: result.stderr, PSModulePath: options.env.PSModulePath }));
    return result;
  };
  files = await createUpdateFiles({ stateRoot, privateDirectoryModule, run });
  return { stateRoot, files, records, beforeOwnerPreparation };
}

const nativeWindows = {
  skip: process.platform !== 'win32' ? 'Requires actual Windows ownership, inherited DACL and NTFS MOTW support' : false,
};

test('native Windows partial becomes current-user owned and retains ACL, hash and Internet MOTW', nativeWindows, async t => {
  const fixture = await nativeFixture(t);
  const record = await fixture.files.create(candidate);
  fixture.records.push(record);
  assert.equal(fixture.beforeOwnerPreparation.length, 1);
  const original = fixture.beforeOwnerPreparation[0];
  assert.equal(original.file, record.partial);
  t.diagnostic(`Native default new-file owner=${original.snapshot.ownerSid}; current user=${original.snapshot.currentSid}; owner correction required=${original.snapshot.ownerSid !== original.snapshot.currentSid}`);
  const partial = nativeSnapshot(record.partial);
  assert.equal(partial.size, 0);
  assertCurrentUserAndInheritedAcl(partial);
  assert.deepEqual(sortedRules(partial), sortedRules(original.snapshot), 'Owner preparation preserves the inherited DACL');
  await record.handle.writeFile(bytes);
  await record.handle.sync();
  await record.handle.close();
  record.handle = null;
  await fixture.files.finish(record, candidate);
  assert.equal(await fixture.files.verify(record, candidate), record.file);
  const final = nativeSnapshot(record.file, true);
  assertCurrentUserAndInheritedAcl(final);
  assert.equal(final.size, bytes.length);
  assert.deepEqual(sortedRules(final), sortedRules(original.snapshot));
  assert.match(final.zone, /(?:^|\r?\n)ZoneId=3\r?(?:\n|$)/);
  assert.equal(final.zone, ['[ZoneTransfer]', 'ZoneId=3', 'HostUrl=' + candidate.downloadUrl, ''].join('\r\n'));
  const content = await fsp.readFile(record.file);
  assert.deepEqual(content, bytes);
  assert.equal(createHash('sha256').update(content).digest('hex'), candidate.sha256);
  const finalStat = await fsp.stat(record.file);
  assert.equal(finalStat.dev, record.identity.dev);
  assert.equal(finalStat.ino, record.identity.ino);
});

test('native Windows new journal temp becomes current-user owned before write/read/clear', nativeWindows, async t => {
  const fixture = await nativeFixture(t);
  assert.equal(await fixture.files.journal.read(), null);
  await fixture.files.journal.write(candidate);
  assert.equal(fixture.beforeOwnerPreparation.length, 1);
  const original = fixture.beforeOwnerPreparation[0];
  assert.match(path.basename(original.file), /^\.pending-[a-f0-9]{32}\.tmp$/);
  t.diagnostic(`Native default journal-temp owner=${original.snapshot.ownerSid}; current user=${original.snapshot.currentSid}; owner correction required=${original.snapshot.ownerSid !== original.snapshot.currentSid}`);
  const journalPath = path.join(fixture.stateRoot, 'updates', 'pending.json');
  const pending = nativeSnapshot(journalPath);
  assertCurrentUserAndInheritedAcl(pending);
  assert.deepEqual(sortedRules(pending), sortedRules(original.snapshot), 'Journal owner preparation preserves the inherited DACL');
  assert.deepEqual(await fixture.files.journal.read(), { schema: 1, version: candidate.version, sha256: candidate.sha256 });
  assert.equal(fs.readFileSync(journalPath, 'utf8'), JSON.stringify({ schema: 1, version: candidate.version, sha256: candidate.sha256 }) + '\n');
  await fixture.files.journal.clear();
  assert.equal(fs.existsSync(journalPath), false);
  assert.equal(await fixture.files.journal.read(), null);
});
