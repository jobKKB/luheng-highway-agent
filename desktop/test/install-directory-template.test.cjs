'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { copyBoundNsisTemplates } = require('../nsis-template-adapter.cjs');
const pinned = require('../nsis-26.15.3-template-sha256.json');
const sourceDirectory = require('app-builder-lib/out/targets/nsis/nsisUtil.js').nsisTemplatesDir;
const builderVersion = require('app-builder-lib/package.json').version;

// These tests copy actual pinned templates and inspect source contracts. They
// neither run an installer nor claim native Windows ownership/ACL validation.
function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'luheng-install-template-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function snapshot(directory, relative = '') {
  const files = new Map();
  for (const entry of fs.readdirSync(path.join(directory, relative), { withFileTypes: true })) {
    const name = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      for (const [nested, value] of snapshot(directory, name)) files.set(nested, value);
    } else {
      assert.ok(entry.isFile(), 'Template inventory contains ordinary files only');
      const file = path.join(directory, name);
      const stat = fs.statSync(file);
      files.set(name, { bytes: fs.readFileSync(file), dev: stat.dev, ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs });
    }
  }
  return new Map([...files].sort(([left], [right]) => left.localeCompare(right)));
}

function assertOrder(text, fragments) {
  let previous = -1;
  for (const fragment of fragments) {
    const current = text.indexOf(fragment, previous + 1);
    assert.ok(current > previous, 'Expected ordered template operation: ' + fragment);
    previous = current;
  }
}

function preparedTemplates(t) {
  const temporaryRoot = temporaryDirectory(t);
  const prepared = copyBoundNsisTemplates(sourceDirectory, { version: builderVersion, temporaryRoot });
  t.after(prepared.cleanup);
  return { temporaryRoot, prepared };
}

test('the complete installed 26.15.3 NSIS inventory matches the independent byte pin', () => {
  assert.equal(builderVersion, '26.15.3');
  assert.equal(pinned.schema, 1);
  assert.equal(pinned.builderVersion, builderVersion);
  const originals = snapshot(sourceDirectory);
  assert.equal(originals.size, 24);
  assert.deepEqual([...originals.keys()].sort(), Object.keys(pinned.files).sort());
  for (const [name, value] of originals) {
    assert.equal(createHash('sha256').update(value.bytes).digest('hex'), pinned.files[name], name);
  }
});

test('the adapter makes a private real copy and leaves every dependency source unchanged', t => {
  const originals = snapshot(sourceDirectory);
  const { temporaryRoot, prepared } = preparedTemplates(t);
  assert.equal(prepared.builderVersion, builderVersion);
  assert.equal(prepared.sourceFilesVerified, 24);
  assert.equal(path.dirname(prepared.directory), temporaryRoot);
  assert.match(path.basename(prepared.directory), /^luheng-nsis26-templates-/);
  assert.notEqual(prepared.directory, sourceDirectory);
  const copies = snapshot(prepared.directory);
  assert.deepEqual([...copies.keys()], [...originals.keys()]);
  assert.deepEqual(snapshot(sourceDirectory), originals, 'Source bytes, identity, mode and mtime are unchanged');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(prepared.directory).mode & 0o777, 0o700);
    for (const [name, value] of copies) {
      assert.equal(value.mode & 0o777, 0o600, name + ' copied file mode');
      assert.equal(fs.statSync(path.dirname(path.join(prepared.directory, name))).mode & 0o777, 0o700);
    }
  }
  prepared.cleanup();
  assert.equal(fs.existsSync(prepared.directory), false);
  assert.ok(fs.existsSync(temporaryRoot));
  assert.deepEqual(snapshot(sourceDirectory), originals);
  prepared.cleanup(); // Normal cleanup is idempotent.
});

