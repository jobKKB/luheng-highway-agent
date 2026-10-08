# Synthetic subprocesses only; no product installation, user data or policy changes.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'Native Windows required'}
$out=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $out){throw 'Fresh synthetic output directory required'}
New-Item -ItemType Directory -Path $out|Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'RestrictedTokenLauncher.cs')
$pwsh=(Get-Process -Id $PID).Path
$parent=Join-Path $out 'parent.ps1'
$child=Join-Path $out 'child.ps1'
@'
$ErrorActionPreference='Stop'
$start=[Diagnostics.ProcessStartInfo]::new($env:PROBE_PWSH)
$start.UseShellExecute=$false
$start.Arguments='-NoLogo -NoProfile -NonInteractive -File "'+$env:PROBE_CHILD+'"'
$process=[Diagnostics.Process]::Start($start)
$deadline=[DateTime]::UtcNow.AddSeconds(15)
while(-not (Test-Path -LiteralPath $env:PROBE_READY)){
  if($process.HasExited -or [DateTime]::UtcNow -ge $deadline){throw 'Synthetic descendant did not become ready'}
  Start-Sleep -Milliseconds 50
}
exit ([int]$env:PROBE_EXIT)
'@|Set-Content -LiteralPath $parent -Encoding utf8
@'
[IO.File]::WriteAllText($env:PROBE_READY,[string]$PID)
Start-Sleep -Milliseconds ([int]$env:PROBE_WAIT)
[IO.File]::WriteAllText($env:PROBE_FINISHED,'finished')
'@|Set-Content -LiteralPath $child -Encoding utf8
$report=[ordered]@{accepted=$false;scope='synthetic-processes-only';failure_fast_cleanup=$false;success_waited_for_descendant=$false;error=$null;cases=@()}
try{
  foreach($exitCode in @(7,0)){
    $ready=Join-Path $out ('ready-'+$exitCode+'.txt');$finished=Join-Path $out ('finished-'+$exitCode+'.txt')
    $wait=if($exitCode){90000}else{2500}
    $map=@{SystemRoot=$env:SystemRoot;WINDIR=$env:WINDIR;TEMP=$out;TMP=$out;PROBE_PWSH=$pwsh;PROBE_CHILD=$child;PROBE_READY=$ready;PROBE_FINISHED=$finished;PROBE_WAIT=[string]$wait;PROBE_EXIT=[string]$exitCode}
    $pairs=@($map.Keys|ForEach-Object {$_+'='+$map[$_]})
    $clock=[Diagnostics.Stopwatch]::StartNew();$exception=$null
    try{[RestrictedTokenLauncher]::Run($pwsh,('-NoLogo -NoProfile -NonInteractive -File "'+$parent+'"'),$out,[string[]]$pairs,60000)|Out-Null}catch{$exception=$_.Exception.Message}
    $evidence=[RestrictedTokenLauncher]::LastEvidence
    $report.cases+=@{exit=$exitCode;elapsed_ms=$clock.ElapsedMilliseconds;exception=$exception;evidence=$evidence}
    if(-not (Test-Path -LiteralPath $ready)){throw 'Synthetic child was not observed'}
    $childId=[int](Get-Content -LiteralPath $ready -Raw)
    if($exitCode){
      if(-not $exception -or $evidence.Stage -cne 'probe-exit-nonzero' -or $evidence.ExitCode -ne 7 -or
         -not $evidence.ForcedCleanup -or -not $evidence.CleanupTreeFinished -or $evidence.ProcessTreeFinished -or
         $evidence.CleanupError -or $clock.ElapsedMilliseconds -ge 20000 -or
         @($evidence.RemainingBeforeCleanup|Where-Object Pid -eq $childId).Count -ne 1 -or (Test-Path -LiteralPath $finished)){
        throw 'Failed probe did not promptly record and clean its owned descendant'
      }
      $report.failure_fast_cleanup=$true
    }else{
      if($exception -or -not $evidence.ProcessTreeFinished -or $evidence.ForcedCleanup -or -not (Test-Path -LiteralPath $finished)){
        throw 'Successful probe did not wait for normal descendant completion'
      }
      $report.success_waited_for_descendant=$true
    }
  }
  $report.accepted=$true
}catch{$report.error=$_.Exception.Message}finally{
  $report|ConvertTo-Json -Depth 20|Set-Content -LiteralPath (Join-Path $out 'restricted-failure-cleanup-selftest.json') -Encoding utf8
}
if(-not $report.accepted){throw $report.error}
