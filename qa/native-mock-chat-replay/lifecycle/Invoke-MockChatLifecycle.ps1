# Installation is confined to a disposable hosted Windows runner.
# It is never a user-computer install or separate standard-account validation.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Contract,
  [Parameter(Mandatory)][string]$BuildReceipt,
  [Parameter(Mandatory)][string]$OriginalEvidence,
  [Parameter(Mandatory)][string]$JobRoot,
  [Parameter(Mandatory)][string]$Verifier,
  [string]$PythonExecutable,
  [Parameter(Mandatory)][string]$NodeExecutable
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Native PowerShell7 Windows x64 required' }
if (-not $env:RUNNER_TEMP -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') { throw 'Disposable GitHub Actions runner only; do not install on a user computer' }
$job = [IO.Path]::GetFullPath($JobRoot)
$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $job.StartsWith($runner,[StringComparison]::OrdinalIgnoreCase)) { throw 'Lifecycle root is outside disposable runner scratch' }
$pins = Get-Content -LiteralPath $Contract -Raw | ConvertFrom-Json
if ($pins.qualified -ne $true -or $pins.lifecycleMode -notin @('elevated-runner-explicitly-limited','restricted-token-same-user')) { throw 'Lifecycle mode or qualification is not reviewed' }
$build = Get-Content -LiteralPath $BuildReceipt -Raw | ConvertFrom-Json
if ($build.payload.rebuilt -ne $false -or $build.signed -ne $false -or $build.custody.runId -ne [string]$pins.build.runId -or $build.payload.sourceCommit -cne $pins.source.commit -or $build.payload.sourceTreeSha256 -cne $pins.source.treeSha256) { throw 'Installer receipt is not this immutable unsigned payload' }
$installer = [IO.Path]::GetFullPath($build.installer)
if ((Get-Item -LiteralPath $installer).Length -ne $build.bytes -or (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $build.sha256) { throw 'Built installer hash/size differs' }
if ((Get-AuthenticodeSignature -LiteralPath $installer).Status -ne 'NotSigned') { throw 'This lane is required to be explicitly unsigned' }
$node = (Resolve-Path -LiteralPath $NodeExecutable).Path
$python = if ($PythonExecutable) { (Resolve-Path -LiteralPath $PythonExecutable).Path } else { (Get-Command python -ErrorAction Stop).Source }
$verifierPath = (Resolve-Path -LiteralPath $Verifier).Path
$contractPath = (Resolve-Path -LiteralPath $Contract).Path
$evidenceRoot = (Resolve-Path -LiteralPath $OriginalEvidence).Path
$out = Join-Path $job 'evidence'
$state = Join-Path $job 'lifecycle-state'
$install = Join-Path $job 'isolated-install'
if ((Test-Path -LiteralPath $state) -or (Test-Path -LiteralPath $install)) { throw 'Fresh lifecycle state and install directory required' }
New-Item -ItemType Directory -Force $state,$out | Out-Null
foreach ($name in @('user','local','roaming','temp','home','parent-tools','electron-user-data','work','programdata')) { New-Item -ItemType Directory -Force (Join-Path $state $name) | Out-Null }
Add-Type -Path (Join-Path $PSScriptRoot 'token-review/RestrictedTokenLauncher.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'LifecycleProcessOwner.cs')
. (Join-Path $PSScriptRoot 'Observe-InstallerLifecycle.ps1')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LuhengWindowRect {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowRect(IntPtr hwnd,out RECT rect);
}
'@
$rootToken = [RestrictedTokenLauncher]::InspectProcessToken($PID)
if ($pins.lifecycleMode -eq 'restricted-token-same-user' -and ($rootToken.IsElevated -ne 0 -or $rootToken.IntegritySid -ne 'S-1-16-8192')) { throw 'Restricted lifecycle did not receive a recorded medium non-elevated child token' }
function Resolve-InstallerSystemDrive([string]$SystemRoot,[object]$InheritedSystemDrive=$null) {
  $rootMatch=[regex]::Match($SystemRoot,'^([A-Za-z]:)[\\/]')
  if (-not $rootMatch.Success -or $SystemRoot.Contains('%')) { throw 'SystemRoot must be an absolute local Windows drive path' }
  $drive=$rootMatch.Groups[1].Value.ToUpperInvariant()
  if ($null -ne $InheritedSystemDrive -and [string]$InheritedSystemDrive -ine $drive) { throw 'SystemDrive differs from SystemRoot drive' }
  return $drive
}
$envMap = @{}
foreach ($name in @('SystemRoot','WINDIR','COMSPEC','ProgramFiles','ProgramFiles(x86)','ProgramW6432','NUMBER_OF_PROCESSORS','OS','PATHEXT')) {
  $value = [Environment]::GetEnvironmentVariable($name,'Process')
  if ($null -ne $value) { $envMap[$name]=$value }
}
$envMap['SystemDrive'] = Resolve-InstallerSystemDrive $envMap['SystemRoot'] ([Environment]::GetEnvironmentVariable('SystemDrive','Process'))
$envMap['PATH'] = @((Join-Path $env:SystemRoot 'System32'),$env:SystemRoot,(Join-Path $env:SystemRoot 'System32/Wbem')) -join ';'
$envMap['HOME'] = Join-Path $state 'user'
$envMap['USERPROFILE'] = Join-Path $state 'user'
$envMap['HERMES_REAL_HOME'] = Join-Path $state 'user'
$envMap['LOCALAPPDATA'] = Join-Path $state 'local'
$envMap['APPDATA'] = Join-Path $state 'roaming'
$envMap['PROGRAMDATA'] = Join-Path $state 'programdata'
$envMap['TEMP'] = Join-Path $state 'temp'
$envMap['TMP'] = Join-Path $state 'temp'
$envMap['HERMES_HOME'] = Join-Path $state 'home'
$envMap['HERMES_RUNTIME_DIR'] = Join-Path $state 'parent-tools'
$envMap['HERMES_DESKTOP_USER_DATA_DIR'] = Join-Path $state 'electron-user-data'
$envMap['HERMES_NONINTERACTIVE'] = '1'
$envMap['HERMES_DISABLE_LAZY_INSTALLS'] = '1'
$envMap['PYTHONDONTWRITEBYTECODE'] = '1'
$envMap['PYTHONUTF8'] = '1'
$envMap['ELECTRON_ENABLE_LOGGING'] = '1'
$envMap['TZ'] = 'UTC'
# These nonsecret orchestration facts are needed by the isolated mock helper.
$envMap['GITHUB_ACTIONS'] = 'true'
$envMap['RUNNER_TEMP'] = $env:RUNNER_TEMP
$envMap['RUNNER_ENVIRONMENT'] = 'github-hosted'
$envMap['XDG_CONFIG_HOME'] = Join-Path $state 'xdg-config'
$envMap['XDG_CACHE_HOME'] = Join-Path $state 'xdg-cache'
$envMap['XDG_DATA_HOME'] = Join-Path $state 'xdg-data'
$userRoot = [IO.Path]::GetPathRoot($envMap['USERPROFILE']).TrimEnd('\')
$envMap['HOMEDRIVE'] = $userRoot
$envMap['HOMEPATH'] = $envMap['USERPROFILE'].Substring($userRoot.Length)
# This is synthetic JSON-as-YAML. There are no real provider keys, sessions, plugins,
# external requests, scheduled execution, source-file mutations or user profiles.
@{
  updates=@{check=$false}; security=@{allow_lazy_installs=$false}; plugins=@{enabled=@()}
  terminal=@{backend='local';cwd=(Join-Path $state 'work');home_mode='profile';auto_source_bashrc=$false;shell_init_files=@()}
  telemetry=@{shared_metrics=@{enabled=$false;send_enabled=$false}}
  auxiliary=@{title_generation=@{enabled=$false;model_upgrade_enabled=$false}}
  lsp=@{enabled=$false}
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $state 'home/config.yaml') -Encoding utf8
$markerText = 'synthetic-luheng-retain-' + [Guid]::NewGuid().ToString('N')
$markers = @((Join-Path $state 'home/synthetic-retain.txt'),(Join-Path $state 'electron-user-data/synthetic-retain.txt'))
foreach ($marker in $markers) { [IO.File]::WriteAllText($marker,$markerText,[Text.UTF8Encoding]::new($false)) }
$markerHash = (Get-FileHash -LiteralPath $markers[0] -Algorithm SHA256).Hash
$result = [ordered]@{
  schema=1; build_run_id=$pins.build.runId; consumer_run_id=$env:GITHUB_RUN_ID
  coverage=$pins.lifecycleMode; runner_token=$rootToken; native_windows=$true; architecture='X64'
  unsigned_installer=$true; installed=$false; every_installed_payload_file_verified=$false
  native_window=$false; contained_backend_health=$false; normal_window_close=$false
  contained_processes_stopped=$false; normal_uninstall=$false; installed_tree_removed=$false
  synthetic_userdata_retained=$false; default_shell_appdata_retention_verified=$false
  standard_user_installation_verified=$false; restricted_token_lifecycle_verified=$false
  registration_scope_verified=$false; offline_verified=$false; physical_ime_verified=$false
  automatic_update_verified=$false; forced_cleanup=$false; error=$null; tokens=@{}
  mocked_model_orchestration_verified=$false; debugger_owned_loopback=$false; mock_controller_closed=$false
  plain_launch=$false; ui_probe_mode='fresh-synthetic-profile-loopback-cdp-mock-chat'; model_chat_verified=$false
  installer_sha256=$build.sha256; immutable_payload_rebuilt=$false
}
$owners = [Collections.Generic.Dictionary[int,object]]::new()
$result['process_tracking']='owned-native-jobs; ordinary same-token launch'
function Start-OwnedProcess([string]$Exe,[string]$ArgumentLine,[string]$Cwd,[string]$Label) {
  $pairs=@($envMap.Keys | ForEach-Object { $_ + '=' + [string]$envMap[$_] })
  $owner=[LifecycleProcessOwner]::StartSuspended($Exe,$ArgumentLine,$Cwd,[string[]]$pairs)
  $proc=$owner.Process
  $owners.Add($proc.Id,$owner)
  # The child cannot exit or spawn before its actual token is observed.
  $token=[RestrictedTokenLauncher]::InspectProcessToken($proc.Id)
  $result.tokens[$Label]=$token
  if ($pins.lifecycleMode -eq 'restricted-token-same-user' -and ($token.IsElevated -ne 0 -or $token.IntegritySid -ne 'S-1-16-8192')) { throw "Unexpected token for $Label" }
  $owner.Resume()
  return $proc
}
function Descendants([int[]]$Roots) {
  $ids=[Collections.Generic.HashSet[int]]::new()
  foreach ($rootId in $Roots) {
    if ($owners.ContainsKey($rootId)) {
      foreach ($processId in $owners[$rootId].ProcessIds()) { [void]$ids.Add($processId) }
    }
  }
  # This snapshot locates windows/listeners only. Absence is never exit proof;
  # native job accounting below owns completion, including short-lived parents.
  return @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath,CreationDate |
    Where-Object { $ids.Contains([int]$_.ProcessId) })
}
function Wait-OwnedProcess($Process,[int]$TimeoutSeconds) {
  $watch=[Diagnostics.Stopwatch]::StartNew()
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) { return $false }
  $remaining=[Math]::Max(0,($TimeoutSeconds * 1000)-[int]$watch.ElapsedMilliseconds)
  return ($Process.ExitCode -eq 0 -and $owners[$Process.Id].WaitForEmpty($remaining))
}
function Stop-OwnedProcesses {
  foreach ($owner in $owners.Values) {
    if ($owner.ActiveProcessCount -gt 0) {
      $result.forced_cleanup=$true
      $owner.Terminate()
      if (-not $owner.WaitForEmpty(10000)) { throw 'Owned lifecycle process job did not finish cleanup' }
    }
  }
}
$app=$null; $uninstaller=$null; $bytesAdmitted=$false
try {
  # /D= must be last and unquoted in NSIS's raw argument string. Ordinary
  # /currentuser /S without --force-run does not request an initial app launch or elevation.
  $installProc=Start-OwnedProcess $installer "/currentuser /S /D=$install" $state 'installer'
  $installWait=Wait-OwnedProcessObserved -Process $installProc -Owner $owners[$installProc.Id] -Phase installer -TimeoutSeconds 1800 -InstallRoot $install -TempRoot $envMap['TEMP'] -EvidenceDirectory $out
  $result['installer_wait']=$installWait
  if (-not $installWait.completed) { throw ('Ordinary NSIS install incomplete: '+$installWait.reason) }
  $result.installed=$true
  $manifestFile=Join-Path $evidenceRoot $pins.evidenceFiles.structure.path
  $structure=Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
  $expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($row in $structure.files) { [void]$expected.Add($row.path) }
  # Only installer-generated uninstaller may be extra; every payload file and
  # exact membership are still checked independently against frozen evidence.
  $extra=@(Get-ChildItem -LiteralPath $install -Recurse -Force -File | Where-Object {
    -not $expected.Contains([IO.Path]::GetRelativePath($install,$_.FullName).Replace('\','/'))
  })
  $uninstallerExtra=@($extra | Where-Object { $_.DirectoryName -ieq $install -and $_.Name -match '^Uninstall [^\\/]+\.exe$' })
  $markerPath=Join-Path $install 'resources/package-type'
  $markerExtra=@($extra | Where-Object { $_.FullName -ieq $markerPath })
  if ($extra.Count -ne 2 -or $uninstallerExtra.Count -ne 1 -or $markerExtra.Count -ne 1) { throw 'Unreviewed installed-file additions; do not execute an unknown uninstaller' }
  if ($markerExtra[0].Length -ne 4 -or [IO.File]::ReadAllText($markerPath,[Text.Encoding]::ASCII) -cne 'nsis') { throw 'Pinned NSIS package-type marker differs' }
  $uninstaller=$uninstallerExtra[0].FullName
  & $python -I -S -B $verifierPath tree --contract $contractPath --evidence $evidenceRoot --root $install --uninstaller ([IO.Path]::GetFileName($uninstaller)) --output (Join-Path $out 'installed-payload-before-launch.json')
  if ($LASTEXITCODE) { throw 'Installed payload bytes/membership differ' }
  $bytesAdmitted=$true; $result.every_installed_payload_file_verified=$true
  $exe=Join-Path $install 'LuhengOfficeAgent.exe'
  $runtime=Get-Content -LiteralPath (Join-Path $install 'resources/agent-payload/manifest.json') -Raw | ConvertFrom-Json
  $backendExe=[IO.Path]::GetFullPath((Join-Path (Join-Path $install 'resources/agent-payload') $runtime.runtime.storePython))
  # Ephemeral loopback debug port for this fresh synthetic UI probe only.
  # Reservation is released before launch; a raced/foreign listener is refused below.
  $reservation=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
  $reservation.Start(); $debugPort=$reservation.LocalEndpoint.Port; $reservation.Stop()
  $app=Start-OwnedProcess $exe "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$debugPort" $state 'desktop'

  $deadline=[DateTime]::UtcNow.AddSeconds(180); $window=$null
  do {
    $owned=@(Descendants @($app.Id) | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase) })
    $windows=@($owned | Where-Object { [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $exe } | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } | Where-Object { $_.MainWindowHandle -ne 0 })
    if ($windows.Count -eq 1) { $window=$windows[0]; $result.native_window=$true; $result.window_title=$window.MainWindowTitle }
    $backendIds=@($owned | Where-Object { [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $backendExe } | ForEach-Object { [int]$_.ProcessId })
    foreach ($listener in @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $backendIds -and $_.LocalAddress -in @('127.0.0.1','::1') })) {
      $hostAddress=if ($listener.LocalAddress -eq '::1') { '[::1]' } else { '127.0.0.1' }
      try { $health=Invoke-RestMethod -Uri "http://$($hostAddress):$($listener.LocalPort)/api/health" -TimeoutSec 2 }
      catch { continue } # Only readiness transport failures are retryable here.
      if ($health.ok -eq $true -and $health.version -ceq $pins.source.baseVersion) {
        $result.tokens['backend']=[RestrictedTokenLauncher]::InspectProcessToken([int]$listener.OwningProcess)
        if ($pins.lifecycleMode -eq 'restricted-token-same-user' -and
            ($result.tokens['backend'].IsElevated -ne 0 -or $result.tokens['backend'].IntegritySid -ne 'S-1-16-8192')) { throw 'Unexpected contained backend token' }
        $result.contained_backend_health=$true; $result.backend_pid=$listener.OwningProcess
        $result.health_version=$health.version; $result.backend_executable=$backendExe; break
      }
    }
    if ($result.native_window -and $result.contained_backend_health) { break }
    if ($app.HasExited) { throw 'Desktop exited before native readiness' }
    Start-Sleep -Milliseconds 750
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $result.native_window -or -not $result.contained_backend_health) { throw 'Actual installed native window or contained backend health missing' }
  function Get-OwnedDebuggerEndpoint {
    $jobIds=@($owners[$app.Id].ProcessIds())
    if ($app.HasExited -or $jobIds.Count -lt 1) { throw 'App job exited before CDP admission' }
    $listeners=@(Get-NetTCPConnection -State Listen -LocalPort $debugPort -ErrorAction Stop)
    if ($listeners.Count -lt 1 -or @($listeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') -or [int]$_.OwningProcess -notin $jobIds }).Count) { throw 'Debugger is not exclusively owned loopback listener' }
    $listenerPids=@($listeners | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
    if ($listenerPids.Count -ne 1) { throw 'Debugger listener has ambiguous ownership' }
    $debugProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($listenerPids[0])" -Property ProcessId,ExecutablePath,CreationDate
    if (-not $debugProcess -or -not $debugProcess.CreationDate -or [IO.Path]::GetFullPath($debugProcess.ExecutablePath) -ine $exe) { throw 'Debugger belongs to a foreign executable' }
    $version=Invoke-RestMethod -Uri "http://127.0.0.1:$debugPort/json/version" -TimeoutSec 5
    $endpoint=[Uri]$version.webSocketDebuggerUrl
    if ($endpoint.Scheme -cne 'ws' -or $endpoint.Host -cne '127.0.0.1' -or $endpoint.Port -ne $debugPort -or $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment -or $endpoint.AbsolutePath -notmatch '^/devtools/browser/[a-f0-9-]{36}$') { throw 'Returned debugger endpoint is not the admitted loopback port' }
    # Recheck native membership after HTTP discovery; no name-based browser attachment.
    if ([int]$debugProcess.ProcessId -notin @($owners[$app.Id].ProcessIds())) { throw 'Debugger owner left native job during admission' }
    return [ordered]@{endpoint=$endpoint.AbsoluteUri; listener_pid=[int]$debugProcess.ProcessId; process_created=$debugProcess.CreationDate; native_job_member=$true; exclusive_loopback_listener=$true; profile_fresh=$true; profile=$envMap['HERMES_DESKTOP_USER_DATA_DIR']; executable=$exe; install_root=$install; port=$debugPort}
  }
  try {
    $debugOwner=Get-OwnedDebuggerEndpoint
    $debugOwner | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $out 'ui-debugger-owner.json') -Encoding utf8
    $result.debugger_owned_loopback=$true
    # The helper gets the SAME explicit ordinary environment allowlist as the app.
    # It never inherits Actions tokens, real API keys, NODE_OPTIONS or user profiles.
    $nodeArguments=(@((Join-Path $PSScriptRoot '../mock/probe-mock-chat.mjs'),(Join-Path $out 'ui-debugger-owner.json'),$out,$build.sha256,$state,(Join-Path $PSScriptRoot '../probe-onboarding.mjs')) | ForEach-Object {
      if ($_.Contains('"') -or $_.Contains([char]0)) { throw 'Unsafe helper argument' }
      '"' + $_ + '"'
    }) -join ' '
    $mockController=Start-OwnedProcess $node $nodeArguments $state 'mock-controller'
    if (-not (Wait-OwnedProcess $mockController 360)) { throw 'Mock orchestration probe failed or helper job remained; inspect mock-chat.json' }
    $result.mock_controller_closed=$true
    $ui=Get-Content -LiteralPath (Join-Path $out 'mock-chat.json') -Raw | ConvertFrom-Json
    $debugAfter=Get-OwnedDebuggerEndpoint
    if ($debugAfter.endpoint -cne $debugOwner.endpoint -or $debugAfter.listener_pid -ne $debugOwner.listener_pid -or $debugAfter.process_created -ne $debugOwner.process_created) { throw 'Debugger owner changed during UI probe' }
    $debugAfter | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $out 'ui-debugger-owner-after.json') -Encoding utf8
    if ($ui.accepted_with_declared_limits -ne $true -or $ui.local_model_request_verified -ne $true -or $ui.real_read_file_roundtrip_verified -ne $true -or $ui.assistant_reply_rendered -ne $true -or $ui.loopback.closed -ne $true) { throw 'Mocked model and actual file-tool/UI roundtrip evidence incomplete' }
    $result.mocked_model_orchestration_verified=$true
  } catch {
    # A failed UI assertion must still attempt normal close/uninstall below.
    $result.error=$_.Exception.Message
  }
  try {
    Add-Type -AssemblyName System.Drawing
    $rect=[LuhengWindowRect+RECT]::new()
    if (-not [LuhengWindowRect]::GetWindowRect($window.MainWindowHandle,[ref]$rect)) { throw 'Native window rectangle unavailable' }
    $width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
    if ($width -le 0 -or $height -le 0) { throw 'Native window has invalid dimensions' }
    $bitmap=[Drawing.Bitmap]::new($width,$height); $graphics=[Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,[Drawing.Size]::new($width,$height)); $bitmap.Save((Join-Path $out 'installed-native-window.png'),[Drawing.Imaging.ImageFormat]::Png) } finally { $graphics.Dispose(); $bitmap.Dispose() }
  } catch {
    $result['native_screenshot_error']=$_.Exception.Message
    if (-not $result.error) { $result.error=$_.Exception.Message }
  }
  $result.normal_window_close=$window.CloseMainWindow()
  if (-not $result.normal_window_close -or -not $window.WaitForExit(30000)) { throw 'Normal installed window exit failed' }
  if (-not $owners[$app.Id].WaitForEmpty(30000)) { throw 'Contained process remained after normal exit' }
  $result.contained_processes_stopped=$true
  & $python -I -S -B $verifierPath tree --contract $contractPath --evidence $evidenceRoot --root $install --uninstaller ([IO.Path]::GetFileName($uninstaller)) --output (Join-Path $out 'installed-payload-after-exit.json')
  if ($LASTEXITCODE) { throw 'Installed payload changed during launch/exit' }
} catch { $result.error=$_.Exception.Message } finally {
  if ($app -and $window -and $owners.ContainsKey($app.Id) -and $owners[$app.Id].ActiveProcessCount -gt 0) {
    try {
      if ($window.Id -in @($owners[$app.Id].ProcessIds()) -and -not $window.HasExited) {
        $closeRequested=$window.CloseMainWindow()
        if ($closeRequested -and $window.WaitForExit(30000) -and $owners[$app.Id].WaitForEmpty(30000)) {
          $result.normal_window_close=$true; $result.contained_processes_stopped=$true
        }
      }
    } catch { $result['normal_close_cleanup_error']=$_.Exception.Message }
  }
  # Do not confuse forced cleanup with graceful success. Jobs contain only
  # children launched by this probe; no executable-name or reused-PID cleanup.
  try { Stop-OwnedProcesses } catch { $result.cleanup_error=$_.Exception.Message; if (-not $result.error) { $result.error=$_.Exception.Message } }
  if ($bytesAdmitted -and $uninstaller) {
    try {
      # Normal product uninstall only. No --updated, --delete-app-data, manual
      # registry deletion, file removal substitute, or app-data destruction.
      $uninstallProc=Start-OwnedProcess $uninstaller '/currentuser /S' $state 'uninstaller'
      $uninstallWait=Wait-OwnedProcessObserved -Process $uninstallProc -Owner $owners[$uninstallProc.Id] -Phase uninstaller -TimeoutSeconds 900 -InstallRoot $install -TempRoot $envMap['TEMP'] -EvidenceDirectory $out
      $result['uninstaller_wait']=$uninstallWait
      if (-not $uninstallWait.completed) { throw ('Normal uninstall incomplete: '+$uninstallWait.reason) }
      $deadline=[DateTime]::UtcNow.AddSeconds(60)
      do {
        $uninstallActive=$owners[$uninstallProc.Id].ActiveProcessCount
        if (-not (Test-Path -LiteralPath $install) -and $uninstallActive -eq 0) { break }
        Start-Sleep -Milliseconds 500
      } while ([DateTime]::UtcNow -lt $deadline)
      $result.normal_uninstall=$true; $result.installed_tree_removed=-not (Test-Path -LiteralPath $install)
      if (-not $result.installed_tree_removed -or $uninstallActive -ne 0) { throw 'Normal uninstall did not remove its directory and finish its process tree' }
      foreach ($marker in $markers) {
        if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or (Get-FileHash -LiteralPath $marker -Algorithm SHA256).Hash -cne $markerHash) { throw 'Synthetic user data changed or disappeared' }
      }
      $result.synthetic_userdata_retained=$true
    } catch { if (-not $result.error) { $result.error=$_.Exception.Message } else { $result.uninstall_error=$_.Exception.Message } }
  }
  try { Stop-OwnedProcesses } catch { $result.cleanup_error=$_.Exception.Message; if (-not $result.error) { $result.error=$_.Exception.Message } }
  foreach ($owner in $owners.Values) { $owner.Dispose() }
  $required=$result.mock_controller_closed -and $result.mocked_model_orchestration_verified -and $result.debugger_owned_loopback -and $result.installed -and $result.every_installed_payload_file_verified -and $result.native_window -and $result.contained_backend_health -and $result.normal_window_close -and $result.contained_processes_stopped -and $result.normal_uninstall -and $result.installed_tree_removed -and $result.synthetic_userdata_retained -and -not $result.forced_cleanup -and -not $result.error
  if ($required -and $pins.lifecycleMode -eq 'restricted-token-same-user') { $result.restricted_token_lifecycle_verified=$true }
  $result['accepted_with_declared_limits']=$required
  $result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $out 'installer-lifecycle.json') -Encoding utf8
  $result | ConvertTo-Json -Depth 20 | Write-Output
}
if (-not $required) { throw 'Native installer lifecycle failed or is incomplete; partial stages are not acceptance' }
