[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Node,
  [Parameter(Mandatory)][string]$Source,
  [Parameter(Mandatory)][string]$Prepared,
  [Parameter(Mandatory)][string]$Work,
  [Parameter(Mandatory)][string]$LifecycleConsumer
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable native Windows GitHub Actions runner required' }
$workPath = [IO.Path]::GetFullPath($Work)
$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $workPath.StartsWith($runner,[StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture is outside disposable scratch' }
$policy = Get-ItemPropertyValue -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue
& $Node (Join-Path $PSScriptRoot 'build-native-fixture.mjs') --source $Source --prepared $Prepared --work $workPath
if ($LASTEXITCODE -ne 0) { throw 'Native fixture build failed' }
$receipt = Get-Content -LiteralPath (Join-Path $workPath 'fixture-build.json') -Raw | ConvertFrom-Json
Add-Type -Path (Join-Path $LifecycleConsumer 'LifecycleProcessOwner.cs')
$result = [ordered]@{ schema=1; fixture_only=$true; native_windows=$true; installer_sha256=$receipt.installer_sha256
  installed=$false; all_files_match=$false; normal_uninstall=$false; installed_tree_removed=$false
  registration_removed=$false; sentinel_retained=$false; junction_refused_without_deletion=$false
  forced_cleanup=$false; long_path_policy_unchanged=$false
  max_path_characters=$receipt.max_installed_path_characters; error=$null; processes=@() }
$owners = [Collections.Generic.List[object]]::new()
function Invoke-Owned([string]$Exe,[string]$Arguments,[string]$Label,[int[]]$AllowedExitCodes=@(0)) {
  $envPairs = [string[]]@(Get-ChildItem Env: | ForEach-Object { $_.Name + '=' + $_.Value })
  $owner = [LifecycleProcessOwner]::StartSuspended($Exe,$Arguments,$workPath,$envPairs)
  $owners.Add($owner)
  $owner.Resume()
  $watch = [Diagnostics.Stopwatch]::StartNew()
  if (-not $owner.Process.WaitForExit(300000)) { throw "$Label root did not exit in five minutes" }
  $remaining = [Math]::Max(0,300000 - [int]$watch.ElapsedMilliseconds)
  if (-not $owner.WaitForEmpty($remaining)) { throw "$Label descendants did not finish normally" }
  $result.processes += @{ label=$Label; root_exit_code=$owner.Process.ExitCode; job_empty=($owner.ActiveProcessCount -eq 0) }
  if ($owner.Process.ExitCode -notin $AllowedExitCodes) { throw "$Label exited $($owner.Process.ExitCode)" }
}
function Hash([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  try { return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant() }
  finally { $stream.Dispose() }
}
function Registrations([string]$Install) {
  $uninstallCommandPrefix = '"' + (Join-Path $Install 'Uninstall Nsis Long Path Fixture.exe') + '" '
  $base = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
  if ($null -eq $base) { return @() }
  try {
    return @($base.GetSubKeyNames() | ForEach-Object {
      $key = $base.OpenSubKey($_)
      try {
        # The pinned engine keeps InstallLocation in its separate application
        # key, not this ARP key. Match the exact quoted uninstaller path here.
        $command = [string]$key.GetValue('UninstallString')
        if ($command.StartsWith($uninstallCommandPrefix,[StringComparison]::OrdinalIgnoreCase)) { $_ }
      } finally { $key.Dispose() }
    })
  } finally { $base.Dispose() }
}
$sentinel = Join-Path $workPath 'synthetic-profile-retain.txt'
[IO.File]::WriteAllText($sentinel,'synthetic profile retention sentinel')
$sentinelHash = Hash $sentinel
try {
  if ((Hash $receipt.installer) -cne $receipt.installer_sha256) { throw 'Fixture installer changed' }
  if (Test-Path -LiteralPath $receipt.install) { throw 'Fixture install target already exists' }
  Invoke-Owned $receipt.installer ('/S /currentuser /D=' + $receipt.install) 'install'
  $result.installed=$true
  $extended = '\\?\' + $receipt.install
  $expected = @{}
  foreach ($row in $receipt.expected) { $expected[$row.path] = $row }
  $actual = @{}
  foreach ($file in [IO.Directory]::GetFiles($extended,'*',[IO.SearchOption]::AllDirectories)) {
    $relative = $file.Substring($extended.Length + 1).Replace('\','/')
    $actual[$relative] = @{bytes=([IO.FileInfo]::new($file)).Length;sha256=(Hash $file)}
  }
  # Record the full read-only diagnostic before any membership/hash assertion.
  # This never grants admission: the original exact count/content checks remain.
  $result.installed_inventory=$actual
  $missing=@($expected.Keys | Sort-Object | Where-Object { -not $actual.ContainsKey($_) } | ForEach-Object { $expected[$_] })
  $added=@($actual.Keys | Sort-Object | Where-Object { -not $expected.ContainsKey($_) } | ForEach-Object {
    @{ path=$_; bytes=$actual[$_].bytes; sha256=$actual[$_].sha256 }
  })
  $changed=@($expected.Keys | Sort-Object | Where-Object { $actual.ContainsKey($_) } | ForEach-Object {
    if ($actual[$_].bytes -ne $expected[$_].bytes -or $actual[$_].sha256 -cne $expected[$_].sha256) {
      @{ path=$_; expected=$expected[$_]; actual=$actual[$_] }
    }
  })
  $unexpected=@($added | Where-Object { $_.path -cnotin $receipt.expected_additions })
  $diagnostic=[ordered]@{ schema=1; diagnostic_only=$true; acceptance_claim=$false
    expected_files=$expected.Count; actual_files=$actual.Count
    expected_additions=$receipt.expected_additions; missing=$missing; added=$added
    changed=$changed; unexpected_additions=$unexpected; installed_inventory=$actual }
  $result.inventory_diagnostic=$diagnostic
  $diagnostic | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $workPath 'fixture-inventory.json') -Encoding utf8
  if ($actual.Count -ne $expected.Count + 2) { throw "Unexpected inventory count $($actual.Count)" }
  foreach ($relative in $expected.Keys) {
    if (-not $actual.ContainsKey($relative) -or $actual[$relative].bytes -ne $expected[$relative].bytes -or
        $actual[$relative].sha256 -cne $expected[$relative].sha256) { throw "Missing or changed fixture file: $relative" }
  }
  foreach ($relative in $actual.Keys) {
    if (-not $expected.ContainsKey($relative) -and $relative -cnotin $receipt.expected_additions) { throw "Unexpected installed file: $relative" }
  }
  if ([IO.File]::ReadAllText((Join-Path $extended 'resources/package-type')) -cne 'nsis') { throw 'Wrong stock package-type marker' }
  $result.all_files_match=$true
  $result.files_verified=$expected.Count
  $result.installed_inventory=$actual
  if ((Registrations $receipt.install).Count -ne 1) { throw 'Expected one per-user uninstaller registration' }
  # A synthetic junction must stop uninstall before any owned or external file
  # is removed. Removing this test junction uses non-recursive Directory.Delete.
  $decoy = Join-Path $workPath 'synthetic-userdata-do-not-delete'
  New-Item -ItemType Directory -Path $decoy | Out-Null
  $decoyFile = Join-Path $decoy 'retain.txt'
  [IO.File]::WriteAllText($decoyFile,'Must survive junction refusal and normal uninstall')
  $decoyHash = Hash $decoyFile
  $junction = Join-Path $receipt.install 'synthetic-junction-must-refuse'
  New-Item -ItemType Junction -Path $junction -Target $decoy | Out-Null
  Invoke-Owned (Join-Path $receipt.install 'Uninstall Nsis Long Path Fixture.exe') '/S /currentuser' 'junction-refusal' @(0,2)
  if ((Hash $decoyFile) -cne $decoyHash) { throw 'Junction refusal altered external synthetic userdata' }
  foreach ($row in $receipt.expected) {
    if ((Hash (Join-Path $extended $row.path)) -cne $row.sha256) { throw 'Junction refusal partially deleted installed files' }
  }
  if ((Registrations $receipt.install).Count -ne 1) { throw 'Junction refusal removed registration' }
  $result.junction_refused_without_deletion=$true
  [IO.Directory]::Delete($junction)
  Invoke-Owned (Join-Path $receipt.install 'Uninstall Nsis Long Path Fixture.exe') '/S /currentuser' 'uninstall'
  $result.normal_uninstall=$true
  if ([IO.Directory]::Exists($extended)) { throw 'Normal uninstaller left its installation tree' }
  $result.installed_tree_removed=$true
  if ((Registrations $receipt.install).Count -ne 0) { throw 'Normal uninstaller left registration' }
  $result.registration_removed=$true
  if ((Hash $sentinel) -cne $sentinelHash) { throw 'External sentinel changed' }
  if ((Hash $decoyFile) -cne $decoyHash) { throw 'Normal uninstall altered external synthetic userdata' }
  $result.sentinel_retained=$true
  $after = Get-ItemPropertyValue -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -ErrorAction SilentlyContinue
  if ($after -ne $policy) { throw 'Host long-path policy changed' }
  $result.long_path_policy_unchanged=$true
} catch { $result.error=$_.Exception.Message }
finally {
  foreach ($owner in $owners) {
    if ($owner.ActiveProcessCount -gt 0) { $result.forced_cleanup=$true }
    $owner.Dispose()
  }
  $result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $workPath 'fixture-result.json') -Encoding utf8
}
if ($result.error -or $result.forced_cleanup) { throw ($result.error ?? 'Fixture required forced process cleanup') }
Write-Host 'Tiny native NSIS long-path install/hash/uninstall fixture passed.'
