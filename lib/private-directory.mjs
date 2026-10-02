import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isAbsolute, win32 } from "node:path";

// Windows chmod does not implement owner/group/other access. Use an explicit
// inheritable DACL before creating any artifact, and read it back before writing.
// The caller must own the directory and its ancestors; this is not a sandbox.
// This fixed script never incorporates a filename into executable source.
export const WINDOWS_PRIVATE_DIRECTORY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$directory = [Environment]::GetEnvironmentVariable('LUHENG_PRIVATE_DIRECTORY', 'Process')
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($user.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$security = New-Object System.Security.AccessControl.DirectorySecurity
$security.SetAccessRuleProtection($true, $false)
$security.SetOwner($user)
foreach ($sid in $allowed) {
  $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inheritance, 'None', 'Allow')
  $security.AddAccessRule($rule)
}
if (Test-Path -LiteralPath $directory) {
  $item = Get-Item -LiteralPath $directory -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe artifact directory' }
} else {
  [void][System.IO.Directory]::CreateDirectory($directory, $security)
}
$item = Get-Item -LiteralPath $directory -Force
if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe artifact directory' }
[System.IO.Directory]::SetAccessControl($directory, $security)
$actual = [System.IO.Directory]::GetAccessControl($directory)
if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Artifact ACL was not applied' }
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne $allowed.Count) { throw 'Unexpected artifact ACL' }
foreach ($rule in $rules) {
  if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne 'None') { throw 'Unexpected artifact ACL' }
}
Write-Output 'LUHENG_PRIVATE_DIRECTORY_READY'
`;

export function preparePrivateDirectory(directory, { platform = process.platform, env = process.env, run = spawnSync } = {}) {
  if (typeof directory !== "string" || !(platform === "win32" ? win32.isAbsolute(directory) : isAbsolute(directory))) throw new Error("办公文档目录必须是受信任的绝对路径");
  let stat;
  try { stat = lstatSync(directory); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("办公文档目录不能是符号链接");
  if (platform !== "win32") {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    return;
  }
  const systemRoot = env.SystemRoot || env.WINDIR;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error("无法验证Windows办公文档目录权限；未保存文件");
  const powershell = win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let result;
  try {
    result = run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_PRIVATE_DIRECTORY_SCRIPT], {
      env: { ...env, LUHENG_PRIVATE_DIRECTORY: directory }, encoding: "utf8", windowsHide: true,
      timeout: 15000, maxBuffer: 65536, shell: false,
    });
  } catch {
    throw new Error("无法设置或验证Windows办公文档目录权限；未保存文件");
  }
  if (result.error || result.status !== 0 || result.stdout?.trim() !== "LUHENG_PRIVATE_DIRECTORY_READY") {
    throw new Error("无法设置或验证Windows办公文档目录权限；未保存文件");
  }
}
