# Windows GitHub-hosted CI only. LOCKED 0.4.0 -> 0.5.0 per-user in-place upgrade, interrupted-work recovery
# (0.4.0 crash opened by 0.5.0, and 0.5.0 crashes across uninstall/reinstall) and same-profile reinstall.
# Never run on a developer/user computer: it installs, upgrades and uninstalls the real per-user NSIS app and
# owns %APPDATA%\LuhengOfficeAgent (refuses if it already exists). Installers must come from
# verify-windows-upgrade.mjs fetch (lock-bound). All enumeration fails closed; nothing unverified is killed
# or deleted.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InputDirectory,
  [string]$SourceRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$ReportDirectory = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'This upgrade acceptance is restricted to disposable GitHub-hosted Windows runners.'
}
if (-not $env:RUNNER_TEMP -or -not $env:APPDATA -or -not $env:RUNNER_TOOL_CACHE) { throw 'Runner temp, tool cache and app-data paths are required.' }

# ---------------------------------------------------------------- fail-closed path helpers
function Test-PathStrict([string]$Path) {
  # $false only when the item provably does not exist; any other error (access, I/O) stops the run.
  try { [void](Get-Item -LiteralPath $Path -Force -ErrorAction Stop); return $true }
  catch [System.Management.Automation.ItemNotFoundException] { return $false }
}
function Assert-RealDirectoryChain([string]$Path) {
  # Every component from the volume root down to $Path must exist as a real directory (no reparse point).
  $cursor = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Path))
  $volume = [IO.Path]::GetPathRoot($cursor)
  if (-not $volume -or $volume.StartsWith('\\')) { throw "Path is not on a local volume: $cursor" }
  while ($cursor) {
    $info = [IO.DirectoryInfo]::new($cursor)
    if (-not $info.Exists) { throw "Directory missing or not a directory: $cursor" }
    if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point in path chain: $cursor" }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}
function Assert-NoReparseTree([string]$Root) {
  # Own traversal: enumerates entries without following any reparse point; one found anywhere stops the run.
  $rootInfo = [IO.DirectoryInfo]::new($Root)
  if (-not $rootInfo.Exists) { throw "Owned tree missing: $Root" }
  if ($rootInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Owned tree root is a reparse point: $Root" }
  $stack = [Collections.Generic.Stack[IO.DirectoryInfo]]::new()
  $stack.Push($rootInfo)
  while ($stack.Count) {
    foreach ($entry in $stack.Pop().GetFileSystemInfos()) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point inside owned tree: $($entry.FullName)" }
      if ($entry -is [IO.DirectoryInfo]) { $stack.Push($entry) }
    }
  }
}

$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path
$InputDirectory = (Resolve-Path -LiteralPath $InputDirectory).Path
if (-not $ReportDirectory) { $ReportDirectory = Join-Path $SourceRoot 'upgrade-evidence' }
$ReportDirectory = [IO.Path]::GetFullPath($ReportDirectory)
if (Test-PathStrict $ReportDirectory) { throw 'Report directory already exists; refusing stale evidence.' }
[void](New-Item -ItemType Directory -Path $ReportDirectory)
$logDir = Join-Path $ReportDirectory 'logs'
[void](New-Item -ItemType Directory -Path $logDir)
$runnerTemp = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($env:RUNNER_TEMP))
$appDataRoot = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($env:APPDATA))
Assert-RealDirectoryChain $runnerTemp
$work = Join-Path $runnerTemp ('luheng-upgrade-' + [Guid]::NewGuid().ToString('N'))
if (Test-PathStrict $work) { throw 'Work directory collision; refusing.' }
[void](New-Item -ItemType Directory -Path $work)
Assert-RealDirectoryChain $work
$workMarker = Join-Path $work 'luheng-upgrade-ci-work-owner.txt'
$workMarkerText = 'Upgrade-acceptance work directory; run ' + $env:GITHUB_RUN_ID + ' token ' + [Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($workMarker, $workMarkerText)
$install = Join-Path $work 'installed'
$appExe = Join-Path $install 'Luheng Office Agent.exe'
$uninstaller = Join-Path $install 'Uninstall Luheng Office Agent.exe'
$uninstallerCopy = Join-Path $work 'uninstall-ci.exe'
$data = Join-Path $appDataRoot 'LuhengOfficeAgent'
$profileData = Join-Path $data 'data'
$marker = Join-Path $data 'luheng-upgrade-ci-owner.txt'
$markerText = 'Synthetic upgrade-acceptance profile; run ' + $env:GITHUB_RUN_ID + ' token ' + [Guid]::NewGuid().ToString('N')
$createdData = $false
$owned = [Collections.Generic.List[object]]::new()
$orphans = [Collections.Generic.List[object]]::new()
$script:logIndex = 0
$node = Join-Path $env:RUNNER_TOOL_CACHE 'node/24.21.0/x64/node.exe'
$node = [IO.Path]::GetFullPath($node)
$tool = Join-Path $SourceRoot 'scripts/verify-windows-upgrade.mjs'
$nativeTool = Join-Path $SourceRoot 'scripts/verify-windows-native.mjs'
$lockPath = Join-Path $SourceRoot 'scripts/windows-upgrade-lock.json'
$sevenZip = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @(@($currentSid, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique)
$utf8 = [Text.UTF8Encoding]::new($false)
$report = [ordered]@{
  status = 'windows-upgrade-acceptance-failed'; checkedAt = [DateTime]::UtcNow.ToString('o')
  fromVersion = '0.4.0'; toVersion = '0.5.0'; workflowCommit = $env:GITHUB_SHA; runId = $env:GITHUB_RUN_ID
  runnerOS = $env:RUNNER_OS; runnerImage = $env:ImageOS; runnerImageVersion = $env:ImageVersion
  inputs = [ordered]@{}; registry = [ordered]@{}; acl = [ordered]@{}; stages = [ordered]@{}; orphanCommands = @(); error = $null; cleanupError = $null
  limitations = @(
    'Unsigned prototype: signature/SmartScreen, elevated or all-users install, downgrade, credential vault and multi-monitor not tested',
    'Mail effects use a counted synthetic SMTP connection injected at the MailService transport boundary (no real server, reserved example.com addresses)',
    'Controlled-browser side-effect facts in the 0.5.0 pending recovery profile are synthetic records; no browser session is started',
    'Results describe the locked 0.4.0 and 0.5.0 artifacts only and must not be reused for any other version')
}
function Add-CleanupError([string]$Message) {
  $report.cleanupError = if ($report.cleanupError) { $report.cleanupError + ' | ' + $Message } else { $Message }
}
function Assert-OwnedWork {
  Assert-RealDirectoryChain $runnerTemp
  Assert-RealDirectoryChain $work
  if ([IO.Path]::GetDirectoryName($work) -ine $runnerTemp) { throw 'Work directory is not a direct child of RUNNER_TEMP.' }
  if ([IO.File]::ReadAllText($workMarker) -cne $workMarkerText) { throw 'Work ownership marker changed.' }
  Assert-NoReparseTree $work
}
function Assert-OwnedData {
  Assert-RealDirectoryChain $data
  if ([IO.Path]::GetDirectoryName($data) -ine $appDataRoot) { throw 'Profile directory is not a direct child of APPDATA.' }
  if ([IO.File]::ReadAllText($marker) -cne $markerText) { throw 'Profile ownership marker changed; leaving profile in place.' }
  Assert-NoReparseTree $data
}

# ---------------------------------------------------------------- owned processes
function Start-OwnedProcess([string]$File, [string[]]$Arguments, [string]$RawArguments = '', [switch]$ElectronNode, [string]$LogName = '') {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $File; $info.WorkingDirectory = $work; $info.UseShellExecute = $false
  if ($RawArguments) { $info.Arguments = $RawArguments } else { foreach ($arg in $Arguments) { $info.ArgumentList.Add($arg) } }
  foreach ($key in @('ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','HIGHWAY_DESKTOP_DATA_DIR','HIGHWAY_CHROMIUM_PATH','CHROME_EXECUTABLE','CHROMIUM_PATH','GH_TOKEN','GITHUB_TOKEN')) { [void]$info.Environment.Remove($key) }
  $info.Environment['PSModulePath'] = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
  if ($ElectronNode) { $info.Environment['ELECTRON_RUN_AS_NODE'] = '1' }
  if ($LogName) { $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true; $info.StandardOutputEncoding = $utf8; $info.StandardErrorEncoding = $utf8 }
  $p = [Diagnostics.Process]::Start($info)
  $record = [pscustomobject]@{ Process = $p; Id = $p.Id; StartTimeUtc = $null; LogName = $LogName; Stdout = $null; Stderr = $null }
  $owned.Add($record)   # registered before anything else can fail; the held handle pins the PID
  if ($LogName) { $record.Stdout = $p.StandardOutput.ReadToEndAsync(); $record.Stderr = $p.StandardError.ReadToEndAsync() }
  $record.StartTimeUtc = $p.StartTime.ToUniversalTime()
  return $record
}
function Save-ProcessLog($Record) {
  if (-not $Record.LogName) { return }
  $name = $Record.LogName; $Record.LogName = ''
  if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($Record.Stdout, $Record.Stderr), 30000)) { throw "Output of $name did not close within 30s." }
  $script:logIndex++
  $base = Join-Path $logDir ('{0:D2}-{1}' -f $script:logIndex, $name)
  [IO.File]::WriteAllText("$base.out.log", $Record.Stdout.Result, $utf8)
  [IO.File]::WriteAllText("$base.err.log", $Record.Stderr.Result, $utf8)
  foreach ($text in @($Record.Stdout.Result, $Record.Stderr.Result)) { if ($text) { Write-Host $text.TrimEnd() } }
}
function Stop-OwnedProcess($Record) {
  if (-not $Record.Process.HasExited) {
    $Record.Process.Kill($true)
    if (-not $Record.Process.WaitForExit(15000)) { throw "Owned process $($Record.Id) did not exit after Kill." }
  }
}
function Wait-OwnedProcess($Record, [int]$Seconds, [int]$Expected = 0) {
  $name = $Record.LogName
  if (-not $Record.Process.WaitForExit($Seconds * 1000)) { Stop-OwnedProcess $Record; throw "Process $($Record.Id) $name exceeded ${Seconds}s." }
  $Record.Process.WaitForExit()
  Save-ProcessLog $Record
  if ($Record.Process.ExitCode -ne $Expected) { throw "Process $($Record.Id) $name exited $($Record.Process.ExitCode), expected $Expected." }
}
function Invoke-Node([string]$Name, [string[]]$Arguments, [int]$Seconds = 300) { Wait-OwnedProcess (Start-OwnedProcess -File $node -Arguments $Arguments -LogName $Name) $Seconds }
function Invoke-App([string]$Name, [string[]]$Arguments, [int]$Seconds = 300) { Wait-OwnedProcess (Start-OwnedProcess -File $appExe -Arguments (@($tool) + $Arguments) -ElectronNode -LogName $Name) $Seconds }
function Get-AppProcesses { return [Diagnostics.Process]::GetProcessesByName('Luheng Office Agent') }   # throws on enumeration errors
function Wait-NoAppProcess([int]$Seconds = 30) {
  # Fail closed: helpers that outlive a normal close are an error; nothing is killed here.
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while (@(Get-AppProcesses).Count) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Application helper processes did not exit after a normal close.' }
    Start-Sleep -Milliseconds 250
  }
}
function Get-ProcessIdentity([int]$ProcessId) {
  $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop)
  if ($rows.Count -eq 0) { return $null }
  if ($rows.Count -ne 1 -or -not $rows[0].CreationDate) { throw "Ambiguous process identity for PID $ProcessId." }
  $line = [string]$rows[0].CommandLine
  return [pscustomobject]@{
    pid = $ProcessId; parentProcessId = [int]$rows[0].ParentProcessId
    creationDateUtc = $rows[0].CreationDate.ToUniversalTime().ToString('o'); executablePath = [string]$rows[0].ExecutablePath
    commandLineSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($line))).ToLowerInvariant(); commandLine = $line
  }
}
function Get-ProcessSnapshot { return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) }
function Open-ProcessHandle([int]$ProcessId) {
  # Throws if the PID is not running. The returned object holds an OS handle; while it is open the PID cannot be reused.
  $p = [Diagnostics.Process]::GetProcessById($ProcessId)
  try { [void]$p.Handle } catch { $p.Dispose(); throw }
  return $p
}
function Stop-IdentifiedProcess($Expected, $Held = $null) {
  # Kill only through a held handle (the caller's, already bound to its snapshot row, or one opened here), after
  # re-verifying every recorded field against the CIM row of that same PID-pinned process.
  if ($Held) { $p = $Held } else { try { $p = Open-ProcessHandle $Expected.pid } catch [ArgumentException], [InvalidOperationException] { return 'exited-before-kill' } }
  try {
    $now = Get-ProcessIdentity $Expected.pid
    if (-not $now -or $p.HasExited) { return 'exited-before-kill' }
    foreach ($field in @('parentProcessId', 'creationDateUtc', 'executablePath', 'commandLineSha256')) {
      if ($now.$field -cne $Expected.$field) { throw "PID $($Expected.pid) no longer matches its recorded $field; refusing to kill it." }
    }
    $p.Kill()
    if (-not $p.WaitForExit(15000)) { throw "PID $($Expected.pid) did not exit after Kill." }
    return 'killed-after-identity-recheck'
  } finally { if (-not $Held) { $p.Dispose() } }
}
function Register-OrphanCommand($SeedRecord, $Seed) {
  # The crashed backend's in-flight command (pinned node.exe) is still running; record its exact identity.
  $id = Get-ProcessIdentity ([int]$Seed.childPid)
  if (-not $id) { throw "In-flight command PID $($Seed.childPid) is not running; crash state not reproduced." }
  if ($id.executablePath -ine $node) { throw 'In-flight command is not the pinned node.exe.' }
  if ($id.commandLine.IndexOf([string]$Seed.sentinels.command, [StringComparison]::Ordinal) -lt 0 -or $id.commandLine.IndexOf([string]$Seed.effects, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'In-flight command line lacks this seed''s unique marker or effects path.' }
  if ($id.parentProcessId -ne $SeedRecord.Id) { throw 'In-flight command was not started by the crashed seed process.' }
  if ([DateTime]::Parse($id.creationDateUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) -lt $SeedRecord.StartTimeUtc) { throw 'In-flight command predates the seed process.' }
  $record = [pscustomobject]@{ pid = $id.pid; parentProcessId = $id.parentProcessId; creationDateUtc = $id.creationDateUtc; executablePath = $id.executablePath; commandLineSha256 = $id.commandLineSha256; state = 'verified' }
  $orphans.Add($record)
  return $record
}
function Stop-OrphanCommand($Record) {
  if ($Record.state -ne 'verified') { return $Record.state }
  $Record.state = 'kill-attempted'
  $Record.state = Stop-IdentifiedProcess $Record
  return $Record.state
}
function Get-RowIdentity($Row) {
  return [pscustomobject]@{ pid = [int]$Row.ProcessId; parentProcessId = [int]$Row.ParentProcessId; creationDateUtc = $Row.CreationDate.ToUniversalTime().ToString('o'); executablePath = [string]$Row.ExecutablePath }
}
function Open-BoundDescendant($Row) {
  # Hold a handle FIRST, then prove the held process IS the snapshot row: handle StartTime = row CreationDate, and the
  # current CIM identity of the (now pinned) PID has the row's ParentProcessId and CreationDate. Otherwise never an anchor.
  $cpid = [int]$Row.ProcessId; $created = $Row.CreationDate.ToUniversalTime()
  try { $p = Open-ProcessHandle $cpid } catch [ArgumentException], [InvalidOperationException] { return [pscustomobject]@{ state = 'exited'; process = $null; identity = $null } }
  $now = Get-ProcessIdentity $cpid
  $bound = $now -and -not $p.HasExited -and [Math]::Abs(($p.StartTime.ToUniversalTime() - $created).Ticks) -le 10000 -and $now.parentProcessId -eq [int]$Row.ParentProcessId -and $now.creationDateUtc -ceq $created.ToString('o')
  if ($bound) { return [pscustomobject]@{ state = 'bound'; process = $p; identity = $now } }
  $exited = $p.HasExited; $p.Dispose()
  return [pscustomobject]@{ state = $(if ($exited) { 'exited' } else { 'pid-reused-or-changed' }); process = $null; identity = $now }
}
function Get-VerifiedDescendants {
  # Anchors are ONLY processes whose handle this run holds: owned processes (handle from Start) and descendants bound by
  # Open-BoundDescendant. A snapshot row joins the tree only below such an anchor (ParentProcessId = anchor PID and
  # CreationDate >= anchor start). Rows that cannot be bound, and everything below them, are reported, never killed
  # and never used to attribute further processes. Only bound rows of pinned executables are killable.
  $all = @(Get-ProcessSnapshot)
  $anchors = @{}; $unproven = @{}
  foreach ($r in $owned) { if ($r.StartTimeUtc) { $anchors[[int]$r.Id] = $r.StartTimeUtc } }
  $found = [Collections.Generic.List[object]]::new()
  try {
    do {
      $added = $false
      foreach ($c in $all) {
        $cpid = [int]$c.ProcessId; $ppid = [int]$c.ParentProcessId
        if ($anchors.ContainsKey($cpid) -or $unproven.ContainsKey($cpid) -or -not $c.CreationDate) { continue }
        $created = $c.CreationDate.ToUniversalTime()
        if ($anchors.ContainsKey($ppid)) {
          if ($created -lt $anchors[$ppid]) { continue }
          $b = Open-BoundDescendant $c
          if ($b.state -eq 'bound') {
            $anchors[$cpid] = $created; $added = $true
            $found.Add([pscustomobject]@{ identity = $b.identity; process = $b.process; reason = 'bound'; killable = ($b.identity.executablePath -ieq $appExe -or $b.identity.executablePath -ieq $node) })
            continue
          }
          $unproven[$cpid] = $created; $added = $true
          if ($b.state -ne 'exited') { $found.Add([pscustomobject]@{ identity = (Get-RowIdentity $c); process = $null; reason = $b.state; killable = $false }) }
        } elseif ($unproven.ContainsKey($ppid) -and $created -ge $unproven[$ppid]) {
          $unproven[$cpid] = $created; $added = $true
          $found.Add([pscustomobject]@{ identity = (Get-RowIdentity $c); process = $null; reason = 'ancestor-not-proven'; killable = $false })
        }
      }
    } while ($added)
  } catch { foreach ($f in $found) { if ($f.process) { $f.process.Dispose() } }; throw }
  return $found.ToArray()
}

# ---------------------------------------------------------------- registry (fail closed)
function Get-LuhengEntries {
  $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall', $false)
  if ($null -eq $root) { return }   # the per-user Uninstall key does not exist: explicitly zero entries
  try {
    $found = [Collections.Generic.List[object]]::new()
    foreach ($name in $root.GetSubKeyNames()) {
      $key = $root.OpenSubKey($name, $false)
      if ($null -eq $key) { throw "Uninstall subkey '$name' disappeared during enumeration." }
      try {
        $displayName = $key.GetValue('DisplayName', $null)
        if ($displayName -is [string] -and $displayName -like 'Luheng Office Agent*') {
          $found.Add([pscustomobject]@{ key = $name; displayName = $displayName; displayVersion = [string]$key.GetValue('DisplayVersion', ''); uninstallString = [string]$key.GetValue('UninstallString', '') })
        }
      } finally { $key.Dispose() }
    }
    return $found.ToArray()
  } finally { $root.Dispose() }
}
function Get-SingleEntry([string]$Version, [string]$ExpectedKey) {
  $entries = @(Get-LuhengEntries)
  if ($entries.Count -ne 1) { throw "Expected exactly one per-user Luheng uninstall entry, found $($entries.Count)." }
  $e = $entries[0]
  if ($e.displayVersion -ne $Version) { throw "Uninstall entry DisplayVersion is not $Version." }
  if ($ExpectedKey -and $e.key -ne $ExpectedKey) { throw 'Upgrade created a different uninstall entry instead of replacing the existing one.' }
  if ($e.uninstallString.IndexOf($install, [StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Uninstall entry does not point to the owned install directory.' }
  return [ordered]@{ key = $e.key; displayName = $e.displayName; displayVersion = $e.displayVersion; uninstallString = $e.uninstallString }
}

# ---------------------------------------------------------------- install / uninstall
function Assert-InstalledVersion([string]$Version) {
  if (-not (Test-PathStrict $appExe)) { throw 'Installed application EXE missing.' }
  Assert-OwnedWork
  $actual = (Get-Content -LiteralPath (Join-Path $install 'resources/backend/package.json') -Raw | ConvertFrom-Json).version
  if ($actual -ne $Version) { throw "Installed backend version $actual is not $Version." }
}
function Install-Locked([string]$Installer) {
  Assert-OwnedWork
  # /D= is LAST and unquoted; no --force-run, so the silent installer does not launch the app.
  Wait-OwnedProcess (Start-OwnedProcess -File $Installer -Arguments @() -RawArguments "/S /currentuser /D=$install") 300
}
function Invoke-Uninstall {
  Assert-OwnedWork
  if (-not (Test-PathStrict $uninstaller)) { throw 'No installed uninstaller available.' }
  if (Test-PathStrict $uninstallerCopy) { Remove-Item -LiteralPath $uninstallerCopy -Force }
  Copy-Item -LiteralPath $uninstaller -Destination $uninstallerCopy
  if ((Get-FileHash -LiteralPath $uninstaller).Hash -ne (Get-FileHash -LiteralPath $uninstallerCopy).Hash) { throw 'Uninstaller copy differs.' }
  # NSIS _?= must be LAST and unquoted; run an unchanged external copy (no detached self-copy).
  Wait-OwnedProcess (Start-OwnedProcess -File $uninstallerCopy -Arguments @() -RawArguments "/S /currentuser _?=$install") 180
  if (Test-PathStrict $appExe) { throw 'Uninstall left the application EXE.' }
  if (Test-PathStrict (Join-Path $install 'resources')) { throw 'Uninstall left the packaged resources.' }
}
function Expand-Reference([string]$Role, [string]$Installer) {
  # Reference payload = the app-64.7z archive embedded in the SAME locked installer.
  $root = Join-Path $work "reference-$Role"; $nsis = Join-Path $root 'nsis'; $app = Join-Path $root 'app'
  Wait-OwnedProcess (Start-OwnedProcess -File $sevenZip -Arguments @('x', '-y', "-o$nsis", $Installer) -LogName "7z-$Role-installer") 300
  $archive = Join-Path $nsis '$PLUGINSDIR/app-64.7z'
  if (-not (Test-PathStrict $archive)) { throw "Locked $Role installer has no `$PLUGINSDIR/app-64.7z payload." }
  Wait-OwnedProcess (Start-OwnedProcess -File $sevenZip -Arguments @('x', '-y', "-o$app", $archive) -LogName "7z-$Role-payload") 300
  Assert-NoReparseTree $root
  if (-not (Test-PathStrict (Join-Path $app 'Luheng Office Agent.exe'))) { throw "Reference payload for $Role lacks the app EXE." }
  return $app
}
function Write-Inventory([string]$Root, [string]$Name) {
  $out = Join-Path $work "$Name.json"
  Invoke-Node "inventory-$Name" @($tool, 'inventory', '--root', $Root, '--out', $out)
  return (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash
}
function Write-Snapshot([string]$Name) {
  $out = Join-Path $ReportDirectory "$Name.json"
  Invoke-Node "snapshot-$Name" @($tool, 'snapshot', '--data', $profileData, '--out', $out)
  return $out
}
function Assert-ProfileAcl([string]$Label) {
  # The app applies an explicit protected DACL (owner = user; user, SYSTEM, Administrators FullControl, CI|OI)
  # to data\artifacts via lib/private-directory.mjs. agent.sqlite has no explicit DACL: it inherits the
  # per-user profile ACL, so only the same three principals may appear there.
  $artifacts = Join-Path $profileData 'artifacts'
  $acl = Get-Acl -LiteralPath $artifacts
  if (-not $acl.AreAccessRulesProtected) { throw "$Label artifacts directory ACL is not protected from inheritance." }
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $currentSid) { throw "$Label artifacts directory is not owned by the current user." }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  if ($rules.Count -ne $allowedSids.Count) { throw "$Label artifacts directory has $($rules.Count) ACEs, expected $($allowedSids.Count)." }
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -notin $allowedSids -or $rule.AccessControlType -ne 'Allow' -or $rule.IsInherited -or $rule.FileSystemRights -ne 'FullControl' -or $rule.InheritanceFlags -ne $inheritance -or $rule.PropagationFlags -ne 'None') { throw "$Label artifacts directory has an unexpected ACE for $($rule.IdentityReference.Value)." }
  }
  $inherited = [ordered]@{}
  foreach ($path in @($profileData, (Join-Path $profileData 'agent.sqlite'))) {
    $a = Get-Acl -LiteralPath $path
    if ($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowedSids) { throw "$Label $path has an unexpected owner." }
    $sids = @($a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { if ($_.AccessControlType -ne 'Allow' -or $_.IdentityReference.Value -notin $allowedSids) { throw "$Label $path grants or denies access to $($_.IdentityReference.Value)." }; $_.IdentityReference.Value })
    $inherited[[IO.Path]::GetFileName($path)] = @($sids | Select-Object -Unique)
  }
  return [ordered]@{ artifactsProtected = $true; artifactsOwner = $currentSid; artifactsAces = $rules.Count; inheritedPrincipals = $inherited }
}
function Show-AppWindow([string]$Pattern, [string]$Forbidden, [string]$Label) {
  # Plain packaged launch: no inspector, remote debugging, test loader or sandbox switches.
  $ui = Start-OwnedProcess -File $appExe -Arguments @()
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    if ($ui.Process.HasExited) { throw "$Label desktop exited before showing its window (code $($ui.Process.ExitCode))." }
    $ui.Process.Refresh()
    if ($ui.Process.MainWindowHandle -ne 0 -and $ui.Process.MainWindowTitle -match $Pattern) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($ui.Process.MainWindowHandle -eq 0 -or $ui.Process.MainWindowTitle -notmatch $Pattern) { throw "Expected $Label window title was not shown." }
  if ($Forbidden -and $ui.Process.MainWindowTitle -match $Forbidden) { throw "$Label window still shows an old version title." }
  $title = $ui.Process.MainWindowTitle
  if (-not $ui.Process.CloseMainWindow()) { throw 'Native WM_CLOSE could not be sent to the app window.' }
  Wait-OwnedProcess $ui 30
  Wait-NoAppProcess
  $geometry = Get-Content -LiteralPath (Join-Path $data 'window-state.json') -Raw | ConvertFrom-Json
  if ($geometry.bounds.width -le 0 -or $geometry.bounds.height -le 0) { throw 'Normal close did not persist window geometry.' }
  return @{ title = $title; plainLaunch = $true; windowStatePersisted = $true }
}
function Invoke-CrashSeed([string]$Name, [string[]]$Arguments, [string]$SeedFile, [string]$Variant) {
  $p = Start-OwnedProcess -File $appExe -Arguments (@($tool) + $Arguments) -ElectronNode -LogName $Name
  if (-not $p.Process.WaitForExit(180000)) { Stop-OwnedProcess $p; throw "$Name did not reach its crash point in time." }
  $p.Process.WaitForExit()
  $code = $p.Process.ExitCode
  # Deliberate process.kill(self, 'SIGKILL') = TerminateProcess exit code 1 on Windows; script failures exit 2.
  if ($code -ne 1) { Save-ProcessLog $p; throw "$Name exited $code; expected the deliberate hard-kill exit code 1." }
  $seed = Get-Content -LiteralPath $SeedFile -Raw | ConvertFrom-Json
  if ($seed.status -ne 'seeded-before-kill' -or $seed.variant -ne $Variant) { Save-ProcessLog $p; throw "$Name did not record its crash point." }
  return [pscustomobject]@{ record = $p; seed = $seed; exitCode = $code }
}

try {
  if (-not (Test-PathStrict $node) -or -not ((Get-Item -LiteralPath $node -Force) -is [IO.FileInfo])) { throw 'Pinned setup-node executable is missing.' }
  $nodeVersion = (& $node --version).Trim()
  if ($LASTEXITCODE -ne 0 -or $nodeVersion -ne 'v24.21.0') { throw 'Pinned Node version does not match 24.21.0.' }
  Assert-RealDirectoryChain $appDataRoot
  if (Test-PathStrict $data) { throw 'Existing Luheng app data found; refusing to touch it.' }
  if (@(Get-LuhengEntries).Count) { throw 'Existing per-user Luheng installation found; refusing.' }
  if (@(Get-AppProcesses).Count) { throw 'A Luheng Office Agent process is already running; refusing.' }
  if (-not (Test-PathStrict $sevenZip)) { throw '7-Zip is required for reference payload binding; refusing to weaken the check.' }
  $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
  if ($lock.from.version -ne '0.4.0' -or $lock.to.version -ne '0.5.0') { throw 'Lock is not pinned to 0.4.0 -> 0.5.0.' }
  $report.stages.preflight = @{ node = $nodeVersion; existingData = $false; existingUninstallEntries = 0; runnerTempChain = 'real directories' }

  $inputs = Join-Path $work 'inputs'; [void](New-Item -ItemType Directory -Path $inputs)
  $installers = @{}
  foreach ($role in @('from', 'to')) {
    $entry = $lock.$role
    $expires = $entry.artifact.expiresAt
    if ($expires -is [DateTime]) {
      if ($expires.Kind -eq [DateTimeKind]::Unspecified) { throw "Locked $role expiry has no time zone." }
      $expiresUtc = $expires.ToUniversalTime()
    } else { $expiresUtc = [DateTimeOffset]::Parse([string]$expires, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
    if ($expiresUtc -le [DateTime]::UtcNow) { throw "Locked $role artifact expired; refusing." }
    $source = Join-Path $InputDirectory $entry.installer.name
    $item = Get-Item -LiteralPath $source -Force
    if ($item -isnot [IO.FileInfo] -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Locked $role installer is not a regular file." }
    $copy = Join-Path $inputs $entry.installer.name
    Copy-Item -LiteralPath $source -Destination $copy
    $copyItem = Get-Item -LiteralPath $copy -Force
    $hash = (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($copyItem.Length -ne [long]$entry.installer.bytes -or $hash -ne $entry.installer.sha256) { throw "Locked $role installer size/SHA-256 mismatch." }
    Invoke-Node "check-installer-$role" @($tool, 'check-installer', '--lock', $lockPath, '--role', $role, '--file', $copy)
    $installers[$role] = $copy
    $report.inputs[$role] = [ordered]@{ version = $entry.version; runId = $entry.runId; commit = $entry.commit; artifactId = $entry.artifact.id; name = $entry.installer.name; bytes = $copyItem.Length; sha256 = $hash; expiresAtUtc = $expiresUtc.ToString('o') }
  }
  $reference = @{ from = (Expand-Reference 'from' $installers.from); to = (Expand-Reference 'to' $installers.to) }
  $report.stages.lockedInputs = 'both installers re-verified (bytes + SHA-256) and reference payloads extracted from them'

  # ---- 1. install 0.4.0, seed a real profile and a crashed 0.4.0 profile through the installed 0.4 backend
  Install-Locked $installers.from
  Assert-InstalledVersion '0.4.0'
  $report.registry.after040Install = Get-SingleEntry '0.4.0' ''
  Invoke-Node 'bind-0.4.0' @($nativeTool, 'bind', $reference.from, $install, (Join-Path $ReportDirectory 'payload-0.4.0.json'))
  $report.stages.install040 = 'passed; payload bound to locked installer'
  [void](New-Item -ItemType Directory -Path $data)
  $createdData = $true
  Assert-RealDirectoryChain $data
  [IO.File]::WriteAllText($marker, $markerText)
  $seed040 = Join-Path $work 'seed-v040.json'
  Invoke-App 'seed-v04' @('seed-v04', '--install', $install, '--data', $profileData, '--out', $seed040)
  Copy-Item -LiteralPath $seed040 -Destination (Join-Path $ReportDirectory 'seed-v0.4.0.json')
  $report.acl.after040Seed = Assert-ProfileAcl '0.4.0 seed'
  $v04Root = Join-Path $work 'recovery-v04'
  [void](New-Item -ItemType Directory -Path $v04Root)
  $seedV04Recovery = Join-Path $work 'seed-recovery-v04.json'
  $crash = Invoke-CrashSeed 'seed-recovery-v04' @('seed-recovery-v04', '--install', $install, '--data', (Join-Path $v04Root 'data'), '--out', $seedV04Recovery) $seedV04Recovery 'v04-cross-version'
  Save-ProcessLog $crash.record
  $report.stages.recoverySeedV04 = @{ crashExitCode = $crash.exitCode; atCrash = $crash.seed.atCrash }
  [IO.File]::WriteAllText((Join-Path $data 'desktop-preferences.json'), '{"backgroundEnabled":false}' + "`n", $utf8)
  $report.stages.window040 = Show-AppWindow '路衡.*办公智能体.*v0\.4' '' '0.4.0'
  $before040 = Write-Snapshot 'db-v0.4.0'
  $inventoryBeforeUpgrade = Write-Inventory $data 'inventory-before-upgrade'

  # ---- 2. in-place upgrade to 0.5.0 at the same path
  Install-Locked $installers.to
  Assert-InstalledVersion '0.5.0'
  $report.registry.after050Upgrade = Get-SingleEntry '0.5.0' $report.registry.after040Install.key
  Invoke-Node 'bind-0.5.0-upgrade' @($nativeTool, 'bind', $reference.to, $install, (Join-Path $ReportDirectory 'payload-0.5.0-upgrade.json'))
  if ((Write-Inventory $data 'inventory-after-upgrade') -ne $inventoryBeforeUpgrade) { throw 'Upgrade installer changed the user profile.' }
  $report.stages.upgrade050 = 'passed; single uninstall entry replaced, no stale payload files, profile byte-identical'
  $upgradeReport = Join-Path $ReportDirectory 'upgrade.json'
  Invoke-App 'verify-upgrade' @('verify-upgrade', '--install', $install, '--data', $profileData, '--seed', $seed040, '--before', $before040, '--out', $upgradeReport) 600
  $report.acl.after050Upgrade = Assert-ProfileAcl '0.5.0 upgrade'
  foreach ($run in @(1, 2)) {
    Invoke-App "verify-recovery-v04-run$run" @('verify-recovery-v04', '--install', $install, '--data', (Join-Path $v04Root 'data'), '--seed', $seedV04Recovery, '--run', "$run", '--out', (Join-Path $ReportDirectory "recovery-v04-run$run.json"))
  }
  $report.stages.recoveryV04 = '0.4.0 crash state (queued/running/awaiting/sent/unknown/sending) recovered by 0.5.0 in two independent processes; no SMTP or model call'
  $verified050 = Write-Snapshot 'db-v0.5.0-verified'
  $report.stages.window050 = Show-AppWindow '路衡.*办公智能体.*v0\.5' 'v0\.4' '0.5.0'
  $relaunched050 = Write-Snapshot 'db-v0.5.0-relaunched'
  Invoke-Node 'compare-relaunch' @($tool, 'compare', '--before', $verified050, '--after', $relaunched050, '--out', (Join-Path $ReportDirectory 'compare-relaunch.json'))
  $report.stages.upgradeData = 'migrations 1..4, rule-bound role migration, data/artifacts intact, catch-up fired once, relaunch steady, integrity_check ok'

  # ---- 3. interrupted 0.5 work on owned synthetic profiles (hard kill, WAL kept)
  $recovery = [ordered]@{}
  foreach ($variant in @('pending', 'full')) {
    $root = Join-Path $work "recovery-$variant"; $files = Join-Path $root 'files'
    [void](New-Item -ItemType Directory -Path $files)
    Assert-RealDirectoryChain $files
    $seedFile = Join-Path $work "seed-recovery-$variant.json"
    $crash = Invoke-CrashSeed "seed-recovery-$variant" @('seed-recovery', '--install', $install, '--data', (Join-Path $root 'data'), '--files', $files, '--variant', $variant, '--node', $node, '--out', $seedFile) $seedFile $variant
    $orphan = 'none'
    if ($variant -eq 'full') {
      $orphanRecord = Register-OrphanCommand $crash.record $crash.seed
      $orphan = Stop-OrphanCommand $orphanRecord
      if ($orphan -ne 'killed-after-identity-recheck') { throw "In-flight command cleanup ended '$orphan'." }
    }
    Save-ProcessLog $crash.record
    $recovery[$variant] = @{ root = $root; seed = $seedFile }
    $report.stages["recoverySeed-$variant"] = @{ crashExitCode = $crash.exitCode; orphanCommand = $orphan }
  }
  $report.orphanCommands = @($orphans | ForEach-Object { [ordered]@{ pid = $_.pid; parentProcessId = $_.parentProcessId; creationDateUtc = $_.creationDateUtc; executablePath = $_.executablePath; commandLineSha256 = $_.commandLineSha256; state = $_.state } })

  # ---- 4. uninstall: binaries gone, every profile untouched
  $profiles = [ordered]@{ main = $data; 'recovery-v04' = $v04Root; 'recovery-pending' = $recovery.pending.root; 'recovery-full' = $recovery.full.root }
  $inventories = @{}
  foreach ($name in $profiles.Keys) { $inventories[$name] = Write-Inventory $profiles[$name] "inventory-$name-before-uninstall" }
  Invoke-Uninstall
  if (@(Get-LuhengEntries).Count) { throw 'Uninstall left a per-user uninstall entry.' }
  foreach ($name in $profiles.Keys) { if ((Write-Inventory $profiles[$name] "inventory-$name-after-uninstall") -ne $inventories[$name]) { throw "Uninstall changed profile $name." } }
  $report.stages.uninstall = 'passed; EXE/resources and uninstall entry removed, all four profiles byte-identical'

  # ---- 5. reinstall 0.5.0 on the same profiles
  Install-Locked $installers.to
  Assert-InstalledVersion '0.5.0'
  $report.registry.after050Reinstall = Get-SingleEntry '0.5.0' ''
  Invoke-Node 'bind-0.5.0-reinstall' @($nativeTool, 'bind', $reference.to, $install, (Join-Path $ReportDirectory 'payload-0.5.0-reinstall.json'))
  foreach ($name in $profiles.Keys) { if ((Write-Inventory $profiles[$name] "inventory-$name-after-reinstall") -ne $inventories[$name]) { throw "Reinstall changed profile $name." } }
  foreach ($variant in @('pending', 'full')) {
    foreach ($run in @(1, 2)) {
      Invoke-App "verify-recovery-$variant-run$run" @('verify-recovery', '--install', $install, '--data', (Join-Path $recovery[$variant].root 'data'), '--seed', $recovery[$variant].seed, '--run', "$run", '--out', (Join-Path $ReportDirectory "recovery-$variant-run$run.json"))
    }
  }
  Invoke-App 'verify-recovery-v04-run3' @('verify-recovery-v04', '--install', $install, '--data', (Join-Path $v04Root 'data'), '--seed', $seedV04Recovery, '--run', '3', '--out', (Join-Path $ReportDirectory 'recovery-v04-run3.json'))
  $report.stages.recovery = 'pending/full 0.5.0 profiles (two restarts each) and the 0.4.0 crash profile (third restart): no replay across reinstall'
  Invoke-App 'verify-reinstall' @('verify-reinstall', '--install', $install, '--data', $profileData, '--before', $relaunched050, '--manifest', $upgradeReport, '--out', (Join-Path $ReportDirectory 'reinstall.json'))
  $report.acl.after050Reinstall = Assert-ProfileAcl '0.5.0 reinstall'
  $report.stages.windowAfterReinstall = Show-AppWindow '路衡.*办公智能体.*v0\.5' 'v0\.4' '0.5.0 reinstalled'
  $report.stages.reinstall = 'same profile usable; artifacts match the manifest byte-for-byte; permission still required; no duplicate schedule/task execution'

  # ---- 6. evidence/log scan for private markers and their unkeyed digests
  $seedList = Join-Path $work 'seed-list.json'
  [IO.File]::WriteAllText($seedList, (ConvertTo-Json -InputObject @($seedV04Recovery, $recovery.pending.seed, $recovery.full.seed)), $utf8)
  Invoke-Node 'scan-evidence' @($tool, 'scan', '--root', $ReportDirectory, '--seeds', $seedList, '--out', (Join-Path $work 'evidence-scan.json'))
  $report.stages.evidenceScan = 'no private markers or digests in reports/logs'
  $report.status = 'windows-upgrade-acceptance-passed'
} catch {
  $report.error = $_.Exception.Message
  Write-Warning $report.error
} finally {
  foreach ($r in @($owned)) { try { Stop-OwnedProcess $r } catch { Add-CleanupError "owned process $($r.Id): $($_.Exception.Message)" } }
  foreach ($o in @($orphans)) { try { [void](Stop-OrphanCommand $o) } catch { Add-CleanupError "orphan command $($o.pid): $($_.Exception.Message)" } }
  $descendants = @()
  try {
    $descendants = @(Get-VerifiedDescendants)
    foreach ($d in $descendants) {
      if (-not $d.killable) { Add-CleanupError "unverified descendant PID $($d.identity.pid) ($($d.identity.executablePath); $($d.reason)) left running; not killed"; continue }
      try { [void](Stop-IdentifiedProcess $d.identity $d.process) } catch { Add-CleanupError "descendant $($d.identity.pid): $($_.Exception.Message)" }
    }
  } catch { Add-CleanupError "descendant enumeration: $($_.Exception.Message)" }
  finally { foreach ($d in $descendants) { if ($d.process) { $d.process.Dispose() } } }
  try { if (Test-PathStrict $appExe) { Invoke-Uninstall } } catch { Add-CleanupError "uninstall: $($_.Exception.Message)" }
  # Delete ONLY the profile this run created, only with its marker intact and no reparse point anywhere.
  if ($createdData) {
    try { Assert-OwnedData; Remove-Item -LiteralPath $data -Recurse -Force } catch { Add-CleanupError "profile cleanup: $($_.Exception.Message)" }
  }
  # Keep the owned work directory on failure for diagnosis; the hosted runner discards it.
  if ($report.status -eq 'windows-upgrade-acceptance-passed' -and -not $report.cleanupError) {
    try { Assert-OwnedWork; Remove-Item -LiteralPath $work -Recurse -Force } catch { Add-CleanupError "work cleanup: $($_.Exception.Message)" }
  }
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $ReportDirectory 'upgrade-acceptance.json') -Encoding utf8
}
$report | ConvertTo-Json -Depth 12
if ($report.status -ne 'windows-upgrade-acceptance-passed' -or $report.cleanupError) { exit 1 }
exit 0
