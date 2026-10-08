# Proposal only. Dot-source after the ownership helper. All observations are diagnostic,
# never byte verification, graceful-exit proof, token proof, or installer acceptance.
if (-not ('LifecycleObservation' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'LifecycleObservation.cs') }

function Save-LifecycleFailureImages($Windows,[string]$EvidenceDirectory,[string]$Phase) {
  $images=@(); $errors=@()
  try {
    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Windows.Forms
    # This fallback is deliberately limited to the existing disposable-runner guard.
    # The whole native desktop can reveal a dialog even when the silent root has no window.
    if (-not $IsWindows -or -not $env:GITHUB_ACTIONS -or -not $env:RUNNER_TEMP) { throw 'Disposable native runner only' }
    $screen=[Windows.Forms.SystemInformation]::VirtualScreen
    $areas=@([pscustomobject]@{name='desktop';left=$screen.Left;top=$screen.Top;width=$screen.Width;height=$screen.Height})
    $index=0
    foreach ($window in @($Windows | Where-Object Visible)) {
      if ($index -ge 8) { break }
      $areas += [pscustomobject]@{name=('owned-window-'+$index);left=$window.Left;top=$window.Top;width=($window.Right-$window.Left);height=($window.Bottom-$window.Top)}
      $index++
    }
    foreach ($area in $areas) {
      $bitmap=$null; $graphics=$null
      try {
        if ($area.width -le 0 -or $area.height -le 0 -or ([long]$area.width*$area.height) -gt 64000000) { throw 'Invalid or excessive screenshot bounds' }
        $bitmap=[Drawing.Bitmap]::new($area.width,$area.height)
        $graphics=[Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($area.left,$area.top,0,0,[Drawing.Size]::new($area.width,$area.height))
        $name=$Phase+'-failure-'+$area.name+'.png'
        $bitmap.Save((Join-Path $EvidenceDirectory $name),[Drawing.Imaging.ImageFormat]::Png)
        $images += $name
      } catch { $errors += ($area.name+': '+$_.Exception.Message) }
      finally { if ($graphics) { $graphics.Dispose() }; if ($bitmap) { $bitmap.Dispose() } }
    }
  } catch { $errors += $_.Exception.Message }
  return [pscustomobject]@{images=$images;errors=$errors;before_owned_cleanup=$true}
}

function Wait-OwnedProcessObserved {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)]$Process,
    [Parameter(Mandatory)]$Owner,
    [Parameter(Mandatory)][ValidateSet('installer','uninstaller')][string]$Phase,
    [Parameter(Mandatory)][ValidateRange(1,3600)][int]$TimeoutSeconds,
    [Parameter(Mandatory)][string]$InstallRoot,
    [Parameter(Mandatory)][string]$TempRoot,
    [Parameter(Mandatory)][string]$EvidenceDirectory
  )
  $watch=[Diagnostics.Stopwatch]::StartNew(); $nextSample=0; $nextTree=0
  $log=Join-Path $EvidenceDirectory ($Phase+'-progress.jsonl')
  $summaryPath=Join-Path $EvidenceDirectory ($Phase+'-wait.json')
  $lastWindows=@(); $lastTrees=$null; $snapshotErrors=@()
  $outcome=[ordered]@{phase=$Phase;timeout_seconds=$TimeoutSeconds;completed=$false;reason=$null;root_pid=$Process.Id;root_exited=$false;root_exit_code=$null;owned_active_processes=$null;elapsed_seconds=0;last_sample=$null;failure_images=$null;observation_errors=@()}
  try {
    while ($true) {
      $rootExited=$Process.HasExited
      $rootCode=if ($rootExited) { $Process.ExitCode } else { $null }
      $accounting=$Owner.AccountingSnapshot()
      $active=$accounting.ActiveProcesses
      $done=$rootExited -and $rootCode -eq 0 -and $active -eq 0
      $failed=$rootExited -and $rootCode -ne 0
      $timedOut=$watch.Elapsed.TotalSeconds -ge $TimeoutSeconds
      if ($watch.Elapsed.TotalSeconds -ge $nextSample -or $done -or $failed -or $timedOut) {
        $ids=@($Owner.ProcessIds()); $processes=@(); $sampleErrors=@()
        try {
          # Per-process CPU/IO supplement monotonic native job accounting. This is a
          # best-effort membership snapshot, not the authority for exit/cleanup.
          if ($ids.Count) {
            $processes=@(Get-CimInstance Win32_Process -OperationTimeoutSec 5 -Property ProcessId,ParentProcessId,Name,CreationDate,KernelModeTime,UserModeTime,ReadOperationCount,WriteOperationCount,ReadTransferCount,WriteTransferCount,WorkingSetSize |
              Where-Object { [int]$_.ProcessId -in $ids } | ForEach-Object {
                [ordered]@{pid=$_.ProcessId;parent_pid=$_.ParentProcessId;name=$_.Name;created=$_.CreationDate;cpu_seconds=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000;read_operations=$_.ReadOperationCount;write_operations=$_.WriteOperationCount;read_bytes=$_.ReadTransferCount;write_bytes=$_.WriteTransferCount;working_set_bytes=$_.WorkingSetSize}
              })
          }
        } catch { $sampleErrors += ('process-snapshot: '+$_.Exception.Message) }
        try { $lastWindows=@([LifecycleObservation]::ReadWindows([int[]]$ids)) }
        catch { $lastWindows=@(); $sampleErrors += ('window-snapshot: '+$_.Exception.Message) }
        if ($watch.Elapsed.TotalSeconds -ge $nextTree -or $done -or $failed -or $timedOut) {
          # Never hash/rewrite the live tree, follow reparse points or pretend this
          # non-atomic progress view is a membership/integrity check.
          try {
            $lastTrees=[ordered]@{observed_at_seconds=$watch.Elapsed.TotalSeconds;install=[LifecycleObservation]::ReadTree($InstallRoot,5000);temp=[LifecycleObservation]::ReadTree($TempRoot,5000)}
          } catch { $sampleErrors += ('tree-snapshot: '+$_.Exception.Message) }
          $nextTree=$watch.Elapsed.TotalSeconds+60
        }
        $freeBytes=$null
        try { $freeBytes=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($InstallRoot)).AvailableFreeSpace }
        catch { $sampleErrors += ('disk-snapshot: '+$_.Exception.Message) }
        $sample=[ordered]@{utc=[DateTime]::UtcNow.ToString('o');elapsed_seconds=[Math]::Round($watch.Elapsed.TotalSeconds,3);root_exited=$rootExited;root_exit_code=$rootCode;job=$accounting;processes=$processes;windows=$lastWindows;trees=$lastTrees;install_volume_free_bytes=$freeBytes;observation_errors=$sampleErrors}
        $sample | ConvertTo-Json -Depth 15 -Compress | Add-Content -LiteralPath $log -Encoding utf8
        $outcome.last_sample=$sample
        Write-Host ("{0}: elapsed={1}s rootExited={2} rootExitCode={3} ownedActive={4} jobCpu={5}s jobRead={6} jobWritten={7}" -f $Phase,[Math]::Round($watch.Elapsed.TotalSeconds),$rootExited,$rootCode,$active,[Math]::Round($accounting.CpuSeconds,2),$accounting.ReadBytes,$accounting.WriteBytes)
        $visibleTitles=@($lastWindows | Where-Object Visible | ForEach-Object { $_.Title })
        Write-Host ('Owned visible window titles: '+($visibleTitles | ConvertTo-Json -Compress))
        if ($lastTrees) { Write-Host ("Tree progress (non-atomic): installFiles={0} installBytes={1} tempFiles={2} tempBytes={3}" -f $lastTrees.install.Files,$lastTrees.install.Bytes,$lastTrees.temp.Files,$lastTrees.temp.Bytes) }
        $nextSample=$watch.Elapsed.TotalSeconds+15
      }
      $outcome.root_exited=$rootExited; $outcome.root_exit_code=$rootCode; $outcome.owned_active_processes=$active
      if ($done) { $outcome.completed=$true; $outcome.reason='root-zero-and-owned-job-empty'; break }
      if ($failed) { $outcome.reason='root-nonzero'; break }
      if ($timedOut) { $outcome.reason=if ($rootExited) { 'deadline-owned-descendants-active' } else { 'deadline-root-still-active' }; break }
      Start-Sleep -Milliseconds 500
    }
  } catch { $outcome.reason='observation-or-owner-query-failed'; $snapshotErrors += $_.Exception.Message }
  finally {
    if (-not $outcome.completed) { $outcome.failure_images=Save-LifecycleFailureImages $lastWindows $EvidenceDirectory $Phase }
    $outcome.elapsed_seconds=$watch.Elapsed.TotalSeconds; $outcome.observation_errors=$snapshotErrors
    $outcome | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $summaryPath -Encoding utf8
  }
  return [pscustomobject]$outcome
}
