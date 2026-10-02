import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { win32 } from "node:path";

// Only used on this test's empty/synthetic temporary tree. Establish both a broad
// inherited ACE and an explicit broad ACE so replacement is actually exercised.
export function makeWindowsAclPermissiveForTest(path) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$directory = $env:LUHENG_TEST_ACL_PATH
$parent = [IO.Path]::GetDirectoryName($directory)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$users = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')
$parentAcl = Get-Acl -LiteralPath $parent
$parentAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'ReadAndExecute', $inheritance, 'None', 'Allow')))
Set-Acl -LiteralPath $parent -AclObject $parentAcl
$acl = Get-Acl -LiteralPath $directory
$acl.SetAccessRuleProtection($false, $true)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($users, 'ReadAndExecute', 'None', 'None', 'Allow')))
Set-Acl -LiteralPath $directory -AclObject $acl
$actual = Get-Acl -LiteralPath $directory
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' -and $_.IsInherited })) { throw 'Missing inherited fixture ACE' }
if (-not ($rules | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-32-545' -and -not $_.IsInherited })) { throw 'Missing explicit fixture ACE' }
`;
  const executable = win32.join(process.env.SystemRoot || process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000, env: { ...process.env, LUHENG_TEST_ACL_PATH: path },
  });
}

// Independent native reader: does not reuse the production ACL construction or
// verification code, and uses numeric SIDs so localized Windows is supported.
export function assertPrivateWindowsAcl(path, { directory = false } = {}) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:LUHENG_TEST_ACL_PATH
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; type = [int]$_.AccessControlType; rights = [int]$_.FileSystemRights; inherited = $_.IsInherited; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
})
@{ owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; tokenOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().Owner.Value; protected = $acl.AreAccessRulesProtected; rules = $rules } | ConvertTo-Json -Compress -Depth 4
`;
  const executable = win32.join(process.env.SystemRoot || process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = JSON.parse(execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000, env: { ...process.env, LUHENG_TEST_ACL_PATH: path },
  }));
  const allowed = new Set([result.user, "S-1-5-18", "S-1-5-32-544"]);
  // An elevated creator's token may assign Administrators as the new file's
  // owner. Directory ownership is explicit; file ownership is token-derived.
  if (directory) assert.equal(result.owner, result.user);
  else {
    assert.equal(result.owner, result.tokenOwner);
    assert.ok(allowed.has(result.owner), "file owner must be a permitted principal");
  }
  assert.equal(result.rules.length, allowed.size);
  assert.deepEqual(new Set(result.rules.map(rule => rule.sid)), allowed);
  for (const rule of result.rules) {
    assert.equal(rule.type, 0, "only allow ACEs are expected");
    assert.equal(rule.rights, 2032127, "full control is limited to the user, SYSTEM and administrators");
    assert.equal(rule.inherited, !directory);
    assert.equal(rule.inheritance, directory ? 3 : 0);
    assert.equal(rule.propagation, 0);
  }
  assert.equal(result.protected, directory);
}
