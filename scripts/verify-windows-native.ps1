# Windows GitHub-hosted CI only. Installs this build per-user, launches it, and uninstalls it.
# Never run on a developer/user computer: the real NSIS per-user registry and shortcuts are exercised.
[CmdletBinding()]
param(
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$ReportDirectory = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This installer smoke is restricted to disposable GitHub-hosted Windows runners.'
}
if (-not $env:RUNNER_TEMP -or -not $env:APPDATA) { throw 'Runner temp and app-data paths are required.' }
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
if (-not $ReportDirectory) { $ReportDirectory = Join-Path $SourceRoot 'desktop/dist/native-smoke' }
$ReportDirectory = [IO.Path]::GetFullPath($ReportDirectory)
if (Test-Path -LiteralPath $ReportDirectory) { throw 'Report directory already exists; refusing stale evidence.' }
[void](New-Item -ItemType Directory -Path $ReportDirectory)
$work = Join-Path $env:RUNNER_TEMP ('luheng-native-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $work)
$install = Join-Path $work 'installed'
$data = Join-Path $env:APPDATA 'LuhengOfficeAgent'
$sentinel = Join-Path $data 'ci-preserve-synthetic.txt'
$sentinelText = 'Synthetic CI data only: ' + [Guid]::NewGuid().ToString('N')
$createdData = $false
$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
# Hosted runners can expose both setup-node and a preinstalled node.exe.
# Select the first PATH match, never stringify the returned command array.
$node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$probeScript = Join-Path $SourceRoot 'scripts/verify-windows-native.mjs'
$uninstaller = Join-Path $install 'Uninstall Luheng Office Agent.exe'
$uninstallerCopy = Join-Path $work 'uninstall-ci.exe'
$report = [ordered]@{
  status = 'native-smoke-failed'; checkedAt = [DateTime]::UtcNow.ToString('o'); version = '0.4.0'
  commit = $env:GITHUB_SHA; runnerOS = $env:RUNNER_OS; runnerImage = $env:ImageOS; runnerImageVersion = $env:ImageVersion
  stages = [ordered]@{}; installer = $null; error = $null; cleanupError = $null
  deliverableReady = $false
  limitations = @('Unsigned prototype: signature, SmartScreen reputation, elevated/all-users install and upgrade not tested', 'Window title, window creation and normal close checked; no pixel-level UX, tray interaction or multi-monitor testing', 'See runtime.json for bundled-backend, browser-sandbox and Office rendering limits')
}
function Stop-OwnedProcess([Diagnostics.Process]$Process) {
  try { if (-not $Process.HasExited) { & "$env:SystemRoot\System32\taskkill.exe" /PID $Process.Id /T /F | Out-Null } } catch {}
}
function Start-OwnedProcess([string]$File, [string[]]$Arguments, [string]$RawArguments = '', [switch]$ElectronNode) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $File; $info.WorkingDirectory = $work; $info.UseShellExecute = $false
  if ($RawArguments) { $info.Arguments = $RawArguments } else { foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) } }
  foreach ($key in @('ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','HIGHWAY_DESKTOP_DATA_DIR','HIGHWAY_CHROMIUM_PATH','CHROME_EXECUTABLE','CHROMIUM_PATH')) { [void]$info.Environment.Remove($key) }
  # PowerShell 7 parents inject PSModulePath entries that Windows PowerShell 5.1 cannot load.
  # Match a clean native Windows runtime for the app's built-in ACL subprocess.
  $info.Environment['PSModulePath'] = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
  if ($ElectronNode) { $info.Environment['ELECTRON_RUN_AS_NODE'] = '1' }
  $p = [Diagnostics.Process]::Start($info)
  $ownedProcesses.Add($p)
  return $p
}
function Wait-OwnedProcess([Diagnostics.Process]$Process, [int]$Seconds, [int]$Expected = 0) {
  if (-not $Process.WaitForExit($Seconds * 1000)) { Stop-OwnedProcess $Process; throw "Process $($Process.Id) exceeded ${Seconds}s." }
  if ($Process.ExitCode -ne $Expected) { throw "Process $($Process.Id) exited $($Process.ExitCode), expected $Expected." }
}
function Invoke-Uninstall {
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'No installed uninstaller available.' }
  Copy-Item -LiteralPath $uninstaller -Destination $uninstallerCopy -Force
  if ((Get-FileHash -LiteralPath $uninstaller).Hash -ne (Get-FileHash -LiteralPath $uninstallerCopy).Hash) { throw 'Uninstaller copy differs.' }
  # NSIS _?= must be LAST and unquoted, including paths containing spaces.
  # Execute an unchanged external copy to avoid the normal detached self-copy process.
  $p = Start-OwnedProcess -File $uninstallerCopy -Arguments @() -RawArguments "/S /currentuser _?=$install"
  Wait-OwnedProcess $p 120
  if (Test-Path -LiteralPath (Join-Path $install 'Luheng Office Agent.exe')) { throw 'Uninstall left the application EXE.' }
  if (Test-Path -LiteralPath (Join-Path $install 'resources')) { throw 'Uninstall left the packaged resources.' }
}
try {
  if (Test-Path -LiteralPath $data) { throw 'Existing Luheng app data found; do not overwrite it.' }
  $existing = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Luheng Office Agent*' })
  if ($existing.Count) { throw 'Existing per-user Luheng installation found; refusing upgrade/uninstall.' }
  $version = (Get-Content -LiteralPath (Join-Path $SourceRoot 'package.json') -Raw | ConvertFrom-Json).version
  if ($version -ne '0.4.0') { throw 'This smoke gate is pinned to release 0.4.0.' }
  $release = Join-Path $SourceRoot 'desktop/dist/win-unpacked'
  $installer = Join-Path $SourceRoot "desktop/dist/Luheng-Office-Agent-$version-windows-x64.exe"
  $installerItem = Get-Item -LiteralPath $installer
  if ($installerItem.Length -le 0 -or $installerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installer is empty or a link.' }
  $report.installer = [ordered]@{ name = $installerItem.Name; bytes = $installerItem.Length; sha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() }
  $staticReport = Join-Path $ReportDirectory 'static-preflight.json'
  $p = Start-OwnedProcess -File $node -Arguments @((Join-Path $SourceRoot 'scripts/verify-windows-release.mjs'), $release, $installer, $staticReport)
  # Exit 2 intentionally means static preflight passed, native readiness unverified.
  Wait-OwnedProcess $p 180 2
  $static = Get-Content -LiteralPath $staticReport -Raw | ConvertFrom-Json
  if ($static.status -ne 'static-preflight-passed' -or $static.version -ne $version -or $static.installer.sha256 -ne $report.installer.sha256) { throw 'Static preflight result is not bound to this installer/version.' }
  $report.stages.staticPreflight = 'passed (expected exit 2)'
  # /D= is LAST and unquoted; no --force-run, so assisted silent install does not launch.
  $p = Start-OwnedProcess -File $installer -Arguments @() -RawArguments "/S /currentuser /D=$install"
  Wait-OwnedProcess $p 180
  $appExe = Join-Path $install 'Luheng Office Agent.exe'
  if (-not (Test-Path -LiteralPath $appExe)) { throw 'Silent installer did not write the requested per-user path.' }
  $report.stages.install = 'passed'
  $p = Start-OwnedProcess -File $node -Arguments @($probeScript, 'bind', $release, $install, (Join-Path $ReportDirectory 'installed-payload.json'))
  Wait-OwnedProcess $p 180
  $report.stages.installerPayloadBinding = 'all win-unpacked files size/SHA256 matched; only known NSIS support files allowed'
  $p = Start-OwnedProcess -File $appExe -Arguments @($probeScript, 'probe', $install, (Join-Path $work 'backend-data'), (Join-Path $ReportDirectory 'runtime.json')) -ElectronNode
  Wait-OwnedProcess $p 150
  $runtime = Get-Content -LiteralPath (Join-Path $ReportDirectory 'runtime.json') -Raw | ConvertFrom-Json
  if ($runtime.status -ne 'native-runtime-passed' -or $runtime.version -ne $version) { throw 'Runtime report did not pass.' }
  $report.stages.bundledRuntime = 'passed'
  [void](New-Item -ItemType Directory -Path $data)
  $createdData = $true
  [IO.File]::WriteAllText($sentinel, $sentinelText)
  # Plain packaged launch: no inspector, remote debugging, Playwright Electron loader or sandbox switches.
  $ui = Start-OwnedProcess -File $appExe -Arguments @()
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    if ($ui.HasExited) { throw "Desktop exited before showing its window (code $($ui.ExitCode))." }
    $ui.Refresh()
    if ($ui.MainWindowHandle -ne 0 -and $ui.MainWindowTitle -match '路衡.*办公智能体.*v0\.4') { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($ui.MainWindowHandle -eq 0 -or $ui.MainWindowTitle -notmatch '路衡.*办公智能体.*v0\.4') { throw 'Expected v0.4 application window was not shown.' }
  $report.stages.desktopWindow = @{ title = $ui.MainWindowTitle; pid = $ui.Id; plainLaunch = $true }
  if (-not $ui.CloseMainWindow()) { throw 'Native WM_CLOSE could not be sent to the app window.' }
  Wait-OwnedProcess $ui 20
  $geometry = Get-Content -LiteralPath (Join-Path $data 'window-state.json') -Raw | ConvertFrom-Json
  if ($geometry.bounds.width -le 0 -or $geometry.bounds.height -le 0) { throw 'Normal close did not persist window geometry.' }
  $report.stages.normalDesktopClose = 'passed with persisted window geometry'
  Invoke-Uninstall
  $report.stages.uninstall = 'passed; application EXE and resources removed'
  if (-not (Test-Path -LiteralPath $sentinel) -or [IO.File]::ReadAllText($sentinel) -cne $sentinelText) { throw 'Uninstall removed or changed synthetic user data.' }
  if (-not (Test-Path -LiteralPath (Join-Path $data 'window-state.json'))) { throw 'Uninstall removed saved app preferences.' }
  $report.stages.userDataPreserved = 'synthetic sentinel and actual saved window state preserved in APPDATA/LuhengOfficeAgent'
  $report.status = 'native-windows-smoke-passed'
  # Still an unsigned prototype, not a blanket deliverable-readiness claim.
} catch {
  $report.error = $_.Exception.Message
  Write-Warning $report.error
} finally {
  foreach ($p in $ownedProcesses) { Stop-OwnedProcess $p }
  # On earlier failure, remove the disposable CI install if an uninstaller exists.
  if (Test-Path -LiteralPath (Join-Path $install 'Luheng Office Agent.exe')) {
    try { Invoke-Uninstall } catch { $report.cleanupError = $_.Exception.Message }
  }
  # Delete ONLY state this run created, after recording the preservation assertion.
  if ($createdData) { try { Remove-Item -LiteralPath $data -Recurse -Force } catch { $report.cleanupError = $_.Exception.Message } }
  # Keep bounded logs/report outside installation. Runner cleans any failed-work directory.
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $ReportDirectory 'native-smoke.json') -Encoding utf8
}
$report | ConvertTo-Json -Depth 12
if ($report.status -ne 'native-windows-smoke-passed' -or $report.cleanupError) { exit 1 }
exit 0
