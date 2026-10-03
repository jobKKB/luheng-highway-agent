import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  artifactRoot, constants, controlledPaths, compilerInvocation, markerText,
  parseTrace, requireWindows, sourceContract, validateTrace,
} from '../scripts/fixture.mjs';

const fixture = fs.readFileSync(path.join(artifactRoot, 'fixture.nsi'), 'utf8');
const helper = fs.readFileSync(path.join(artifactRoot, 'helper/current-user-install-directory.nsh'), 'utf8');
const wrapper = fs.readFileSync(path.join(artifactRoot, 'scripts/fixture.mjs'), 'utf8');
const ps = fs.readFileSync(path.join(artifactRoot, 'scripts/preflight.ps1'), 'utf8');
const nonce = '0123456789abcdef0123456789abcdef';
const root = `C:\\Users\\Fixture User\\AppData\\Local\\Temp\\${constants.prefix}${nonce}`;
const owned = controlledPaths(root, nonce, 'C:\\Users\\Fixture User\\AppData\\Local\\Temp');

test('exact mask-fixed helper bytes and untouched entry guards', () => {
  assert.equal(sourceContract().helperSHA256, constants.helperSHA256);
  assert.match(helper, /\$4 <> 0x1004/);
  assert.match(helper, /\$R0 <> 0x1f01ff/);
  assert.match(helper, /\$installMode != "CurrentUser"/);
  assert.match(helper, /\$luidNativeInformation != 2/);
});

test('real direct helper entrypoints occur once in required order', () => {
  const calls = [...fixture.matchAll(/^\s*Call (luhengPreflightDirectory|luhengCreateDirectory|luhengFinishDirectory)$/gm)].map(m => m[1]);
  assert.deepEqual(calls, ['luhengPreflightDirectory', 'luhengCreateDirectory', 'luhengFinishDirectory']);
  assert.match(fixture, /!include "helper\\current-user-install-directory\.nsh"/);
  assert.match(fixture, /!insertmacro customHeader/);
  assert.match(fixture, /Function GetInQuotes/);
  assert.match(fixture, /!define isDeleteAppData '\"\" != \"\"'/);
  assert.ok(fixture.indexOf('!include "helper\\') < fixture.indexOf('!insertmacro MUI_LANGUAGE'));
});

test('helper and MUI own failure/GUI/abort callbacks without duplicates', () => {
  assert.doesNotMatch(fixture, /Function \.(?:onGUIEnd|onInstFailed|onUserAbort)\b/);
  for (const callback of ['.onGUIEnd', '.onInstFailed', 'luhengDirectoryUserAbort']) {
    assert.equal(helper.split(`Function ${callback}`).length - 1, 1);
  }
});

test('front gate checks entire product keys in both hives and both views', () => {
  const macroCalls = [...fixture.matchAll(/!insertmacro FixtureRejectExistingKey (0x8000000[12]) "\$\{(INSTALL_REGISTRY_KEY|UNINSTALL_REGISTRY_KEY)\}" (0x20[12]19)/g)];
  assert.equal(macroCalls.length, 8);
  assert.equal(new Set(macroCalls.map(m => `${m[1]}/${m[2]}/${m[3]}`)).size, 8);
  assert.match(fixture, /RegOpenKeyExW/);
  assert.match(fixture, /\$1 != 2/);
  const init = fixture.slice(fixture.indexOf('Function .onInit'), fixture.indexOf('Section "Actual helper flow"'));
  assert.ok(init.indexOf('Call FixtureRegistryGate') < init.indexOf('Call FixturePathAndMarkerGate'));
  assert.match(ps, /RegistryHive\]::CurrentUser/);
  assert.match(ps, /RegistryHive\]::LocalMachine/);
  assert.match(ps, /RegistryView\]::Registry32/);
  assert.match(ps, /RegistryView\]::Registry64/);
});

