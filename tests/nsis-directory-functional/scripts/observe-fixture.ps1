[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Executable,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ExpectedHash,[Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{32}$')][string]$Nonce,[Parameter(Mandatory=$true)][string]$Output)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if(-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted'){throw 'Official disposable Windows runner required'}
$Executable=(Resolve-Path -LiteralPath $Executable).Path
if((Get-FileHash -LiteralPath $Executable).Hash.ToLowerInvariant() -cne $ExpectedHash){throw 'Exact compiled fixture hash required'}
if(Test-Path -LiteralPath $Output){throw 'Fresh output required'}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class OwnFixtureUi {
 public delegate bool EnumProc(IntPtr h,IntPtr state);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr state);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 public static IntPtr[] Windows(int expectedPid){var list=new List<IntPtr>();EnumWindows((h,s)=>{uint p;GetWindowThreadProcessId(h,out p);if(p==expectedPid&&IsWindowVisible(h))list.Add(h);return true;},IntPtr.Zero);return list.ToArray();}
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h,int id);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
 [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent,IntPtr child);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h,StringBuilder text,int length);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h,StringBuilder text,int length);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool PostMessageW(IntPtr h,uint msg,IntPtr w,IntPtr l);
}
'@
$report=[ordered]@{schema=1;actualWindows=$true;helperFlowPassed=$false;securityPromptBypassed=$false;sourceCommit=$env:GITHUB_SHA;exeHash=$ExpectedHash;observations=@();actions=@();cleanupErrors=@();error=$null};$p=$null
try {
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Executable;$info.UseShellExecute=$false
 foreach($arg in @('/S',"/ROOT=$Root","/NONCE=$Nonce")){$info.ArgumentList.Add($arg)}
 $p=[Diagnostics.Process]::Start($info);$held=$p.Handle;$started=$p.StartTime.ToUniversalTime().Ticks;$report.pid=$p.Id;$deadline=[DateTime]::UtcNow.AddSeconds(30);$seen=@{}
 while([DateTime]::UtcNow -lt $deadline){
  $p.Refresh();if($p.HasExited){break};if($p.StartTime.ToUniversalTime().Ticks -ne $started -or $p.MainModule.FileName -ine $Executable){throw 'Actual fixture process identity changed'}
  foreach($nativeWindow in [OwnFixtureUi]::Windows($p.Id)){
   $window=[Windows.Automation.AutomationElement]::FromHandle($nativeWindow)
   if($window.Current.ProcessId -ne $p.Id){throw 'Own fixture window PID changed'}
   $all=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition);$names=@($all|ForEach-Object {$_.Current.Name});$text=$names -join "`n";$sig=$window.Current.Name+"`n"+$text
   if(-not $seen.ContainsKey($sig)){$seen[$sig]=$true;$report.observations+=@{atUtc=[DateTime]::UtcNow.ToString('o');title=$window.Current.Name;names=$names}}
   if($text -notmatch 'Luheng functional fixture front gate:'){continue}
   $win=[IntPtr]::new([long]$window.Current.NativeWindowHandle);$button=[OwnFixtureUi]::GetDlgItem($win,1);[uint32]$pidValue=0;[void][OwnFixtureUi]::GetWindowThreadProcessId($button,[ref]$pidValue)
   $cls=[Text.StringBuilder]::new(128);[void][OwnFixtureUi]::GetClassNameW($button,$cls,128);$label=[Text.StringBuilder]::new(128);[void][OwnFixtureUi]::GetWindowTextW($button,$label,128)
   if($window.Current.Name -notmatch '^Luheng directory helper functional fixture' -or $pidValue -ne $p.Id -or -not [OwnFixtureUi]::IsChild($win,$button) -or [OwnFixtureUi]::GetDlgCtrlID($button) -ne 1 -or $cls.ToString() -cne 'Button' -or $label.ToString().Replace('&','') -cne 'OK' -or -not [OwnFixtureUi]::IsWindowEnabled($button)){throw 'Own diagnostic acknowledgement identity mismatch'}
   $report.frontGateText=$text
   if(-not [OwnFixtureUi]::PostMessageW($button,0xF5,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Own diagnostic acknowledgement refused'}
   $report.actions+=@{kind='ordinary own diagnostic OK';nativeHandle=$button.ToInt64();atUtc=[DateTime]::UtcNow.ToString('o')}
  }
  Start-Sleep -Milliseconds 100
 }
 if(-not $p.WaitForExit(1000)){throw 'Owned fixture remains running; no forced termination'}
 $report.exitCode=$p.ExitCode
} catch {$report.error=$_.Exception.Message} finally {if($p){$p.Refresh();if(-not $p.HasExited){$report.cleanupErrors+='Owned fixture still running'}else{$report.exitCode=$p.ExitCode}};$report|ConvertTo-Json -Depth 10|Set-Content -LiteralPath $Output -Encoding utf8;Write-Output($report|ConvertTo-Json -Depth 10)}
if($report.error -or $report.cleanupErrors.Count -ne 0){exit 1}
