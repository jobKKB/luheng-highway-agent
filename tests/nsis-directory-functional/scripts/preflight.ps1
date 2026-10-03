# Read-only Windows preflight. This script never runs the fixture or changes ACLs.
[CmdletBinding()]
param(
  [string]$Root,
  [string]$Nonce,
  [switch]$RegistryOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Write-JsonData($Value) {
  # Emit UTF-8 directly to the pipe without changing console/OS settings.
  $json = $Value | ConvertTo-Json -Depth 6 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json + "`n")
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
$appGuid = '20be089a-e364-59fe-9bf1-70ea22b78d3f'
$appLeaf = 'Luheng Office Agent'
$helperHash = 'b7190fdd950c88c94d421d33d60a3cc344f1a64b16c1c3ad6dcd6bda3afc9f2f'
$keys = @("Software\$appGuid", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$appGuid")
$registryChecks = @()
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
    try {
      foreach ($keyPath in $keys) {
        $key = $base.OpenSubKey($keyPath, $false)
        if ($null -ne $key) {
          $key.Dispose()
          throw "Refusing fixture: product registry key exists in $hive/$view/$keyPath"
        }
        $registryChecks += [ordered]@{ hive = "$hive"; view = "$view"; key = $keyPath; present = $false }
      }
    } finally { $base.Dispose() }
  }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  $status = [ordered]@{
    platform = 'win32'
    is64BitOperatingSystem = [Environment]::Is64BitOperatingSystem
    currentSID = $identity.User.Value
    currentTokenAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    registryChecks = $registryChecks
  }
} finally { $identity.Dispose() }
if ($RegistryOnly) {
  Write-JsonData $status
  exit 0
}
if ($Nonce -cnotmatch '^[0-9a-f]{32}$') { throw 'Invalid fixed nonce' }
$tempPath = [IO.Path]::GetTempPath().TrimEnd('\')
$expectedRoot = [IO.Path]::Combine($tempPath, "luheng-nsis-functional-$Nonce")
if (-not [string]::Equals($Root, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'ROOT is not the exact nonce directory under this process TEMP'
}
if (-not [string]::Equals([IO.Path]::GetFullPath($Root), $Root, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'ROOT is not canonical'
}
if ($Root -notmatch '^[A-Za-z]:\\') { throw 'ROOT must be an absolute local drive path' }
$drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($Root))
if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'ROOT must be on a fixed local drive' }
$parent = [IO.Path]::Combine($Root, 'parent')
$evidence = [IO.Path]::Combine($Root, 'evidence')
$target = [IO.Path]::Combine($parent, $appLeaf)
$marker = [IO.Path]::Combine($Root, 'ownership.ini')
# Check every ancestor with literal path handling, including the temp parents.
$cursor = $parent
while ($cursor) {
  $item = Get-Item -LiteralPath $cursor -Force
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "Existing parent ancestry is not an ordinary directory: $cursor"
  }
  $next = [IO.Directory]::GetParent($cursor)
  if ($null -eq $next) { break }
  $cursor = $next.FullName
}
foreach ($directory in @($Root, $parent, $evidence)) {
  $item = Get-Item -LiteralPath $directory -Force
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw 'Controlled directory must already exist and cannot be a reparse point'
  }
}
$markerItem = Get-Item -LiteralPath $marker -Force
if ($markerItem.PSIsContainer -or (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
  throw 'Ownership marker must be an ordinary file'
}
$markerData = @{}
$section = ''
foreach ($line in [IO.File]::ReadAllLines($marker)) {
  if ($line -eq '[fixture]') { $section = 'fixture'; continue }
  if ($line -eq '') { continue }
  if ($section -ne 'fixture' -or $line -notmatch '^([a-z_0-9]+)=(.*)$') { throw 'Unexpected marker data' }
  $key = $Matches[1]
  if ($markerData.ContainsKey($key)) { throw 'Duplicate marker key' }
  $markerData[$key] = $Matches[2]
}
$expected = [ordered]@{
  schema = '1'; nonce = $Nonce; app_guid = $appGuid; app_leaf = $appLeaf
  helper_sha256 = $helperHash; root = $Root; parent = $parent; target = $target; evidence = $evidence
}
if ($markerData.Count -ne $expected.Count) { throw 'Unexpected marker fields' }
foreach ($key in $expected.Keys) {
  if (-not $markerData.ContainsKey($key) -or $markerData[$key] -cne $expected[$key]) {
    throw "Ownership marker mismatch: $key"
  }
}
if (Test-Path -LiteralPath $target) { throw 'Fixed APP leaf already exists; cannot adopt it' }
if (@(Get-ChildItem -LiteralPath $parent -Force).Count -ne 0) { throw 'Owned parent must be empty before the fixture' }
if (@(Get-ChildItem -LiteralPath $evidence -Force).Count -ne 0) { throw 'Owned evidence folder must be empty before the fixture' }
$status.root = $Root
$status.parent = $parent
$status.target = $target
$status.evidence = $evidence
$status.helperSHA256 = $helperHash
$status.directorySecurity = @()
foreach ($directory in @($Root, $parent, $evidence)) {
  $acl = Get-Acl -LiteralPath $directory
  $status.directorySecurity += [ordered]@{ path = $directory; owner = $acl.Owner; sddl = $acl.Sddl }
}
Write-JsonData $status