test('no payload/uninstaller, product records, child process, recursive or ACL mutation in fixture', () => {
  assert.equal(sourceContract().windowsRuntimeExecuted, false);
  assert.doesNotMatch(fixture, /^\s*(?:Exec|ExecWait|ExecShell|File|CreateDirectory|RMDir|Delete|WriteUninstaller|WriteReg\w*|DeleteReg\w*)\b/im);
  assert.doesNotMatch(fixture, /AdjustTokenPrivileges|SetSecurityInfo|SetNamedSecurityInfo/);
  assert.match(fixture, /RequestExecutionLevel user/);
  assert.match(fixture, /GetTokenInformation\(p r1, i 20/);
  assert.match(fixture, /GetTokenInformation\(p r1, i 18/);
});

test('strict nonce and exact existing TEMP ROOT binding reject arbitrary targets', () => {
  assert.equal(owned.target, `${root}\\parent\\Luheng Office Agent`);
  for (const candidate of ['C:\\Windows', root + '\\..', root + '\\', '\\\\server\\share']) {
    assert.throws(() => controlledPaths(candidate, nonce, 'C:\\Users\\Fixture User\\AppData\\Local\\Temp'));
  }
  for (const value of [nonce.toUpperCase(), nonce.slice(1), nonce + 'a', '../bad']) {
    assert.throws(() => controlledPaths(root, value, 'C:\\Users\\Fixture User\\AppData\\Local\\Temp'));
  }
  assert.match(fixture, /Expected exactly \/S \/ROOT=\.\.\. \/NONCE=\.\.\./);
  assert.match(fixture, /Unknown argument/);
  assert.match(fixture, /Fixed APP leaf already exists/);
});

test('ownership marker has fixed identity/source/path data and cannot inject lines', () => {
  const text = markerText(owned);
  for (const value of [constants.guid, constants.leaf, constants.helperSHA256, owned.target]) assert.ok(text.includes(value));
  assert.throws(() => markerText({ ...owned, root: root + '\nmalicious=1' }));
  assert.match(fixture, /FixtureMarker helper_sha256/);
  assert.match(ps, /Duplicate marker key/);
});

test('cleanup requires newly created file identity and uses only relative native handle deletion', () => {
  const cleanup = fixture.slice(fixture.indexOf('Function FixtureCleanupCreatedEmptyDirectory'), fixture.indexOf('Function FixtureCloseOwnedHandles'));
  assert.match(cleanup, /\$fixtureCreatedIdentity == ""/);
  assert.match(cleanup, /StrCpy \$luidNativeRoot \$fixtureParentHandle/);
  assert.match(cleanup, /StrCpy \$luidNativeDisposition 1/);
  assert.match(cleanup, /\$fixtureCheckIdentity != \$fixtureCreatedIdentity/);
  assert.match(cleanup, /\$6 <> 0x10/);
  assert.match(cleanup, /SetFileInformationByHandle\(p \$luidNativeHandle, i 4/);
  assert.doesNotMatch(cleanup, /RMDir|Delete /);
});

test('evidence comes from globals and actual owner/DACL readback outside plugin extraction', () => {
  for (const field of ['luidError', 'nativeStatus', 'nativeInformation', 'nativeHandle', 'checkIdentity', 'currentSID', 'ownerSID', 'daclControl', 'aceCount', 'sddl']) {
    assert.ok(fixture.includes(`${field}=$`));
  }
  assert.match(fixture, /StrCpy \$fixtureEvidence "\$fixtureRoot\\evidence"/);
  assert.doesNotMatch(fixture, /\$PLUGINSDIR/);
  assert.match(fixture, /globalSemantics=post-return-snapshot/);
  assert.match(fixture, /GetSecurityInfo\(p \$luidOwnedHandle/);
  assert.match(fixture, /ConvertSecurityDescriptorToStringSecurityDescriptorW/);
});

test('compiler wrapper can invoke only installed makensis and never the generated installer', () => {
  const invocation = compilerInvocation('C:\\Program Files (x86)\\NSIS\\makensis.exe');
  assert.deepEqual(invocation.args, ['/V3', 'fixture.nsi']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.cwd, artifactRoot);
  assert.throws(() => compilerInvocation('fixture.exe'));
  assert.throws(() => compilerInvocation('C:\\Temp\\fixture.exe'));
  assert.doesNotMatch(wrapper, /spawnSync\([^\n]*(?:data\.executable|fixture\.exe|executable,)/);
  assert.match(wrapper, /There is no run command/);
  assert.doesNotMatch(wrapper, /ExecutionPolicy|Bypass/);
});

test('actual Windows gate never accepts simulated platform success', () => {
  if (process.platform !== 'win32') assert.throws(() => requireWindows(), /actual Windows/);
  assert.match(wrapper, /process\.platform !== 'win32'/);
  assert.match(wrapper, /process\.env\.GITHUB_ACTIONS !== 'true'/);
  assert.match(wrapper, /process\.env\.RUNNER_OS !== 'Windows'/);
});

function traceFixture() {
  const meta = { nonce, root, target: owned.target, helperSHA256: constants.helperSHA256, appGUID: constants.guid, appLeaf: constants.leaf };
  const snapshot = { luidError: '', nativeStatus: '0', nativeInformation: '2', nativeHandle: '0', checkIdentity: '1/2/3',
    ownedIdentity: '1/2/3', ownedHandle: '0', ready: '0', currentSID: 'S-1-5-21-100', ownerSID: 'S-1-5-21-100', aceCount: '3', daclControl: '4100', sddl: 'O:S-1-5-21-100D:P' };
  const data = { meta };
  for (const stage of ['preflight_enter', 'preflight_exit', 'create_enter', 'create_exit', 'finish_enter', 'finish_exit', 'flow_final']) data[stage] = { ...snapshot };
  data.result = { outcome: 'helper-flow-succeeded', cleanup: 'removed-known-empty-directory-by-handle', createdIdentity: '1/2/3' };
  return data;
}

test('pure-data UTF-16 evidence parser round-trips diagnostics', () => {
  const data = traceFixture();
  const ini = Object.entries(data).map(([section, values]) => `[${section}]\r\n${Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\r\n')}\r\n`).join('\r\n');
  const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ini, 'utf16le')]);
  assert.equal(validateTrace(parseTrace(bytes), owned).helperFlowSucceeded, true);
  assert.throws(() => parseTrace(Buffer.from('[meta]\n')), /UTF-16LE/);
});

test('report refuses success with missing real created/owner/identity/closed evidence', () => {
  for (const mutate of [
    d => { delete d.finish_exit; },
    d => { d.create_exit.nativeInformation = '1'; },
    d => { d.create_exit.ownerSID = 'S-1-5-18'; },
    d => { d.finish_exit.checkIdentity = '9/9/9'; },
    d => { d.finish_exit.ownedHandle = '100'; },
    d => { d.preflight_exit.luidError = 'actual helper failure'; },
    d => { d.meta.helperSHA256 = 'wrong'; },
  ]) {
    const data = traceFixture(); mutate(data);
    assert.throws(() => validateTrace(data, owned));
  }
});

test('failure trace remains a failure and does not manufacture later stages', () => {
  const data = traceFixture();
  data.preflight_exit.luidError = '新目录创建检查失败';
  for (const key of ['create_enter', 'create_exit', 'finish_enter', 'finish_exit']) delete data[key];
  data.result.outcome = 'preflight-failed';
  assert.equal(validateTrace(data, owned).helperFlowSucceeded, false);
  assert.equal(Object.hasOwn(data, 'create_exit'), false);
});

test('TokenUser probe compares ignored original output against initialized correct destination', () => {
  const token = /Function FixtureProbeTokenUserSizing([\s\S]*?)FunctionEnd/.exec(fixture)[1];
  assert.match(token, /OpenProcessToken\(p r0, i 0x8, \*p 0 r1\)/);
  assert.match(token, /GetTokenInformation\(p r1, i 1, p 0, i 0, \*i 0 \.r3\) i \.r2 \?e/);
  assert.match(token, /GetTokenInformation\(p r1, i 1, p 0, i 0, \*i 0 r3\) i \.r2 \?e/);
  assert.match(token, /Pop \$fixtureOriginalSizingError/);
  assert.match(token, /Pop \$fixtureTokenSizingError/);
  assert.match(token, /GetTokenInformation\(p r1, i 1, p r4, i r3, \*i 0 r5\)/);
  assert.match(token, /System::Free \$4/);
  assert.match(token, /CloseHandle\(p r1\)/);
  const outsideProbe = fixture.replace(/Function FixtureProbeTokenUserSizing[\s\S]*?FunctionEnd/, '');
  assert.doesNotMatch(outsideProbe, /\*(?:p|i) 0 \.r\d+/);
});
