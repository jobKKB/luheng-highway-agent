# PRIVATE DRAFT. Installation is confined to a disposable hosted Windows runner.
# It is never a user-computer install or separate standard-account validation.
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Contract,
  [Parameter(Mandatory)][string]$BuildReceipt,
  [Parameter(Mandatory)][string]$OriginalEvidence,
  [Parameter(Mandatory)][string]$JobRoot,
  [Parameter(Mandatory)][string]$Verifier,
  [string]$PythonExecutable
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Native PowerShell7 Windows x64 required' }
if (-not $env:RUNNER_TEMP -or -not $env:GITHUB_ACTIONS) { throw 'Disposable GitHub Actions runner only; do not install on a user computer' }
$job = [IO.Path]::GetFullPath($JobRoot)
$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $job.StartsWith($runner,[StringComparison]::OrdinalIgnoreCase)) { throw 'Lifecycle root is outside disposable runner scratch' }
$out = Join-Path $job 'evidence'
New-Item -ItemType Directory -Force $out | Out-Null
$lifecycleClock=[Diagnostics.Stopwatch]::StartNew()
function Write-LifecycleCheckpoint([string]$Stage,$Details) {
  $entry=[ordered]@{utc=[DateTime]::UtcNow.ToString('o');elapsed_ms=$lifecycleClock.ElapsedMilliseconds;stage=$Stage;details=$Details}
  # A closed append on every checkpoint survives an outer deadline killing the probe.
  [IO.File]::AppendAllText((Join-Path $out 'lifecycle-checkpoints.jsonl'),(($entry|ConvertTo-Json -Depth 14 -Compress)+[Environment]::NewLine),[Text.UTF8Encoding]::new($false))
  Write-Output ('Lifecycle checkpoint: '+$Stage+' elapsed_ms='+$lifecycleClock.ElapsedMilliseconds) | Out-Host
}
Write-LifecycleCheckpoint 'admission-start' $null
$pins = Get-Content -LiteralPath $Contract -Raw | ConvertFrom-Json
if ($pins.qualified -ne $true -or $pins.lifecycleMode -notin @('elevated-runner-explicitly-limited','restricted-token-same-user')) { throw 'Lifecycle mode or qualification is not reviewed' }
$build = Get-Content -LiteralPath $BuildReceipt -Raw | ConvertFrom-Json
if ($build.payload.rebuilt -ne $false -or $build.signed -ne $false -or $build.custody.runId -ne [string]$pins.build.runId -or $build.payload.sourceCommit -cne $pins.source.commit -or $build.payload.sourceTreeSha256 -cne $pins.source.treeSha256) { throw 'Installer receipt is not this immutable unsigned payload' }
$installer = if ($pins.scope -eq 'artifact-recovery') { [IO.Path]::GetFullPath((Join-Path $OriginalEvidence $pins.installer.path)) } else { [IO.Path]::GetFullPath($build.installer) }
if ((Get-Item -LiteralPath $installer).Length -ne $build.bytes -or (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $build.sha256) { throw 'Built installer hash/size differs' }
if ((Get-AuthenticodeSignature -LiteralPath $installer).Status -ne 'NotSigned') { throw 'This lane is required to be explicitly unsigned' }
Write-LifecycleCheckpoint 'installer-bytes-admitted' @{bytes=$build.bytes;sha256=$build.sha256}
$python = if ($PythonExecutable) { (Resolve-Path -LiteralPath $PythonExecutable).Path } else { (Get-Command python -ErrorAction Stop).Source }
$verifierPath = (Resolve-Path -LiteralPath $Verifier).Path
$contractPath = (Resolve-Path -LiteralPath $Contract).Path
$evidenceRoot = (Resolve-Path -LiteralPath $OriginalEvidence).Path
if ($pins.scope -notin @('same-job','artifact-recovery')) { throw 'Unknown lifecycle custody scope' }
if ($pins.scope -eq 'artifact-recovery' -and ([string]$pins.acceptance.runId -cne $env:GITHUB_RUN_ID -or $pins.acceptance.headSha -cne $env:GITHUB_SHA)) { throw 'Recovery contract is not from this acceptance execution' }
if ($pins.scope -in @('same-job','artifact-recovery')) {
  if ($pins.scope -eq 'same-job' -and [string]$pins.build.runId -cne $env:GITHUB_RUN_ID) { throw 'Lifecycle contract is not from this producer run' }
  $receiptPin = $pins.evidenceFiles.installerReceipt
  $pinnedReceipt = [IO.Path]::GetFullPath((Join-Path $evidenceRoot $receiptPin.path))
  if ((Resolve-Path -LiteralPath $BuildReceipt).Path -ine $pinnedReceipt) { throw 'Lifecycle received a different installer receipt' }
  # Qualify the full evidence chain before executing even the installer.
  & $python -I -S -B $verifierPath contract --contract $contractPath --evidence $evidenceRoot --output (Join-Path $job 'contract-admission.json')
  if ($LASTEXITCODE) { throw 'Same-job installer contract admission failed' }
}
Write-LifecycleCheckpoint 'contract-admitted' $null
$out = Join-Path $job 'evidence'
$state = Join-Path $job 'lifecycle-state'
$install = Join-Path $job 'isolated-install'
if ((Test-Path -LiteralPath $state) -or (Test-Path -LiteralPath $install)) { throw 'Fresh lifecycle state and install directory required' }
New-Item -ItemType Directory -Force $state,$out | Out-Null
foreach ($name in @('user','local','roaming','temp','home','parent-tools','electron-user-data','work','programdata')) { New-Item -ItemType Directory -Force (Join-Path $state $name) | Out-Null }
Add-Type -Path (Join-Path $PSScriptRoot 'token-review/RestrictedTokenLauncher.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'LifecycleProcessOwner.cs')
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
$envMap = @{}
foreach ($name in @('SystemRoot','WINDIR','COMSPEC','ProgramFiles','ProgramFiles(x86)','ProgramW6432','NUMBER_OF_PROCESSORS','OS','PATHEXT')) {
  $value = [Environment]::GetEnvironmentVariable($name,'Process')
  if ($null -ne $value) { $envMap[$name]=$value }
}
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
$envMap['XDG_CONFIG_HOME'] = Join-Path $state 'xdg-config'
$envMap['XDG_CACHE_HOME'] = Join-Path $state 'xdg-cache'
$envMap['XDG_DATA_HOME'] = Join-Path $state 'xdg-data'
$userRoot = [IO.Path]::GetPathRoot($envMap['USERPROFILE']).TrimEnd('\')
$envMap['HOMEDRIVE'] = $userRoot
$envMap['HOMEPATH'] = $envMap['USERPROFILE'].Substring($userRoot.Length)
# This is synthetic JSON-as-YAML. There are no provider keys, sessions, plugins,
# external requests, scheduled execution, source-file mutations or user profiles.
@{
  updates=@{check=$false}; security=@{allow_lazy_installs=$false}; plugins=@{enabled=@()}
  terminal=@{backend='local';cwd=(Join-Path $state 'work');home_mode='profile';auto_source_bashrc=$false;shell_init_files=@()}
  telemetry=@{shared_metrics=@{enabled=$false;send_enabled=$false}}
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $state 'home/config.yaml') -Encoding utf8
$markerText = 'synthetic-luheng-retain-' + [Guid]::NewGuid().ToString('N')
$markers = @((Join-Path $state 'home/synthetic-retain.txt'),(Join-Path $state 'electron-user-data/synthetic-retain.txt'))
foreach ($marker in $markers) { [IO.File]::WriteAllText($marker,$markerText,[Text.UTF8Encoding]::new($false)) }
$markerHash = (Get-FileHash -LiteralPath $markers[0] -Algorithm SHA256).Hash
$result = [ordered]@{
  schema=1; scope=$pins.scope; build_run_id=$pins.build.runId; consumer_run_id=$env:GITHUB_RUN_ID; acceptance_run_id=$env:GITHUB_RUN_ID
  coverage=$pins.lifecycleMode; runner_token=$rootToken; native_windows=$true; architecture='X64'
  unsigned_installer=$true; installed=$false; every_installed_payload_file_verified=$false
  native_window=$false; contained_backend_health=$false; normal_window_close=$false
  contained_processes_stopped=$false; normal_uninstall=$false; installed_tree_removed=$false
  synthetic_userdata_retained=$false; default_shell_appdata_retention_verified=$false
  standard_user_installation_verified=$false; restricted_token_lifecycle_verified=$false
  registration_scope_verified=$false; offline_verified=$false; physical_ime_verified=$false
  automatic_update_verified=$false; forced_cleanup=$false; error=$null; tokens=@{}
  installer_sha256=$build.sha256; immutable_payload_rebuilt=$false
}
$owners = [Collections.Generic.Dictionary[int,object]]::new()
$result['process_tracking']='owned-native-jobs; ordinary same-token launch'
function Get-BoundedInventory([string]$Root) {
  $inventory=[ordered]@{root=$Root;files=0;bytes=0;complete=$false;elapsed_ms=0;longest_path=$null;longest_path_length=0}
  $clock=[Diagnostics.Stopwatch]::StartNew()
  try {
    if($Root -and (Test-Path -LiteralPath $Root)){
      $inventory.complete=$true
      foreach($path in [IO.Directory]::EnumerateFiles($Root,'*',[IO.SearchOption]::AllDirectories)){
        $file=[IO.FileInfo]::new($path);$inventory.files++;$inventory.bytes+=$file.Length
        if($path.Length -gt $inventory.longest_path_length){$inventory.longest_path=$path;$inventory.longest_path_length=$path.Length}
        if($inventory.files -ge 150000 -or $clock.ElapsedMilliseconds -ge 3000){$inventory.complete=$false;break}
      }
    }
  }catch{$inventory.complete=$false;$inventory.error=$_.Exception.Message}
  $inventory.elapsed_ms=$clock.ElapsedMilliseconds
  return $inventory
}
function Get-OwnedDiagnostic($Process) {
  $owner=$owners[$Process.Id]
  $snapshot=[ordered]@{pid=$Process.Id;has_exited=$Process.HasExited;exit_code=$null;active=$owner.ActiveProcessCount;job_pids=@($owner.ProcessIds());processes=@()}
  if($snapshot.has_exited){$snapshot.exit_code=$Process.ExitCode}
  try {
    if($snapshot.job_pids.Count){
      $filter=($snapshot.job_pids|ForEach-Object {'ProcessId='+[int]$_}) -join ' OR '
      $snapshot.processes=@(Get-CimInstance Win32_Process -Filter $filter -OperationTimeoutSec 3 | ForEach-Object {
        $row=[ordered]@{pid=$_.ProcessId;parent_pid=$_.ParentProcessId;path=$_.ExecutablePath;command=$_.CommandLine;cpu_kernel=$_.KernelModeTime;cpu_user=$_.UserModeTime;read_bytes=$_.ReadTransferCount;write_bytes=$_.WriteTransferCount;window_title=$null}
        try{$window=Get-Process -Id $_.ProcessId -ErrorAction Stop;$row.window_title=$window.MainWindowTitle}catch{$row.window_error=$_.Exception.Message}
        $row
      })
    }
  }catch{$snapshot.process_query_error=$_.Exception.Message}
  $snapshot.install_inventory=Get-BoundedInventory $install
  $snapshot.temp_inventory=Get-BoundedInventory $envMap.TEMP
  try{$snapshot.disk_free_bytes=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($install)).AvailableFreeSpace}catch{$snapshot.disk_query_error=$_.Exception.Message}
  try{$snapshot.owned_windows=[LifecycleProcessOwner]::ReadOwnedWindowText([int[]]$snapshot.job_pids)}catch{$snapshot.window_query_error=$_.Exception.Message}
  return $snapshot
}
function Start-OwnedProcess([string]$Exe,[string]$ArgumentLine,[string]$Cwd,[string]$Label) {
  Write-LifecycleCheckpoint ($Label+'-create-start') @{executable=$Exe}
  $pairs=@($envMap.Keys | ForEach-Object { $_ + '=' + [string]$envMap[$_] })
  try { $owner=[LifecycleProcessOwner]::StartSuspended($Exe,$ArgumentLine,$Cwd,[string[]]$pairs) }
  catch { $result['last_start_evidence']=[LifecycleProcessOwner]::LastStartEvidence; throw }
  $proc=$owner.Process
  $owners.Add($proc.Id,$owner)
  # The child cannot exit or spawn before its actual token is observed.
  $token=[RestrictedTokenLauncher]::InspectProcessToken($proc.Id)
  $result.tokens[$Label]=$token
  if ($pins.lifecycleMode -eq 'restricted-token-same-user' -and ($token.IsElevated -ne 0 -or $token.IntegritySid -ne 'S-1-16-8192')) { throw "Unexpected token for $Label" }
  Write-LifecycleCheckpoint ($Label+'-suspended-token-verified') @{pid=$proc.Id;start=[LifecycleProcessOwner]::LastStartEvidence}
  $owner.Resume()
  Write-LifecycleCheckpoint ($Label+'-resumed') @{pid=$proc.Id}
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
  $nextCheckpoint=0L
  while($true){
    $elapsed=$watch.ElapsedMilliseconds
    if($elapsed -ge $nextCheckpoint){Write-LifecycleCheckpoint 'owned-wait-progress' (Get-OwnedDiagnostic $Process);$nextCheckpoint=$elapsed+30000}
    $childExited=$Process.HasExited
    if($childExited -and $Process.ExitCode -ne 0){
      $diagnostic=Get-OwnedDiagnostic $Process;Write-LifecycleCheckpoint 'owned-child-nonzero' $diagnostic
      throw ('Owned child exited nonzero: pid='+$Process.Id+' exit='+$Process.ExitCode)
    }
    if($childExited -and $owners[$Process.Id].ActiveProcessCount -eq 0){Write-LifecycleCheckpoint 'owned-tree-finished' (Get-OwnedDiagnostic $Process);return $true}
    $remaining=($TimeoutSeconds*1000)-$watch.ElapsedMilliseconds
    if($remaining -le 0){
      $kind=if($childExited){'owned-job-not-empty-timeout'}else{'owned-child-timeout'}
      $diagnostic=Get-OwnedDiagnostic $Process;Write-LifecycleCheckpoint $kind $diagnostic
      throw ($kind+': pid='+$Process.Id+' exit='+$diagnostic.exit_code+' active='+$diagnostic.active+' job_pids='+($diagnostic.job_pids -join ','))
    }
    if($childExited){Start-Sleep -Milliseconds ([Math]::Min(500,$remaining))}else{[void]$Process.WaitForExit([int][Math]::Min(500,$remaining))}
  }
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
  # /currentuser /S install keeps runAfterFinish false and requests no elevation.
  $installProc=Start-OwnedProcess $installer "/currentuser /S /D=$install" $state 'installer'
  if (-not (Wait-OwnedProcess $installProc 240)) { throw 'Ordinary NSIS install failed or timed out' }
  $result.installed=$true
  Write-LifecycleCheckpoint 'installation-finished' $null
  $manifestFile=Join-Path $evidenceRoot $pins.evidenceFiles.structure.path
  $structure=Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
  $expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($row in $structure.files) { [void]$expected.Add($row.path) }
  # Only the exact NSIS package marker and root uninstaller may be extra; every payload file and
  # exact membership are still checked independently against frozen evidence.
  Write-LifecycleCheckpoint 'installed-membership-start' $null
  $extra=@(Get-ChildItem -LiteralPath $install -Recurse -Force -File | Where-Object {
    $relative=[IO.Path]::GetRelativePath($install,$_.FullName).Replace('\','/')
    # NSIS creates this exact marker; the shared tree verifier admits its bytes.
    -not $expected.Contains($relative) -and $relative -cne 'resources/package-type'
  })
  if ($extra.Count -ne 1 -or $extra[0].DirectoryName -ine $install -or $extra[0].Name -notmatch '^Uninstall [^\\/]+\.exe$') { throw 'Unreviewed installed-file additions; do not execute an unknown uninstaller' }
  $uninstaller=$extra[0].FullName
  Write-LifecycleCheckpoint 'installed-tree-before-launch-start' $null
  & $python -I -S -B $verifierPath tree --contract $contractPath --evidence $evidenceRoot --root $install --uninstaller $extra[0].Name --output (Join-Path $out 'installed-payload-before-launch.json')
  if ($LASTEXITCODE) { throw 'Installed payload bytes/membership differ' }
  $bytesAdmitted=$true; $result.every_installed_payload_file_verified=$true
  Write-LifecycleCheckpoint 'installed-tree-before-launch-finished' $null
  $exe=Join-Path $install 'LuhengOfficeAgent.exe'
  $runtime=Get-Content -LiteralPath (Join-Path $install 'resources/agent-payload/manifest.json') -Raw | ConvertFrom-Json
  $backendExe=[IO.Path]::GetFullPath((Join-Path (Join-Path $install 'resources/agent-payload') $runtime.runtime.storePython))
  $app=Start-OwnedProcess $exe '' $state 'desktop'
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
  Write-LifecycleCheckpoint 'native-window-and-health-verified' @{health_version=$result.health_version;backend_pid=$result.backend_pid}
  Add-Type -AssemblyName System.Drawing
  $rect=[LuhengWindowRect+RECT]::new()
  if (-not [LuhengWindowRect]::GetWindowRect($window.MainWindowHandle,[ref]$rect)) { throw 'Native window rectangle unavailable' }
  $width=$rect.Right-$rect.Left; $height=$rect.Bottom-$rect.Top
  if ($width -le 0 -or $height -le 0) { throw 'Native window has invalid dimensions' }
  $bitmap=[Drawing.Bitmap]::new($width,$height); $graphics=[Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,[Drawing.Size]::new($width,$height)); $bitmap.Save((Join-Path $out 'installed-native-window.png'),[Drawing.Imaging.ImageFormat]::Png) } finally { $graphics.Dispose(); $bitmap.Dispose() }
  $result.normal_window_close=$window.CloseMainWindow()
  if (-not $result.normal_window_close -or -not $window.WaitForExit(30000)) { throw 'Normal installed window exit failed' }
  if (-not $owners[$app.Id].WaitForEmpty(30000)) { throw 'Contained process remained after normal exit' }
  $result.contained_processes_stopped=$true
  Write-LifecycleCheckpoint 'installed-tree-after-exit-start' $null
  & $python -I -S -B $verifierPath tree --contract $contractPath --evidence $evidenceRoot --root $install --uninstaller ([IO.Path]::GetFileName($uninstaller)) --output (Join-Path $out 'installed-payload-after-exit.json')
  if ($LASTEXITCODE) { throw 'Installed payload changed during launch/exit' }
} catch { $result.error=$_.Exception.Message;Write-LifecycleCheckpoint 'lifecycle-failed-before-cleanup' @{error=$result.error} } finally {
  # Do not confuse forced cleanup with graceful success. Jobs contain only
  # children launched by this probe; no executable-name or reused-PID cleanup.
  try { Stop-OwnedProcesses } catch { $result.cleanup_error=$_.Exception.Message; if (-not $result.error) { $result.error=$_.Exception.Message } }
  if ($bytesAdmitted -and $uninstaller) {
    try {
      # Normal product uninstall only. No --updated, --delete-app-data, manual
      # registry deletion, file removal substitute, or app-data destruction.
      $uninstallProc=Start-OwnedProcess $uninstaller '/currentuser /S' $state 'uninstaller'
      if (-not (Wait-OwnedProcess $uninstallProc 180)) { throw 'Normal uninstall failed or timed out' }
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
  $required=$result.installed -and $result.every_installed_payload_file_verified -and $result.native_window -and $result.contained_backend_health -and $result.normal_window_close -and $result.contained_processes_stopped -and $result.normal_uninstall -and $result.installed_tree_removed -and $result.synthetic_userdata_retained -and -not $result.forced_cleanup -and -not $result.error
  if ($required -and $pins.lifecycleMode -eq 'restricted-token-same-user') { $result.restricted_token_lifecycle_verified=$true }
  $result['accepted_with_declared_limits']=$required
  Write-LifecycleCheckpoint 'lifecycle-complete' @{accepted=$required;error=$result.error;forced_cleanup=$result.forced_cleanup}
  $result | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $out 'installer-lifecycle.json') -Encoding utf8
  $result | ConvertTo-Json -Depth 20 | Write-Output
}
if (-not $required) { throw 'Native installer lifecycle failed or is incomplete; partial stages are not acceptance' }
