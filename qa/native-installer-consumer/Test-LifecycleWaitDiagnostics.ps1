# Execute the real wait/checkpoint functions against synthetic native job trees.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
if(-not $IsWindows){throw 'Native Windows required'}
$out=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $out){throw 'Fresh synthetic output directory required'}
New-Item -ItemType Directory -Path $out|Out-Null
$install=Join-Path $out 'synthetic-install';New-Item -ItemType Directory -Path $install|Out-Null
$envMap=@{TEMP=(Join-Path $out 'synthetic-temp')};New-Item -ItemType Directory -Path $envMap.TEMP|Out-Null
[IO.File]::WriteAllText((Join-Path $install 'fixture.txt'),'fixture')
$lifecycleClock=[Diagnostics.Stopwatch]::StartNew()
$owners=[Collections.Generic.Dictionary[int,object]]::new()
Add-Type -Path (Join-Path $PSScriptRoot 'LifecycleProcessOwner.cs')
$parseErrors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Invoke-InstallerLifecycle.ps1'),[ref]$null,[ref]$parseErrors)
if($parseErrors){throw ($parseErrors|Out-String)}
foreach($name in @('Write-LifecycleCheckpoint','Get-BoundedInventory','Get-OwnedDiagnostic','Wait-OwnedProcess')){
  $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$false)
  if(-not $function){throw ('Missing real diagnostic function '+$name)}
  . ([scriptblock]::Create($function.Extent.Text))
}
$pwsh=(Get-Process -Id $PID).Path
$parent=Join-Path $out 'parent.ps1'
@'
$start=[Diagnostics.ProcessStartInfo]::new($env:PROBE_PWSH)
$start.UseShellExecute=$false
$start.Arguments='-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 90"'
[void][Diagnostics.Process]::Start($start)
exit 0
'@|Set-Content -LiteralPath $parent -Encoding utf8
$report=[ordered]@{accepted=$false;scope='synthetic-processes-only';cases=@();error=$null}
try{
  $cases=@(
    @{name='normal';arguments='-NoProfile -NonInteractive -Command "exit 0"';expected=$null;seconds=10},
    @{name='nonzero';arguments='-NoProfile -NonInteractive -Command "exit 7"';expected='Owned child exited nonzero';seconds=10},
    @{name='child-timeout';arguments='-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 90"';expected='owned-child-timeout';seconds=1},
    @{name='job-timeout';arguments=('-NoProfile -NonInteractive -File "'+$parent+'"');expected='owned-job-not-empty-timeout';seconds=3}
  )
  foreach($case in $cases){
    $map=@{SystemRoot=$env:SystemRoot;WINDIR=$env:WINDIR;TEMP=$out;TMP=$out;PROBE_PWSH=$pwsh}
    $pairs=@($map.Keys|ForEach-Object {$_+'='+$map[$_]})
    $owner=[LifecycleProcessOwner]::StartSuspended($pwsh,$case.arguments,$out,[string[]]$pairs)
    $owners.Add($owner.Process.Id,$owner);$owner.Resume();$errorText=$null;$passed=$false
    try{$passed=Wait-OwnedProcess $owner.Process $case.seconds}catch{$errorText=$_.Exception.Message}
    finally{if($owner.ActiveProcessCount){$owner.Terminate();if(-not $owner.WaitForEmpty(5000)){throw 'Synthetic job cleanup failed'}};$owners.Remove($owner.Process.Id)|Out-Null;$owner.Dispose()}
    $report.cases+=@{name=$case.name;error=$errorText;returned_success=$passed}
    if($case.expected){if(-not $errorText -or -not $errorText.StartsWith($case.expected)){throw ('Wrong failure classification for '+$case.name)}}
    elseif(-not $passed -or $errorText){throw 'Normal synthetic process rejected'}
  }
  $checkpoints=@(Get-Content -LiteralPath (Join-Path $out 'lifecycle-checkpoints.jsonl')|ForEach-Object {$_|ConvertFrom-Json})
  foreach($stage in @('owned-child-nonzero','owned-child-timeout','owned-job-not-empty-timeout','owned-tree-finished')){if($stage -notin $checkpoints.stage){throw ('Missing persisted stage '+$stage)}}
  if(-not @($checkpoints|Where-Object {$_.details.install_inventory.files -eq 1 -and $_.details.install_inventory.bytes -eq 7 -and $_.details.install_inventory.complete -and $_.details.temp_inventory.complete}).Count){throw 'Actual bounded fixture inventory absent'}
  $report.accepted=$true
}catch{$report.error=$_.Exception.Message}finally{$report|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $out 'lifecycle-wait-selftest.json') -Encoding utf8}
if(-not $report.accepted){throw $report.error}