test('only installer initialization and the install-section hook placements differ', t => {
  const originals = snapshot(sourceDirectory);
  const { prepared } = preparedTemplates(t);
  const copies = snapshot(prepared.directory);
  const changed = [...originals.keys()].filter(name => !originals.get(name).bytes.equals(copies.get(name).bytes));
  assert.deepEqual(changed.sort(), ['installSection.nsh', 'installer.nsi']);
  const installer = copies.get('installer.nsi').bytes.toString('utf8');
  const section = copies.get('installSection.nsh').bytes.toString('utf8');
  assert.match(installer, /Function \.onInit\s+Call setInstallSectionSpaceRequired\s+InitPluginsDir\s+SetOutPath "\$PLUGINSDIR"\s+\$\{LogSet\} on/);
  const onInit = installer.slice(installer.indexOf('Function .onInit'), installer.indexOf('FunctionEnd', installer.indexOf('Function .onInit')));
  assert.doesNotMatch(onInit, /SetOutPath \$INSTDIR/);
  assert.equal(installer.replace('  InitPluginsDir\n  SetOutPath "$PLUGINSDIR"', '  SetOutPath $INSTDIR'),
    originals.get('installer.nsi').bytes.toString('utf8'), 'No other installer-template changes');
  assert.equal(section.replace('!insertmacro luhengPreflightInstallDirectory\n\n', '').replace('!insertmacro luhengCreateInstallDirectory\n\n', ''),
    originals.get('installSection.nsh').bytes.toString('utf8'), 'No other install-section changes');
  assert.equal((section.match(/!insertmacro luhengPreflightInstallDirectory/g) || []).length, 1);
  assert.equal((section.match(/!insertmacro luhengCreateInstallDirectory/g) || []).length, 1);
  assertOrder(section, [
    '!insertmacro luhengPreflightInstallDirectory',
    '!insertmacro uninstallOldVersion SHELL_CONTEXT',
    '!insertmacro handleUninstallResult SHELL_CONTEXT',
    '!insertmacro uninstallOldVersion HKEY_CURRENT_USER',
    '!insertmacro handleUninstallResult HKEY_CURRENT_USER',
    '!insertmacro luhengCreateInstallDirectory',
    'SetOutPath $INSTDIR',
    '!insertmacro installApplicationFiles',
    '!insertmacro registryAddInstallInfo',
    '!insertmacro customInstall',
  ]);
  assert.deepEqual(copies.get('uninstaller.nsh').bytes, originals.get('uninstaller.nsh').bytes);
});

test('unsupported builder versions fail before allocating any copied templates', t => {
  const temporaryRoot = temporaryDirectory(t);
  for (const version of [undefined, '26.15.2', '26.15.4', '27.0.0']) {
    assert.throws(() => copyBoundNsisTemplates(sourceDirectory, { version, temporaryRoot }), /Only byte-verified electron-builder 26\.15\.3/);
    assert.deepEqual(fs.readdirSync(temporaryRoot), []);
  }
});

for (const mutation of ['changed bytes', 'missing file', 'extra file']) {
  test('a template set with ' + mutation + ' fails before creating output', t => {
    const fixtureRoot = temporaryDirectory(t);
    const source = path.join(fixtureRoot, 'source');
    const temporaryRoot = path.join(fixtureRoot, 'output');
    fs.cpSync(sourceDirectory, source, { recursive: true });
    fs.mkdirSync(temporaryRoot);
    if (mutation === 'changed bytes') fs.appendFileSync(path.join(source, 'include', 'installUtil.nsh'), '\n# changed local fixture\n');
    if (mutation === 'missing file') fs.unlinkSync(path.join(source, 'include', 'installUtil.nsh'));
    if (mutation === 'extra file') fs.writeFileSync(path.join(source, 'extra-fixture.nsh'), '# extra local fixture\n');
    assert.throws(() => copyBoundNsisTemplates(source, { version: builderVersion, temporaryRoot }),
      mutation === 'changed bytes' ? /template bytes changed.*include\/installUtil\.nsh/ : /template inventory changed/);
    assert.deepEqual(fs.readdirSync(temporaryRoot), [], 'Validation precedes output allocation');
  });
}

