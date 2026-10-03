param([int]$OwnerPid,[string]$ExpectedExecutable,[string]$ExpectedHash,[string]$Version,[ValidateSet('cancel','confirm')][string]$Decision)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$p=[Diagnostics.Process]::GetProcessById($OwnerPid)
$held=$p.Handle
$started=$p.StartTime.ToUniversalTime().Ticks
$path=[IO.Path]::GetFullPath($ExpectedExecutable)
if ([IO.Path]::GetFullPath($p.MainModule.FileName) -ine $path) {throw 'Wrong own-app process'}
if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedHash) {throw 'Wrong locked application'}
$end=[DateTime]::UtcNow.AddSeconds(30)
while([DateTime]::UtcNow -lt $end){
 $p.Refresh()
 if($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks -ne $started){throw 'Own-app identity ended'}
 $pidCondition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$OwnerPid)
 $windows=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$pidCondition)
 foreach($w in $windows){
  if($w.Current.Name -ne '安装路衡测试版更新'){continue}
  $all=$w.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
  $names=@();foreach($e in $all){$names+=$e.Current.Name}
  $text=$names -join "`n"
  if(-not $text.Contains($Version) -or -not $text.Contains('jobKKB/luheng-highway-agent') -or -not $text.Contains('未签名') -or -not $text.Contains('当前用户')){throw 'Native consent content not bound to expected update'}
  $name=if($Decision -eq 'cancel'){'取消'}else{'退出并打开安装向导'}
  $condition=[System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty,$name)
  $button=$w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
  if($null -eq $button -or -not $button.Current.IsEnabled){throw 'Own-app confirmation button absent'}
  $p.Refresh();if($p.HasExited -or $p.StartTime.ToUniversalTime().Ticks -ne $started){throw 'Own-app identity ended before action'}
  $pattern=$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke()
  Write-Output ('LUHENG_NATIVE_CONSENT_'+$Decision.ToUpperInvariant());exit 0
 }
 Start-Sleep -Milliseconds 100
}
throw 'Own-app confirmation unavailable; OS/other windows are never clicked'
