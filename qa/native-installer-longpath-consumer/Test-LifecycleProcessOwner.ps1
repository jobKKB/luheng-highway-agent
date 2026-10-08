# Native disposable-runner selftest. Results are helper evidence, not installer acceptance.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if (-not $IsWindows -or -not $env:GITHUB_ACTIONS -or -not $env:RUNNER_TEMP) { throw 'Native disposable Actions runner required' }
if (-not ('RestrictedTokenLauncher' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'token-review/RestrictedTokenLauncher.cs') }
if (-not ('LifecycleProcessOwner' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'LifecycleProcessOwner.cs') }
$out=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $out | Out-Null
$state=Join-Path $env:RUNNER_TEMP ('lifecycle-job-selftest-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $state | Out-Null
$pwsh=(Get-Process -Id $PID).Path
if ([IO.Path]::GetFileName($pwsh) -ine 'pwsh.exe') { throw 'PowerShell7 executable required' }
$parentScript=Join-Path $state 'parent.ps1'
$childScript=Join-Path $state 'child.ps1'
@'
$ErrorActionPreference='Stop'
[IO.File]::WriteAllText($env:PROBE_STARTED,'started')
$psi=[Diagnostics.ProcessStartInfo]::new()
$psi.FileName=$env:PROBE_PWSH
$psi.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$env:PROBE_CHILD+'"'
$psi.WorkingDirectory=$env:PROBE_STATE
$psi.UseShellExecute=$false
$child=[Diagnostics.Process]::Start($psi)
$deadline=[DateTime]::UtcNow.AddSeconds(20)
do {
  if (Test-Path -LiteralPath $env:PROBE_READY) { exit 0 }
  if ($child.HasExited) { throw 'Synthetic descendant exited before ready' }
  Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Synthetic descendant did not become ready'
'@ | Set-Content -LiteralPath $parentScript -Encoding utf8
@'
$ErrorActionPreference='Stop'
[IO.File]::WriteAllText($env:PROBE_READY,'ready')
$deadline=[DateTime]::UtcNow.AddSeconds(45)
do {
  if (Test-Path -LiteralPath $env:PROBE_RELEASE) {
    [IO.File]::WriteAllText($env:PROBE_FINISHED,'finished')
    exit 0
  }
  Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Synthetic descendant was not released'
'@ | Set-Content -LiteralPath $childScript -Encoding utf8
$envMap=@{}
foreach ($name in @('SystemRoot','WINDIR','COMSPEC','OS','PATHEXT')) {
  $value=[Environment]::GetEnvironmentVariable($name,'Process')
  if ($null -ne $value) { $envMap[$name]=$value }
}
$envMap['PATH']=@((Join-Path $env:SystemRoot 'System32'),$env:SystemRoot) -join ';'
foreach ($name in @('HOME','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP')) { $envMap[$name]=$state }
$envMap['PROBE_STATE']=$state; $envMap['PROBE_PWSH']=$pwsh; $envMap['PROBE_CHILD']=$childScript
foreach ($name in @('STARTED','READY','RELEASE','FINISHED')) { $envMap['PROBE_'+$name]=Join-Path $state ($name.ToLowerInvariant()+'.txt') }
$pairs=@($envMap.Keys | ForEach-Object { $_+'='+[string]$envMap[$_] })
$result=[ordered]@{schema=1; native_windows=$true; helper_test_only=$true; suspended_gate=$false; same_token=$false; descendant_after_parent_exit=$false; graceful_tree_exit=$false; forced_cleanup=$false; error=$null}
$owner=$null
try {
  $sourceToken=[RestrictedTokenLauncher]::InspectProcessToken($PID)
  $owner=[LifecycleProcessOwner]::StartSuspended($pwsh,('-NoLogo -NoProfile -NonInteractive -File "'+$parentScript+'"'),$state,[string[]]$pairs)
  $token=[RestrictedTokenLauncher]::InspectProcessToken($owner.Process.Id)
  if ($token.UserSid -cne $sourceToken.UserSid -or $token.IntegritySid -cne $sourceToken.IntegritySid -or $token.IsElevated -ne $sourceToken.IsElevated) { throw 'Same-token synthetic child identity differs' }
  $result.same_token=$true; $result.token=$token
  if ((Test-Path -LiteralPath $envMap.PROBE_STARTED) -or $owner.ActiveProcessCount -ne 1 -or $owner.ProcessIds() -notcontains $owner.Process.Id) { throw 'Suspended child ran early or owned membership is missing' }
  $result.suspended_gate=$true
  $owner.Resume()
  if (-not $owner.Process.WaitForExit(30000) -or $owner.Process.ExitCode -ne 0) { throw 'Synthetic parent failed to exit normally' }
  if ($owner.ActiveProcessCount -lt 1 -or $owner.WaitForEmpty(100) -or -not (Test-Path -LiteralPath $envMap.PROBE_READY)) { throw 'Live descendant was lost when its parent exited' }
  $result.descendant_after_parent_exit=$true
  [IO.File]::WriteAllText($envMap.PROBE_RELEASE,'release')
  if (-not $owner.WaitForEmpty(15000) -or -not (Test-Path -LiteralPath $envMap.PROBE_FINISHED)) { throw 'Synthetic descendant failed normal completion' }
  $result.graceful_tree_exit=$true
} catch { $result.error=$_.Exception.Message } finally {
  if ($owner) {
    try {
      if ($owner.ActiveProcessCount -gt 0) { $result.forced_cleanup=$true; $owner.Terminate(); [void]$owner.WaitForEmpty(10000) }
    } catch { $result.cleanup_error=$_.Exception.Message; if (-not $result.error) { $result.error=$_.Exception.Message } }
    $owner.Dispose()
  }
  $result.accepted=$result.suspended_gate -and $result.same_token -and $result.descendant_after_parent_exit -and $result.graceful_tree_exit -and -not $result.forced_cleanup -and -not $result.error
  $result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $out 'lifecycle-process-owner-selftest.json') -Encoding utf8
  $result | ConvertTo-Json -Depth 20 | Write-Output
}
if (-not $result.accepted) { throw 'Native lifecycle process-owner selftest failed' }