test('activation selects the copied template property once and cleans it on process exit', () => {
  // A separate Node process isolates the build-only activation and its exit
  // handler. No builder target, native compiler, or installer is executed.
  const adapterPath = require.resolve('../nsis-template-adapter.cjs');
  const nsisPath = require.resolve('app-builder-lib/out/targets/nsis/nsisUtil.js');
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const path = require('node:path');
    const nsis = require(${JSON.stringify(nsisPath)});
    const original = nsis.nsisTemplatesDir;
    const originalUninstaller = fs.readFileSync(path.join(original, 'uninstaller.nsh'));
    const adapter = require(${JSON.stringify(adapterPath)});
    const first = adapter.activateBoundNsisTemplates();
    assert.strictEqual(adapter.activateBoundNsisTemplates(), first);
    assert.equal(first.original, original);
    assert.equal(nsis.nsisTemplatesDir, first.directory);
    assert.notEqual(nsis.nsisTemplatesDir, original);
    assert.deepEqual(fs.readFileSync(path.join(first.directory, 'uninstaller.nsh')), originalUninstaller);
    process.once('exit', () => {
      assert.equal(nsis.nsisTemplatesDir, original);
      assert.equal(fs.existsSync(first.directory), false);
    });
    console.log(JSON.stringify({ directory: first.directory, original, verified: first.sourceFilesVerified }));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', shell: false, timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const activated = JSON.parse(result.stdout.trim());
  assert.equal(activated.verified, 24);
  assert.equal(activated.original, sourceDirectory);
  assert.equal(fs.existsSync(activated.directory), false, 'Exit cleanup removed the copied templates');
  assert.ok(fs.existsSync(activated.original));
});

test('packaging keeps builder normal uninstaller generation and signing available', () => {
  const config = require('../electron-builder.cjs');
  assert.equal(Object.hasOwn(config.nsis, 'script'), false, 'A custom nsis.script would bypass builder uninstaller signing');
  assert.equal(config.win.requestedExecutionLevel, 'asInvoker');
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.packElevateHelper, false);
  assert.match(config.beforePack.toString(), /activateBoundNsisTemplates\(\)/);
  const targetSource = fs.readFileSync(require.resolve('app-builder-lib/out/targets/nsis/NsisTarget.js'), 'utf8');
  const signing = targetSource.slice(targetSource.indexOf('async computeScriptAndSignUninstaller('), targetSource.indexOf('    computeVersionKey('));
  assert.match(signing, /customScriptPath \|\| path\.join\(nsisUtil_1\.nsisTemplatesDir, "installer\.nsi"\)/);
  assertOrder(signing, ['defines.BUILD_UNINSTALLER = null', 'await this.executeMakensis(', 'await packager.signIf(uninstallerPath)', 'delete defines.BUILD_UNINSTALLER', 'return { script, isCustomScript: false }']);
  assert.match(targetSource, /cwd: nsisUtil_1\.nsisTemplatesDir/);
  const installer = fs.readFileSync(path.join(sourceDirectory, 'installer.nsi'), 'utf8');
  assert.match(installer, /!ifdef BUILD_UNINSTALLER\s+WriteUninstaller "\$\{UNINSTALLER_OUT_FILE\}"\s+!insertmacro quitSuccess/);
  assert.match(installer, /!ifdef BUILD_UNINSTALLER\s+!include "uninstaller\.nsh"/);
});

function helperSource() {
  return fs.readFileSync(path.resolve(__dirname, '../current-user-install-directory.nsh'), 'utf8')
    .replace(/^\s*;.*$/gm, '');
}

function nsisFunction(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp('Function ' + escaped + '\\s+([\\s\\S]*?)FunctionEnd'));
  assert.ok(match, 'Declared NSIS helper function: ' + name);
  return match[1];
}

test('helper declarations are delayed to customHeader and excluded from builder uninstaller compilation', () => {
  const source = helperSource();
  assert.match(source, /!macro customHeader\s+!ifndef BUILD_UNINSTALLER\s+!insertmacro luhengInstallDirectoryHeader\s+!endif\s+!macroend/);
  assert.match(source, /!macro luhengInstallDirectoryHeader\s+!if \$\{NSIS_CHAR_SIZE\} != 2/);
  assert.match(source, /!ifdef NSIS_PTR_SIZE\s+!if \$\{NSIS_PTR_SIZE\} != 4/);
  for (const [macro, target] of [
    ['luhengPreflightInstallDirectory', 'luhengPreflightDirectory'],
    ['luhengCreateInstallDirectory', 'luhengCreateDirectory'],
    ['luhengFinishInstallDirectory', 'luhengFinishDirectory'],
    ['luhengCloseInstallDirectory', 'luhengCloseDirectoryResources'],
  ]) {
    assert.match(source, new RegExp('!macro ' + macro + '\\s+Call ' + target));
    nsisFunction(source, target);
  }
  const config = require('../electron-builder.cjs');
  const include = fs.readFileSync(config.nsis.include, 'utf8');
  assert.match(include, /!include "\$\{__FILEDIR__\}\\current-user-install-directory\.nsh"/);
  assert.match(include, /!macro customInstall\s+!insertmacro luhengFinishInstallDirectory\s+!macroend/);
});

