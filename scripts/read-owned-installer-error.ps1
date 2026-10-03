[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Installer,[Parameter(Mandatory=$true)][string]$EvidenceDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if(-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Disposable official Windows runner required'}
$Installer=(Resolve-Path -LiteralPath $Installer).Path
$expectedHash='38f8ebaea9ee8c061dea1ea46c00073439b2c795ff48696588b4f729e3a2c759'
if((Get-Item -LiteralPath $Installer).Length -ne 244078816 -or (Get-FileHash -LiteralPath $Installer).Hash.ToLowerInvariant() -cne $expectedHash){throw 'Exact reviewed failed candidate bytes required'}
foreach($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)){foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)){$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);try{$key=$base.OpenSubKey('Software\20be089a-e364-59fe-9bf1-70ea22b78d3f');if($key){$key.Dispose();throw 'Existing product installation must not be modified'}}finally{$base.Dispose()}}}
if(Test-Path -LiteralPath (Join-Path $env:APPDATA 'LuhengOfficeAgent')){throw 'Existing profile must not be modified'}
$EvidenceDirectory=[IO.Path]::GetFullPath($EvidenceDirectory);if(Test-Path -LiteralPath $EvidenceDirectory){throw 'Evidence directory exists'};[void](New-Item -ItemType Directory -Path $EvidenceDirectory)
$work=Join-Path $env:RUNNER_TEMP ('luheng-compiled-own-diag-'+[Guid]::NewGuid().ToString('N'));[void](New-Item -ItemType Directory -Path $work)
$target=Join-Path $work 'Luheng Office Agent';$report=[ordered]@{status='diagnostic-failed';installerHash=$expectedHash;sourceCommit='39bb5495a306410fd7bb5be5fdf0618f1d0dae46';actualWindows=$true;upgradePassed=$false;securityPromptBypassed=$false;target=$target;observations=@();actions=@();cleanupErrors=@()};$p=$null
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
function Capture-Owned($window,[int]$number){$rect=$window.Current.BoundingRectangle;if($rect.Width -le 0 -or $rect.Height -le 0){return};$bitmap=[Drawing.Bitmap]::new([int]$rect.Width,[int]$rect.Height);$graphics=[Drawing.Graphics]::FromImage($bitmap);try{$graphics.CopyFromScreen([int]$rect.X,[int]$rect.Y,0,0,$bitmap.Size);$bitmap.Save((Join-Path $EvidenceDirectory ('own-window-'+$number+'.png')),[Drawing.Imaging.ImageFormat]::Png)}finally{$graphics.Dispose();$bitmap.Dispose()}}
try{
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Installer;$info.Arguments="/currentuser /D=$target";$info.UseShellExecute=$false;$info.WorkingDirectory=$work;$info.Environment['PSModulePath']=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
 $p=[Diagnostics.Process]::Start($info);$held=$p.Handle;$started=$p.StartTime.ToUniversalTime().Ticks;$report.pid=$p.Id;$deadline=[DateTime]::UtcNow.AddSeconds(120);$seen=@{};$errorWindow=$null
 while([DateTime]::UtcNow -lt $deadline){
  $p.Refresh();if($p.HasExited){$report.exitCode=$p.ExitCode;break};if($p.StartTime.ToUniversalTime().Ticks -ne $started -or [IO.Path]::GetFullPath($p.MainModule.FileName) -ine $Installer){throw 'Own process identity changed'}
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$p.Id)
  $windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  foreach($window in $windows){
   $all=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition);$names=@();$primaryButtons=@();$buttonFacts=@()
   foreach($element in $all){if($element.Current.Name){$names+=$element.Current.Name};if($element.Current.Name -match '^(&?Next\s*>?|&?Install|Cancel|下一步|安装)$'){$buttonFacts+=@{name=$element.Current.Name;automationId=$element.Current.AutomationId;controlType=$element.Current.ControlType.ProgrammaticName;class=$element.Current.ClassName;processId=$element.Current.ProcessId;enabled=$element.Current.IsEnabled};if($element.Current.IsEnabled -and $element.Current.Name -match '^(&?Next\s*>?|&?Install|下一步|安装)$'){$invoke=$null;if($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)){$primaryButtons+=$element}}}}
   $text=$names -join "`n";$signature=$window.Current.Name+"`n"+$text
   if(-not $seen.ContainsKey($signature)){$seen[$signature]=$true;$report.observations+=@{atUtc=[DateTime]::UtcNow.ToString('o');title=$window.Current.Name;names=$names;buttons=$buttonFacts;nativeHandle=$window.Current.NativeWindowHandle};Capture-Owned $window $report.observations.Count}
   if($text -match '未开始卸载旧版本|安装没有自动回滚|安装目录最终检查失败|DACL|访问控制权限|目录创建检查'){$report.status='own-installer-error-observed';$report.errorText=$text;$errorWindow=$window;break}
   if($primaryButtons.Count -eq 1){
    $primary=$primaryButtons[0]
    $actionKey='clicked:'+ $signature
    if(-not $seen.ContainsKey($actionKey)){$seen[$actionKey]=$true;$p.Refresh();if($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks -ne $started){throw 'Own process ended before UI action'};if($window.Current.Name -notmatch 'Luheng Office Agent|路衡'){throw 'Unexpected own-app window'};$name=$primary.Current.Name;($primary.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke();$report.actions+=@{button=$name;atUtc=[DateTime]::UtcNow.ToString('o')}}
   }
  }
  if($errorWindow){break};Start-Sleep -Milliseconds 150
 }
 if($report.status -ne 'own-installer-error-observed'){throw 'Exact own installer error not observed; no upgrade pass claimed'}
 # Only acknowledge our own SDK error, then request ordinary close. Never touch an OS warning.
 $okCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'OK');$ok=$errorWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$okCondition);if($ok -and $ok.Current.IsEnabled){($ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()}
 $p.Refresh();if(-not $p.HasExited){[void]$p.CloseMainWindow();[void]$p.WaitForExit(3000)}
}catch{$report.error=$_.Exception.Message}finally{if($p -and -not $p.HasExited){[void]$p.CloseMainWindow();[void]$p.WaitForExit(2000);if(-not $p.HasExited){$own=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$p.Id);$ownWindows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$own);foreach($ownWindow in $ownWindows){if($ownWindow.Current.Name -match 'Luheng Office Agent|路衡'){$cancel=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,'Cancel');$cancelElement=$ownWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$cancel);if($cancelElement -and $cancelElement.Current.IsEnabled){($cancelElement.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke();$report.actions+=@{button='Cancel';reason='ordinary own installer cleanup';atUtc=[DateTime]::UtcNow.ToString('o')};[void]$p.WaitForExit(2000)}}}}};if($p){$p.Refresh();if(-not $p.HasExited){$report.cleanupErrors+='Owned installer did not exit normally after error acknowledgement'}else{$report.exitCode=$p.ExitCode}};$report|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'owned-installer-error.json') -Encoding utf8;Write-Output ($report|ConvertTo-Json -Depth 8)}
if($report.status -ne 'own-installer-error-observed'){exit 1}
