# Compare the exact pinned shell handoff with direct NSIS Exec under one filtered token.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$NsisDirectory,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath($OutputDirectory)
if(Test-Path -LiteralPath $root){throw 'Fresh disposable output directory required'}
New-Item -ItemType Directory -Path $root|Out-Null
$helper=(Resolve-Path (Join-Path $PSScriptRoot '../native-installer-consumer/token-review/RestrictedTokenLauncher.cs')).Path
$child=(Resolve-Path (Join-Path $PSScriptRoot 'verify-relaunch-token-child.ps1')).Path
$pwsh=(Get-Process -Id $PID).Path
$compiler=Join-Path (Resolve-Path $NsisDirectory).Path 'makensis.exe'
Add-Type -Path $helper
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$acl=Get-Acl -LiteralPath $root
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
    [Security.Principal.SecurityIdentifier]::new($sid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
Set-Acl -LiteralPath $root -AclObject $acl
foreach($path in @($root,$helper,$child,$pwsh,$compiler)) {
    if($path -match '[\r\n$`"]'){throw 'Unsafe literal NSIS path'}
}
$report=[ordered]@{scope='synthetic-owned-children-only';status='started';sourceToken=$null;
    explorer=@();restrictedInstaller=$null;direct=$null;shell=$null;shellResult=$null;error=$null;
    compilerSha256=(Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash;
    stdUtilsSha256=(Get-FileHash -LiteralPath (Join-Path $NsisDirectory 'Plugins/x86-unicode/StdUtils.dll') -Algorithm SHA256).Hash}
$report.sourceToken=[RestrictedTokenLauncher]::InspectProcessToken($PID)
foreach($explorer in @(Get-Process explorer -ErrorAction SilentlyContinue)) {
    $report.explorer+=@{pid=$explorer.Id;session=$explorer.SessionId;token=[RestrictedTokenLauncher]::InspectProcessToken($explorer.Id)}
}
$script=Join-Path $root 'handoff.nsi'
$executable=Join-Path $root 'handoff.exe'
# The output argument is the same $0 consumed and ignored by app-builder's StartApp.
$nsis=@'
Unicode true
Name "Synthetic relaunch token probe"
OutFile "@@EXE@@"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Section
  SetOutPath "@@ROOT@@"
  ClearErrors
  Exec '$\"@@PWSH@@$\" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File $\"@@CHILD@@$\" -Helper $\"@@HELPER@@$\" -Output $\"@@ROOT@@\direct.json$\" -Mode direct'
  StrCpy $1 "launched"
  IfErrors 0 +2
  StrCpy $1 "error"
  Push "@@PWSH@@"
  Push "open"
  Push '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File $\"@@CHILD@@$\" -Helper $\"@@HELPER@@$\" -Output $\"@@ROOT@@\shell.json$\" -Mode shell'
  StdUtils::ExecShellAsUser /NOUNLOAD
  Pop $0
  FileOpen $2 "@@ROOT@@\launch-result.txt" w
  FileWrite $2 "$0$\r$\n$1"
  FileClose $2
  StrCpy $3 0
  waitForShell:
    IfFileExists "@@ROOT@@\shell.json" 0 waitForRecords
    IfFileExists "@@ROOT@@\direct.json" finished
  waitForRecords:
    Sleep 100
    IntOp $3 $3 + 1
    IntCmp $3 300 finished waitForShell finished
  finished:
SectionEnd
'@
$nsis=$nsis.Replace('@@EXE@@',$executable).Replace('@@ROOT@@',$root).Replace('@@PWSH@@',$pwsh).Replace('@@CHILD@@',$child).Replace('@@HELPER@@',$helper)
$nsis|Set-Content -LiteralPath $script -Encoding utf8
try {
    $env:NSISDIR=(Resolve-Path $NsisDirectory).Path
    & $compiler /WX /V4 $script *> (Join-Path $root 'compile.log')
    if($LASTEXITCODE){throw 'Synthetic NSIS compilation failed'}
    $environment=@{}
    foreach($name in @('SystemRoot','WINDIR','SystemDrive','COMSPEC','USERPROFILE','LOCALAPPDATA','APPDATA','PATH','PATHEXT')) {
        $value=[Environment]::GetEnvironmentVariable($name,'Process')
        if($null -ne $value){$environment[$name]=$value}
    }
    $environment.TEMP=$root;$environment.TMP=$root
    $pairs=@($environment.Keys|ForEach-Object{$_+'='+$environment[$_]})
    $report.restrictedInstaller=[RestrictedTokenLauncher]::Run($executable,'',$root,[string[]]$pairs,60000)
    $report.shellResult=(Get-Content -LiteralPath (Join-Path $root 'launch-result.txt'))[0]
    $report.direct=Get-Content -LiteralPath (Join-Path $root 'direct.json') -Raw|ConvertFrom-Json
    $report.shell=Get-Content -LiteralPath (Join-Path $root 'shell.json') -Raw|ConvertFrom-Json
    if($report.direct.error -or $report.shell.error){throw 'Child could not self-report token'}
    if($report.direct.token.IsElevated -ne 0 -or $report.direct.token.IntegritySid -cne 'S-1-16-8192' -or $report.direct.token.HasRestrictions -ne 1){throw 'Direct child did not preserve the filtered installer token'}
    $report.status='observed'
} catch {
    $report.error=$_.Exception.Message
    $report.restrictedInstaller=[RestrictedTokenLauncher]::LastEvidence
    $report.status='failed'
} finally {
    # Shell dispatch can escape the caller's job. Only stop this exact owned script.
    $owned=@(Get-CimInstance Win32_Process -Filter "Name='pwsh.exe'"|Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($child) -and $_.CommandLine.Contains($root) -and $_.ProcessId -ne $PID
    })
    $report['remainingOwnedChildren']=@($owned|Select-Object ProcessId,ParentProcessId)
    foreach($process in $owned){Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue}
    $report|ConvertTo-Json -Depth 20|Set-Content -LiteralPath (Join-Path $root 'relaunch-token-report.json') -Encoding utf8
}
if($report.status -cne 'observed'){throw $report.error}
[pscustomobject]$report|Select-Object status,shellResult,@{n='directElevated';e={$_.direct.token.IsElevated}},@{n='shellElevated';e={$_.shell.token.IsElevated}},@{n='directRestricted';e={$_.direct.token.HasRestrictions}},@{n='shellRestricted';e={$_.shell.token.HasRestrictions}}