test('directory creation uses the actual TokenUser owner in a new-object security descriptor', () => {
  const source = helperSource();
  const token = nsisFunction(source, 'luhengReadCurrentUser');
  assert.match(token, /OpenProcessToken\([^\n]+i 0x8/); // TOKEN_QUERY only.
  const tokenReads = token.match(/GetTokenInformation\([^\n]+/g) || [];
  assert.equal(tokenReads.length, 2);
  for (const read of tokenReads) assert.match(read, /, i 1,/); // TokenUser, never TokenOwner.
  assertOrder(token, ['StrCpy $luidUserSid $0', 'advapi32::IsValidSid(', 'advapi32::ConvertSidToStringSidW(', 'StrCpy $luidUserSidText $0']);
  assert.match(token, /O:\$luidUserSidText/);
  assert.match(token, /D:P\(A;OICI;FA;;;\$luidUserSidText\)\(A;OICI;FA;;;SY\)\(A;OICI;FA;;;BA\)/);
  assertOrder(token, ['advapi32::ConvertStringSecurityDescriptorToSecurityDescriptorW(', 'StrCpy $luidCreateSd $5']);
  const native = nsisFunction(source, 'luhengNativeDirectory');
  assert.match(native, /\*\(i 24, \$\{SYSTYPE_PTR\} \$luidNativeRoot,[^\n]+\$\{SYSTYPE_PTR\} \$luidNativeSd/);
  assert.match(native, /ntdll::NtCreateFile\([^\n]+i 3, i \$luidNativeDisposition, i \$luidNativeOptions/);
  assert.match(native, /StrCpy \$luidNativeInformation \$8/);
  const verify = nsisFunction(source, 'luhengVerifyDirectoryHandle');
  assertOrder(verify, ['kernel32::GetFileInformationByHandle(', 'StrCpy $luidCheckIdentity', 'advapi32::GetSecurityInfo(', 'advapi32::EqualSid(']);
  assert.match(verify, /EqualSid\(\$\{SYSTYPE_PTR\} r2, \$\{SYSTYPE_PTR\} \$luidUserSid\)/);
  assert.match(verify, /\$luidVerifyAcl == 1[\s\S]*GetSecurityDescriptorControl[\s\S]*\$4 <> 0x1004/);
  assert.match(verify, /\$4 != 3/);
  assert.match(verify, /\$7 != 3[\s\S]*\$R0 <> 0x1f01ff/);
  assert.match(verify, /\$5 != 7/);
});

test('native output pointers use one source slot and one real destination slot', () => {
  const source = helperSource();
  // System's parser advances the source/output slot for both an explicit 0
  // and a dot. An initialized pointer therefore uses `0 rN`, not `0 .rN`.
  // Check the API contracts that supply token, SD, native-handle and ACL data.
  assert.doesNotMatch(source, /\*(?:i|\$\{SYSTYPE_PTR\}) 0 \.r\d+/);
  const token = nsisFunction(source, 'luhengReadCurrentUser');
  assert.match(token, /OpenProcessToken\([^\n]+\*\$\{SYSTYPE_PTR\} 0 r1\) i \.r2/);
  assert.match(token, /GetTokenInformation\([^\n]+, i 0, \*i 0 r3\) i \.r2/);
  assert.match(token, /GetTokenInformation\([^\n]+, i r3, \*i 0 r5\) i \.r2/);
  assert.match(token, /ConvertSidToStringSidW\([^\n]+\*\$\{SYSTYPE_PTR\} 0 r4\)/);
  assert.match(token, /ConvertStringSecurityDescriptorToSecurityDescriptorW\([^\n]+\*\$\{SYSTYPE_PTR\} 0 r5,/);
  const native = nsisFunction(source, 'luhengNativeDirectory');
  assert.match(native, /NtCreateFile\(\*\$\{SYSTYPE_PTR\} 0 r6,/);
  const verify = nsisFunction(source, 'luhengVerifyDirectoryHandle');
  assert.match(verify, /GetSecurityInfo\([^\n]+\*\$\{SYSTYPE_PTR\} 0 r2,[^\n]+\*\$\{SYSTYPE_PTR\} 0 r3,[^\n]+\*\$\{SYSTYPE_PTR\} 0 r9\)/);
  assert.match(verify, /GetSecurityDescriptorControl\([^\n]+\*i 0 r4, \*i 0 r5\)/);
  assert.match(verify, /GetAce\([^\n]+\*\$\{SYSTYPE_PTR\} 0 r6\)/);
});

test('native decimal DWORD readback compares bit masks numerically in LogicLib', () => {
  const verify = nsisFunction(helperSource(), 'luhengVerifyDirectoryHandle');
  // LogicLib != is StrCmp; <> is IntCmp. IntOp and System return decimal
  // register strings even when their equivalent source constants use hex.
  for (const [register, expected, rejected] of [
    ['$4', 0x1004, [0, 0x4, 0x1000]],
    ['$R0', 0x1f01ff, [0, 0x120089, 0x1f01fe]],
  ]) {
    const escaped = register.replace('$', '\\$');
    const condition = verify.match(new RegExp(escaped + ' (<>|!=) (0x[0-9a-f]+)', 'i'));
    assert.ok(condition, register + ' must retain its exact mask comparison');
    const compare = actual => condition[1] === '<>'
      ? Number(actual) !== Number(condition[2]) : String(actual) !== condition[2];
    assert.equal(Number(condition[2]), expected);
    assert.equal(compare(String(expected)), false, 'Valid decimal native mask must pass');
    for (const actual of rejected) assert.equal(compare(String(actual)), true, 'Invalid native mask must fail');
  }
});

test('preflight scopes existing installs to app keys and reads them without ACL repair or privileges', () => {
  const source = helperSource();
  const preflight = nsisFunction(source, 'luhengPreflightDirectory');
  assert.match(preflight, /\$installMode != "CurrentUser"/);
  const registryReads = preflight.match(/^\s*ReadRegStr[^\n]+/gm) || [];
  assert.ok(registryReads.length >= 4);
  for (const read of registryReads) {
    assert.match(read, /HK(?:CU|LM) "\$\{(?:INSTALL_REGISTRY_KEY|UNINSTALL_REGISTRY_KEY(?:_2)?)\}" (?:InstallLocation|UninstallString)/);
  }
  assertOrder(preflight, [
    'StrCpy $luidTarget $INSTDIR',
    'Call luhengCheckCanonicalAppPath',
    'Call luhengHoldAncestors',
    'ReadRegStr $luidOldPath HKCU',
    'StrCpy $luidCheckPath $luidOldPath',
    'StrCpy $luidVerifyAcl 0',
    'Call luhengVerifyDirectoryHandle',
    '${If} $luidTarget != $luidOldPath',
    'StrCpy $luidNativeDisposition 2',
    'StrCpy $luidNativeSd $luidCreateSd',
    'Call luhengNativeDirectory',
    '${OrIf} $luidNativeInformation != 2',
    'StrCpy $luidVerifyAcl 1',
    'Call luhengVerifyDirectoryHandle',
    'StrCpy $luidReady 1',
  ]);
  assert.match(preflight, /\$0 != "\$luidOldPath\\\$\{UNINSTALL_FILENAME\}"/);
  assert.match(preflight, /StrCpy \$luidNativeOptions 0x201021/); // Empty probe has DELETE_ON_CLOSE.
  assert.doesNotMatch(source, /::(?:SetSecurityInfo|SetNamedSecurityInfo\w*|SetFileSecurity\w*|AdjustTokenPrivileges|SetTokenInformation)\(/i);
  assert.doesNotMatch(source, /\b(?:WriteReg\w*|DeleteReg\w*|CreateDirectory|RMDir|ExecShell|ExecWait)\b|takeown|icacls|SeTakeOwnershipPrivilege|SeRestorePrivilege/i);
  const accessAssignments = [...source.matchAll(/StrCpy \$luidNativeAccess (0x[0-9a-f]+)/gi)];
  assert.ok(accessAssignments.length > 0);
  for (const [, flags] of accessAssignments) {
    assert.equal(Number.parseInt(flags, 16) & 0xc0000, 0, 'No WRITE_DAC or WRITE_OWNER access is requested');
  }
});

test('the final directory is exclusively new and its owner and identity stay bound through finish', () => {
  const source = helperSource();
  const create = nsisFunction(source, 'luhengCreateDirectory');
  assertOrder(create, [
    '${If} $luidReady != 1',
    '${OrIf} $INSTDIR != $luidTarget',
    'StrCpy $luidNativeDisposition 1',
    'StrCpy $luidNativeSd 0',
    'Call luhengNativeDirectory',
    '${If} $luidNativeStatus != -1073741772',
    'StrCpy $luidNativeDisposition 2',
    'StrCpy $luidNativeSd $luidCreateSd',
    'Call luhengNativeDirectory',
    '${OrIf} $luidNativeInformation != 2',
    'StrCpy $luidOwnedHandle $luidNativeHandle',
    'StrCpy $luidCheckHandle $luidOwnedHandle',
    'StrCpy $luidVerifyAcl 1',
    'Call luhengVerifyDirectoryHandle',
    'StrCpy $luidOwnedIdentity $luidCheckIdentity',
  ]);
  const dispositions = [...source.matchAll(/StrCpy \$luidNativeDisposition (\d+)/g)].map(([, value]) => Number(value));
  assert.ok(dispositions.includes(2)); // FILE_CREATE.
  assert.ok(dispositions.every(value => value === 1 || value === 2), 'Only FILE_OPEN and exclusive FILE_CREATE are used');
  const finish = nsisFunction(source, 'luhengFinishDirectory');
  assertOrder(finish, [
    'StrCpy $luidCheckHandle $luidOwnedHandle',
    'Call luhengVerifyDirectoryHandle',
    '${If} $luidCheckIdentity != $luidOwnedIdentity',
    'kernel32::CreateFileW(w "$INSTDIR"',
    'Call luhengVerifyDirectoryHandle',
    '${AndIf} $luidCheckIdentity != $luidOwnedIdentity',
    'Call luhengCloseDirectoryResources',
  ]);
  assert.match(finish, /CreateFileW\([^\n]+i 3, \$\{SYSTYPE_PTR\} 0, i 3, i 0x02200000/); // Open existing, no delete sharing.
});

test('success, failure and GUI exit close held directory resources', () => {
  const source = helperSource();
  const close = nsisFunction(source, 'luhengCloseDirectoryResources');
  assertOrder(close, ['kernel32::CloseHandle(${SYSTYPE_PTR} $luidOwnedHandle)', 'StrCpy $luidOwnedHandle 0']);
  assert.match(close, /\$luidAncestorHead[\s\S]*kernel32::CloseHandle\(\$\{SYSTYPE_PTR\} r2\)[\s\S]*System::Free \$0/);
  for (const resource of ['luidCreateSd', 'luidSystemSid', 'luidAdminsSid']) {
    assert.ok(close.includes('kernel32::LocalFree(${SYSTYPE_PTR} $' + resource + ')'));
    assert.ok(close.includes('StrCpy $' + resource + ' 0'));
  }
  assert.match(close, /System::Free \$luidTokenData/);
  assert.match(close, /StrCpy \$luidReady 0/);
  assert.match(source, /!ifndef BUILD_UNINSTALLER[\s\S]*?!define MUI_CUSTOMFUNCTION_ABORT luhengDirectoryUserAbort\s+!endif/);
  assert.ok(source.indexOf('!define MUI_CUSTOMFUNCTION_ABORT luhengDirectoryUserAbort') < source.indexOf('!macro customHeader'));
  assert.doesNotMatch(source, /Function \.onUserAbort\b/, 'Modern UI retains its own abort handler');
  for (const callback of ['.onInstFailed', 'luhengDirectoryUserAbort', '.onGUIEnd']) {
    assert.match(nsisFunction(source, callback), /Call luhengCloseDirectoryResources/);
  }
  for (const macro of ['luhengPreflightInstallDirectory', 'luhengCreateInstallDirectory', 'luhengFinishInstallDirectory']) {
    const match = source.match(new RegExp('!macro ' + macro + '\\s+([\\s\\S]*?)!macroend'));
    assert.ok(match);
    assertOrder(match[1], ['${If} $luidError != ""', 'Call luhengCloseDirectoryResources', 'SetErrorLevel 1', 'Abort']);
  }
});
