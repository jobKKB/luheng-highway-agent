# Disposable GitHub-hosted Windows acceptance of two exact owned preview builds.
# Baseline is installed from verified CI artifact bytes. The upgrade itself uses
# the application's real public Release download, Internet MOTW and normal Shell.
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$SourceRoot,
  [Parameter(Mandatory=$true)][string]$PairLock,
  [Parameter(Mandatory=$true)][string]$BaselineInstaller,
  [Parameter(Mandatory=$true)][string]$TargetInstaller,
  [Parameter(Mandatory=$true)][string]$EvidenceDirectory
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if(-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Disposable GitHub-hosted Windows runner required'}
if(-not $env:RUNNER_TEMP -or -not $env:APPDATA){throw 'Actual runner paths required'}
$SourceRoot=(Resolve-Path -LiteralPath $SourceRoot).Path
$EvidenceDirectory=[IO.Path]::GetFullPath($EvidenceDirectory)
if(Test-Path -LiteralPath $EvidenceDirectory){throw 'Evidence directory already exists'}
[void](New-Item -ItemType Directory -Path $EvidenceDirectory)
$pair=Get-Content -LiteralPath $PairLock -Raw | ConvertFrom-Json
if($pair.schema -ne 1 -or $pair.repository.id -ne 1400818714 -or $pair.repository.fullName -cne 'jobKKB/luheng-highway-agent' -or $pair.repository.ownerId -ne 137971851 -or $pair.repository.ownerLogin -cne 'jobKKB'){throw 'Wrong fixed repository'}
if($pair.from.version -cne '0.6.0-beta.1' -or $pair.to.version -cne '0.6.0-beta.2'){throw 'Exact beta pair required'}
$marker=[Guid]::NewGuid().ToString('N')
$work=Join-Path $env:RUNNER_TEMP ('luheng-beta-update-'+$marker)
[void](New-Item -ItemType Directory -Path $work)
$install=Join-Path $work 'Luheng Office Agent'
$appExe=Join-Path $install 'Luheng Office Agent.exe'
$data=Join-Path $env:APPDATA 'LuhengOfficeAgent'
$productKey='HKCU:\Software\20be089a-e364-59fe-9bf1-70ea22b78d3f'
$machineKey='HKLM:\Software\20be089a-e364-59fe-9bf1-70ea22b78d3f'
$node=Join-Path $env:RUNNER_TOOL_CACHE 'node/24.21.0/x64/node.exe'
$owned=[Collections.Generic.List[Diagnostics.Process]]::new()
$createdProfile=$false
$report=[ordered]@{schema=1;status='failed';actualWindows=$true;sourceCommit=$env:GITHUB_SHA;installerExecuted=$false;upgradePassed=$false;stages=[ordered]@{};cleanupErrors=@();limits=@('Unsigned build; OS warnings are never bypassed','Current user is the actual GitHub-hosted runner account; consumer standard-user/SmartScreen reputation remain unproven','Baseline/reinstall are silent from verified owned CI artifact bytes; beta upgrade is visible real Shell/MOTW','Visible NSIS automatic app launch is unchecked by ordinary finish-page choice; first Beta2 startup is observed by the driver')}
function Hash([string]$path){return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
function Start-Owned([string]$file,[string[]]$arguments,[string]$raw=''){
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$file;$info.UseShellExecute=$false;$info.WorkingDirectory=$work
 if($raw){$info.Arguments=$raw}else{foreach($a in $arguments){$info.ArgumentList.Add($a)}}
 foreach($key in @('ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','HIGHWAY_DESKTOP_DATA_DIR','HIGHWAY_CHROMIUM_PATH','CHROME_EXECUTABLE','CHROMIUM_PATH','ELECTRON_DISABLE_SANDBOX')){[void]$info.Environment.Remove($key)}
 $info.Environment['PSModulePath']=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
 $p=[Diagnostics.Process]::Start($info);$owned.Add($p);return $p
}
function Wait-Owned([Diagnostics.Process]$p,[int]$seconds){if(-not $p.WaitForExit($seconds*1000)){throw 'Owned process timed out'};if($p.ExitCode -ne 0){throw ('Owned process failed: '+$p.ExitCode)}}
function Describe-Owned([Diagnostics.Process]$p){
 $p.Refresh();$result=[ordered]@{pid=$p.Id;hasExited=$p.HasExited}
 if(-not $p.HasExited){$result.startUtc=$p.StartTime.ToUniversalTime().ToString('o');$result.image=$p.MainModule.FileName;$result.title=$p.MainWindowTitle;$result.windowHandle=$p.MainWindowHandle.ToInt64();$result.sessionId=$p.SessionId}
 return $result
}
function Wait-ActualBaselineUi([Diagnostics.Process]$p){
 Add-Type -AssemblyName UIAutomationClient
 Add-Type -AssemblyName UIAutomationTypes
 $deadline=[DateTime]::UtcNow.AddSeconds(60);$names=@()
 do{
  $p.Refresh();if($p.HasExited){throw 'Baseline exited before real renderer readiness'}
  $window=[System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
  $controls=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $names=@();foreach($control in $controls){$name=$control.Current.Name;if($name -and $names.Count -lt 300){$names+=$name}}
  $text=$names -join "`n"
  if($text.Contains('新建对话') -and $text.Contains('智能对话') -and $text.Contains('设置')){
   $report.stages.baselineRendererReady=@{process=(Describe-Owned $p);observedNames=$names};return
  }
  Start-Sleep -Milliseconds 200
 }while([DateTime]::UtcNow -lt $deadline)
 $report.stages.baselineRendererDiagnostic=@{process=(Describe-Owned $p);observedNames=$names}
 throw 'Real Beta1 accessibility tree did not expose its actual chat and settings UI'
}
function Run-Driver([string]$phase){
 $p=Start-Owned $node @((Join-Path $PSScriptRoot 'verify-native-beta-updater.mjs'),'--source-root',$SourceRoot,'--lock',(Join-Path $EvidenceDirectory 'runtime-lock.json'),'--phase',$phase,'--output-dir',$EvidenceDirectory)
 Wait-Owned $p 900
 $result=Get-Content -LiteralPath (Join-Path $EvidenceDirectory ('native-beta-'+$phase+'.json')) -Raw | ConvertFrom-Json
 if($result.cleanupErrors.Count){throw 'Driver cleanup failed'}
 return $result
}
function Uninstall-Owned {
 $file=Join-Path $install 'Uninstall Luheng Office Agent.exe';if(-not(Test-Path -LiteralPath $file)){throw 'Owned uninstaller absent'}
 $copy=Join-Path $work ('uninstaller-'+[Guid]::NewGuid().ToString('N')+'.exe');Copy-Item -LiteralPath $file -Destination $copy
 if((Hash $file) -ne (Hash $copy)){throw 'Uninstaller copy mismatch'}
 $p=Start-Owned $copy @() ("/S /currentuser _?=$install");Wait-Owned $p 180
 if(Test-Path -LiteralPath $appExe){throw 'Uninstall left app executable'}
 if(Test-Path -LiteralPath (Join-Path $install 'resources')){throw 'Uninstall left resources'}
}
try{
 if(Test-Path -LiteralPath $data){throw 'Existing profile must not be overwritten'}
 if(Test-Path -LiteralPath $productKey){throw 'Existing current-user product installation'}
 if(Test-Path -LiteralPath $machineKey){throw 'Machine product installation unsupported'}
 if((& $node --version).Trim() -ne 'v24.21.0'){throw 'Exact build Node required'}
 foreach($entry in @(@{path=$BaselineInstaller;lock=$pair.from},@{path=$TargetInstaller;lock=$pair.to})){
  $item=Get-Item -LiteralPath $entry.path
  if($item.Length -ne $entry.lock.bytes -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint -or (Hash $entry.path) -ne $entry.lock.sha256){throw 'Exact owned CI installer binding failed'}
 }
 $report.stages.artifactBindings='passed'
 # Exact original smoke installation path/arguments; no unexpected OS prompt is dismissed.
 $p=Start-Owned $BaselineInstaller @() ("/S /currentuser /D=$install");Wait-Owned $p 240
 if(-not(Test-Path -LiteralPath $appExe)){throw 'Baseline did not install'}
 if((Get-ItemProperty -LiteralPath $productKey).InstallLocation -ine $install){throw 'Actual HKCU install location mismatch'}
 if(Test-Path -LiteralPath $machineKey){throw 'Unexpected machine product installation'}
 $report.stages.baselineInstall='passed'
 $pair | Add-Member -NotePropertyName installedExecutable -NotePropertyValue $appExe -Force
 $pair | Add-Member -NotePropertyName stateRoot -NotePropertyValue $data -Force
 $pair | Add-Member -NotePropertyName runMarker -NotePropertyValue $marker -Force
 $pair | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'runtime-lock.json') -Encoding utf8
 # Plain first launch lets the real app create its own default private profile.
 $ui=Start-Owned $appExe @();$deadline=[DateTime]::UtcNow.AddSeconds(60)
 do{$ui.Refresh();if($ui.HasExited){throw 'Baseline exited before window'};if($ui.MainWindowHandle -ne 0 -and $ui.MainWindowTitle -match 'v0\.6\.0-beta\.1$'){break};Start-Sleep -Milliseconds 200}while([DateTime]::UtcNow -lt $deadline)
 if($ui.MainWindowHandle -eq 0 -or $ui.MainWindowTitle -notmatch 'v0\.6\.0-beta\.1$'){throw 'Exact plain Beta1 window absent'}
 $report.stages.baselineWindow=(Describe-Owned $ui)
 Wait-ActualBaselineUi $ui
 $report.stages.baselineCloseRequest=@{sent=$ui.CloseMainWindow();atUtc=[DateTime]::UtcNow.ToString('o')}
 if(-not $report.stages.baselineCloseRequest.sent){throw 'Cannot normally close baseline window'}
 try{Wait-Owned $ui 30}catch{$report.stages.baselineCloseDiagnostic=(Describe-Owned $ui);throw}
 if(-not(Test-Path -LiteralPath $data)){throw 'Real default profile absent'}
 $createdProfile=$true;[IO.File]::WriteAllText((Join-Path $data '.owned-beta-qa'),$marker)
 $report.stages.baselinePlainLaunch='passed'
 $handoff=Run-Driver 'handoff'
 if($handoff.status -cne 'shell-handoff-only' -or $handoff.upgradePassed){throw 'Handoff must not claim install success'}
 $proof=Get-Content -LiteralPath (Join-Path $EvidenceDirectory 'handoff-proof.json') -Raw | ConvertFrom-Json
 $ps=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
 $wizard=Start-Owned $ps @('-NoLogo','-NoProfile','-File',(Join-Path $PSScriptRoot 'owned-installer-wizard.ps1'),'-ExpectedInstaller',$proof.installerPath,'-ExpectedHash',$proof.installerSha256,'-Version',$pair.to.version,'-ExpectedInstallDirectory',$install,'-OutputDirectory',(Join-Path $EvidenceDirectory 'wizard'),'-StartedAfterUtc',$proof.startedAfterUtc,'-ExpectedAppPid',[string]$proof.beta1Pid,'-ExpectedAppStartUtc',$proof.beta1StartUtc,'-ExpectedAppHash',$proof.beta1ExeSha256)
 Wait-Owned $wizard 450
 $report.installerExecuted=$true
 $verified=Run-Driver 'verify'
 if($verified.status -cne 'beta-upgrade-verified' -or -not $verified.upgradePassed -or -not $verified.installerExecuted){throw 'Actual exact Beta2 verification incomplete'}
 $report.stages.upgrade='passed'
 $db=Join-Path $data 'agent.sqlite';$before=Hash $db
 Uninstall-Owned
 if((Hash $db) -ne $before -or [IO.File]::ReadAllText((Join-Path $data '.owned-beta-qa')) -cne $marker){throw 'Uninstall changed owned persisted profile'}
 $report.stages.uninstallPreservesProfile='passed'
 $p=Start-Owned $TargetInstaller @() ("/S /currentuser /D=$install");Wait-Owned $p 240
 if((Hash $appExe) -ne $pair.to.installedExeSha256 -or (Hash (Join-Path $install 'resources/app.asar')) -ne $pair.to.installedAsarSha256 -or (Hash $db) -ne $before){throw 'Exact target reinstall/profile mismatch'}
 $report.stages.reinstall='passed';Uninstall-Owned;$report.stages.finalUninstall='passed';$report.status='native-beta-online-update-passed';$report.upgradePassed=$true
}catch{$report.error=$_.Exception.Message;Write-Warning $report.error}
finally{
 foreach($p in $owned){try{if(-not $p.HasExited){if($p.MainWindowHandle -ne 0){[void]$p.CloseMainWindow()};if(-not $p.WaitForExit(10000)){$report.cleanupErrors+='Owned process did not exit normally'}}}catch{$report.cleanupErrors+=$_.Exception.Message}}
 if(Test-Path -LiteralPath $appExe){try{Uninstall-Owned}catch{$report.cleanupErrors+=$_.Exception.Message}}
 if($createdProfile -and (Test-Path -LiteralPath $data)){try{if([IO.File]::ReadAllText((Join-Path $data '.owned-beta-qa')) -cne $marker){throw 'Profile owner marker mismatch'};Remove-Item -LiteralPath $data -Recurse -Force}catch{$report.cleanupErrors+=$_.Exception.Message}}
 if($report.cleanupErrors.Count){$report.status='failed';$report.upgradePassed=$false}
 $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'native-beta-online-update.json') -Encoding utf8
}
if($report.status -cne 'native-beta-online-update-passed' -or $report.cleanupErrors.Count){exit 1}
exit 0
