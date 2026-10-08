# Early disposable Windows gate. Controlled timeout/termination here is intentional
# synthetic helper coverage, never acceptance of a forced product lifecycle.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if (-not $IsWindows -or -not $env:GITHUB_ACTIONS -or -not $env:RUNNER_TEMP) { throw 'Native disposable Actions runner required' }
if (-not ('LifecycleProcessOwner' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'LifecycleProcessOwner.cs') }
. (Join-Path $PSScriptRoot 'Observe-InstallerLifecycle.ps1')
$out=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force $out | Out-Null
$state=Join-Path $env:RUNNER_TEMP ('lifecycle-observation-selftest-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $state | Out-Null
$pwsh=(Get-Process -Id $PID).Path
if ([IO.Path]::GetFileName($pwsh) -ine 'pwsh.exe') { throw 'PowerShell7 executable required' }
$parentScript=Join-Path $state 'parent.ps1'; $childScript=Join-Path $state 'child.ps1'
@'
$ErrorActionPreference='Stop'
$psi=[Diagnostics.ProcessStartInfo]::new()
$psi.FileName=$env:PROBE_PWSH
$psi.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$env:PROBE_CHILD+'"'
$psi.WorkingDirectory=$env:PROBE_STATE
$psi.UseShellExecute=$false
$child=[Diagnostics.Process]::Start($psi)
$deadline=[DateTime]::UtcNow.AddSeconds(15)
do {
  if (Test-Path -LiteralPath $env:PROBE_READY) { exit 0 }
  if ($child.HasExited) { throw 'Observation synthetic child exited early' }
  Start-Sleep -Milliseconds 25
} while ([DateTime]::UtcNow -lt $deadline)
throw 'Observation synthetic child did not become ready'
'@ | Set-Content -LiteralPath $parentScript -Encoding utf8
@'
$ErrorActionPreference='Stop'
[IO.File]::WriteAllBytes((Join-Path $env:PROBE_INSTALL 'synthetic-payload.bin'),[byte[]]::new(65536))
[IO.File]::WriteAllText($env:PROBE_READY,'ready')
if ($env:PROBE_MODE -eq 'success') { Start-Sleep -Seconds 8; exit 0 }
Start-Sleep -Seconds 90
throw 'Controlled timeout fixture outlived its expected ownership cleanup'
'@ | Set-Content -LiteralPath $childScript -Encoding utf8
$result=[ordered]@{schema=1;native_windows=$true;helper_test_only=$true;success_observation=$false;short_timeout_observation=$false;timeout_evidence_before_cleanup=$false;controlled_timeout_cleanup=$false;accounting_observed=$false;tree_observed=$false;screenshot_attempt_recorded=$false;accepted=$false;error=$null}
$owner=$null
try {
  foreach ($mode in @('success','timeout')) {
    $case=Join-Path $state $mode; $install=Join-Path $case 'install'; $temp=Join-Path $case 'temp'; $evidence=Join-Path $out $mode
    New-Item -ItemType Directory -Force $case,$install,$temp,$evidence | Out-Null
    $envMap=@{}
    foreach ($name in @('SystemRoot','WINDIR','COMSPEC','OS','PATHEXT')) {
      $value=[Environment]::GetEnvironmentVariable($name,'Process'); if ($null -ne $value) { $envMap[$name]=$value }
    }
    $envMap['PATH']=@((Join-Path $env:SystemRoot 'System32'),$env:SystemRoot) -join ';'
    foreach ($name in @('HOME','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP')) { $envMap[$name]=$temp }
    $envMap['PROBE_STATE']=$case; $envMap['PROBE_PWSH']=$pwsh; $envMap['PROBE_CHILD']=$childScript
    $envMap['PROBE_INSTALL']=$install; $envMap['PROBE_READY']=Join-Path $case 'ready.txt'; $envMap['PROBE_MODE']=$mode
    $pairs=@($envMap.Keys | ForEach-Object { $_+'='+[string]$envMap[$_] })
    $owner=[LifecycleProcessOwner]::StartSuspended($pwsh,('-NoLogo -NoProfile -NonInteractive -File "'+$parentScript+'"'),$case,[string[]]$pairs)
    $initial=$owner.AccountingSnapshot()
    if ($initial.ActiveProcesses -ne 1 -or $initial.TotalProcesses -ne 1) { throw 'Suspended job accounting differs' }
    $owner.Resume()
    # Wait only for fixture readiness and root exit. This deliberately presents
    # the observer with a surviving owned descendant, not a trivially live root.
    if (-not $owner.Process.WaitForExit(20000) -or $owner.Process.ExitCode -ne 0 -or $owner.ActiveProcessCount -lt 1) { throw 'Synthetic root/descendant fixture failed' }
    $limit=if ($mode -eq 'success') { 20 } else { 1 }
    $observed=Wait-OwnedProcessObserved -Process $owner.Process -Owner $owner -Phase installer -TimeoutSeconds $limit -InstallRoot $install -TempRoot $temp -EvidenceDirectory $evidence
    $persisted=Get-Content -LiteralPath (Join-Path $evidence 'installer-wait.json') -Raw | ConvertFrom-Json
    $samples=@(Get-Content -LiteralPath (Join-Path $evidence 'installer-progress.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    if (-not $samples.Count -or $persisted.reason -cne $observed.reason) { throw 'Observation JSON evidence missing or inconsistent' }
    if ($observed.last_sample.job.TotalProcesses -lt 2 -or $observed.last_sample.job.WriteBytes -le 0) { throw 'Actual cumulative owned job CPU/IO accounting was not recorded' }
    $result.accounting_observed=$true
    if ($observed.last_sample.trees.install.Files -ne 1 -or $observed.last_sample.trees.install.Bytes -ne 65536 -or -not $observed.last_sample.trees.install.Complete) { throw 'Synthetic target file/byte progress differs' }
    $result.tree_observed=$true
    if ($mode -eq 'success') {
      if (-not $observed.completed -or $observed.reason -cne 'root-zero-and-owned-job-empty' -or $owner.ActiveProcessCount -ne 0) { throw 'Normal owned descendant completion was not recognized' }
      $result.success_observation=$true
    } else {
      if ($observed.completed -or $observed.reason -cne 'deadline-owned-descendants-active' -or $owner.ActiveProcessCount -lt 1) { throw 'Controlled timeout was misclassified or process was prematurely killed' }
      $result.short_timeout_observation=$true
      if ($null -eq $persisted.failure_images -or $persisted.failure_images.before_owned_cleanup -ne $true) { throw 'No before-cleanup screenshot attempt/evidence record' }
      if (@($persisted.failure_images.images).Count -eq 0 -and @($persisted.failure_images.errors).Count -eq 0) { throw 'Missing screenshot or explicit native-display capture error' }
      $result.screenshot_attempt_recorded=$true; $result.timeout_evidence_before_cleanup=$true
      $owner.Terminate()
      if (-not $owner.WaitForEmpty(10000)) { throw 'Controlled owned fixture cleanup failed' }
      $result.controlled_timeout_cleanup=$true
    }
    $owner.Dispose(); $owner=$null
  }
  $result.accepted=$result.success_observation -and $result.short_timeout_observation -and $result.timeout_evidence_before_cleanup -and $result.controlled_timeout_cleanup -and $result.accounting_observed -and $result.tree_observed -and $result.screenshot_attempt_recorded
} catch { $result.error=$_.Exception.Message }
finally {
  if ($owner) {
    try { if ($owner.ActiveProcessCount -gt 0) { $owner.Terminate(); if (-not $owner.WaitForEmpty(10000)) { throw 'Unexpected synthetic cleanup failure' } } }
    catch { $result['cleanup_error']=$_.Exception.Message; $result.accepted=$false }
    $owner.Dispose()
  }
  $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $out 'lifecycle-observation-selftest.json') -Encoding utf8
  $result | ConvertTo-Json -Depth 10 | Write-Output
}
if (-not $result.accepted -or $result.error) { throw 'Native lifecycle observation selftest failed; do not proceed to payload downloads' }
