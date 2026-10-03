# Visible, real NSIS beta upgrade observer for a disposable GitHub-hosted Windows runner.
# The real Beta1 app must already have used shell.openPath(exactDownloadedExe), without flags.
# This helper NEVER starts an installer, changes a profile, writes a journal or dismisses a warning.
# It invokes only owned NSIS Next/Install/Finish, plus unchecking the exact observed Run checkbox.
# Different-image extracted/elevated children are NOT authorized by parentage and fail closed.
# Preparation is not a Windows result. Completion here is wizard completion, not an upgrade pass.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExpectedInstaller,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedHash,
  [Parameter(Mandatory = $true)][ValidateSet('0.6.0-beta.2','0.6.0-beta.4')][string]$Version,
  [Parameter(Mandatory = $true)][string]$ExpectedInstallDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$StartedAfterUtc,
  [int]$ExpectedAppPid = 0,
  [string]$ExpectedAppStartUtc = '',
  [string]$ExpectedAppHash = '',
  [ValidateRange(30,900)][int]$TimeoutSeconds = 300
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or
    $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Only a disposable GitHub-hosted Windows runner may perform this owned visible wizard test.'
}
if (-not [Environment]::UserInteractive -or [IntPtr]::Size -ne 8) {
  throw 'An interactive 64-bit Windows desktop is required; a headless/session-zero run is not a visible wizard pass.'
}
if (-not $env:APPDATA -or -not $env:RUNNER_TEMP) { throw 'APPDATA and RUNNER_TEMP are required.' }
$script:utf8 = [Text.UTF8Encoding]::new($false)
$script:processes = [Collections.Generic.List[object]]::new()
$script:captures = 0
$script:events = [Collections.Generic.List[object]]::new()
$script:report = [ordered]@{
  schema = 1; status = 'owned-installer-wizard-failed'; actualWindows = $true
  installerExecutedByHelper = $false; wizardCompleted = $false; upgradePassed = $false
  installerPath = $ExpectedInstaller; installerSha256 = $ExpectedHash.ToLowerInvariant(); securityPromptBypassed = $false
  checkedAtUtc = [DateTime]::UtcNow.ToString('o'); version = $Version
  runId = $env:GITHUB_RUN_ID; commit = $env:GITHUB_SHA
  expected = [ordered]@{}; appExit = $null; journalAfterAppExit = $null
  registrationBefore = $null; registrationAfter = $null; runAfterFinishDisabled = $false
  processes = @(); actions = @(); error = $null; evidenceError = $null
  limitations = @(
    'Wizard completion must be followed by exact installed Beta2 payload and persisted-profile checks.',
    'Only the locked downloaded image or a proven same-byte child may own actionable UI.',
    'Any different-hash inner executable, OS warning, elevation, unexpected modal or inaccessible desktop stops this helper.',
    'The requested finish Run checkbox is unchecked so the separate verification phase owns the first Beta2 launch.',
    'Default runAfterFinish=true relaunch behavior is not covered by this test.',
    'The helper does not click Cancel, Back, Browse, security warnings or other-process windows.'
  )
}
function Write-Json([string]$Path, $Value) {
  [IO.File]::WriteAllText($Path, ($Value | ConvertTo-Json -Depth 24), $script:utf8)
}
function Full-LocalPath([string]$Path) {
  if (-not [IO.Path]::IsPathRooted($Path)) { throw "An absolute local path is required: $Path" }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full.StartsWith('\\') -or $full.StartsWith('\\?\') -or $full.Substring(2).Contains(':')) {
    throw 'UNC, device paths and alternate data streams are not permitted.'
  }
  return $full
}
function Assert-RealChain([string]$Path, [switch]$File) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($File -and $item -isnot [IO.FileInfo]) { throw "Expected a regular file: $Path" }
  if (-not $File -and $item -isnot [IO.DirectoryInfo]) { throw "Expected a directory: $Path" }
  $cursor = $item
  while ($null -ne $cursor) {
    if ($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse-point path refused: $($cursor.FullName)" }
    if ($cursor -is [IO.FileInfo]) { $cursor = $cursor.Directory } else { $cursor = $cursor.Parent }
  }
}
function Parse-Utc([string]$Text) {
  if ($Text -notmatch '(Z|\+00:00)$') { throw 'A round-trip explicit UTC timestamp is required.' }
  return [DateTime]::Parse($Text, [Globalization.CultureInfo]::InvariantCulture,
    [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}
function Hash-Stream([IO.FileStream]$Stream) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $Stream.Position = 0
    return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-','').ToLowerInvariant()
  } finally { $Stream.Position = 0; $sha.Dispose() }
}
function Assert-ImageVersion([string]$Path) {
  $meta = [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
  if ($meta.ProductName -cne 'Luheng Office Agent' -or $meta.ProductVersion -cne $Version) {
    throw "The image's ProductName/ProductVersion does not match the locked beta: $Path"
  }
}
$ExpectedInstaller = Full-LocalPath $ExpectedInstaller
$ExpectedInstallDirectory = Full-LocalPath $ExpectedInstallDirectory
$OutputDirectory = Full-LocalPath $OutputDirectory
$ExpectedHash = $ExpectedHash.ToLowerInvariant()
$startedAfter = Parse-Utc $StartedAfterUtc
if ($startedAfter -gt [DateTime]::UtcNow -or $startedAfter -lt [DateTime]::UtcNow.AddMinutes(-15)) {
  throw 'The Shell observation timestamp is future-dated or more than 15 minutes old.'
}
Assert-RealChain $ExpectedInstaller -File
Assert-RealChain $ExpectedInstallDirectory
if ([IO.Path]::GetFileName($ExpectedInstaller) -cne 'installer.exe' -or
    [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($ExpectedInstaller)) -cnotmatch '^[a-f0-9]{32}$') {
  throw 'The app cache must retain its actual fixed installer.exe name inside a random 32-hex download directory.'
}
if ([IO.Path]::GetFileName($ExpectedInstallDirectory) -cne 'Luheng Office Agent') {
  throw 'The expected current-user install directory must retain the packaged product directory name.'
}
$expectedAppExe = Join-Path $ExpectedInstallDirectory 'Luheng Office Agent.exe'
$stateRoot = Full-LocalPath (Join-Path $env:APPDATA 'LuhengOfficeAgent')
$cacheRoot = Join-Path $stateRoot 'updates'
$journalPath = Join-Path $cacheRoot 'pending.json' # actual desktop/update-files.cjs, schema 1
Assert-RealChain $cacheRoot
$cachePrefix = $cacheRoot.TrimEnd('\') + '\'
if (-not $ExpectedInstaller.StartsWith($cachePrefix, [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($ExpectedInstaller)) -ine $cacheRoot) {
  throw 'ExpectedInstaller must be the app download under the actual default profile updates cache.'
}
if ((Get-Item -LiteralPath $ExpectedInstaller).Length -le 0) { throw 'The expected installer is empty.' }
Assert-ImageVersion $ExpectedInstaller
if ([IO.Directory]::Exists($OutputDirectory) -or [IO.File]::Exists($OutputDirectory)) {
  throw 'OutputDirectory already exists; refusing stale or mixed evidence.'
}
Assert-RealChain ([IO.Path]::GetDirectoryName($OutputDirectory))
if ($OutputDirectory.StartsWith($ExpectedInstallDirectory + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $OutputDirectory.StartsWith($stateRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Evidence must be outside the installed app and the owned profile.'
}
[void][IO.Directory]::CreateDirectory($OutputDirectory)
$script:report.expected = [ordered]@{
  installerPath = $ExpectedInstaller; installerSha256 = $ExpectedHash; version = $Version
  installDirectory = $ExpectedInstallDirectory; startedAfterUtc = $startedAfter.ToString('o')
  journalPath = $journalPath; beta1Pid = $ExpectedAppPid
}
$installerFile = $null
try {
  # A held read handle denies file writes/deletion until the wizard's process has exited.
  $installerFile = [IO.File]::Open($ExpectedInstaller, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  if ((Hash-Stream $installerFile) -cne $ExpectedHash) { throw 'Downloaded installer SHA256 differs from the artifact lock.' }
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedNsisUi {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr state);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint message, UIntPtr wp, StringBuilder lp, uint flags, uint timeout, out UIntPtr result);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder text, ref int size);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder text, uint size, out uint needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string cmdline, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static IntPtr[] Windows() {
    var list = new List<IntPtr>();
    if (!EnumWindows((h,s) => { if(IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero)) throw new Win32Exception();
    return list.ToArray();
  }
  public static IntPtr[] Children(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h,s) => { list.Add(h); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  public static int Pid(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return checked((int)pid); }
  public static string Class(IntPtr hwnd) { var b=new StringBuilder(512); if(GetClassName(hwnd,b,b.Capacity)==0) throw new Win32Exception(); return b.ToString(); }
  public static string Title(IntPtr hwnd) { var b=new StringBuilder(4096); GetWindowText(hwnd,b,b.Capacity); return b.ToString(); }
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", SetLastError=true)] static extern IntPtr ReadMessageTimeout(IntPtr hwnd, uint message, UIntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
  public static int CheckState(IntPtr hwnd) {
    UIntPtr result;
    if(ReadMessageTimeout(hwnd,0x00F0,UIntPtr.Zero,IntPtr.Zero,0x0002,1000,out result)==IntPtr.Zero) throw new Win32Exception("BM_GETCHECK failed.");
    return checked((int)result.ToUInt64());
  }
  public static string ControlText(IntPtr hwnd) {
    var b=new StringBuilder(32768); UIntPtr result;
    if(SendMessageTimeout(hwnd, 0x000D, (UIntPtr)b.Capacity, b, 0x0002, 1000, out result)==IntPtr.Zero) throw new Win32Exception("Control WM_GETTEXT timed out or failed.");
    return b.ToString();
  }
  public static string Image(IntPtr process) {
    var b=new StringBuilder(32768); int size=b.Capacity;
    if(!QueryFullProcessImageName(process,0,b,ref size)) throw new Win32Exception();
    return b.ToString();
  }
  static string DesktopName(IntPtr handle) {
    if(handle==IntPtr.Zero) throw new Win32Exception("Input desktop is inaccessible, possibly a secure desktop.");
    var b=new StringBuilder(1024); uint needed;
    if(!GetUserObjectInformation(handle,2,b,(uint)b.Capacity*2,out needed)) throw new Win32Exception();
    return b.ToString();
  }
  public static string AssertInputDesktop() {
    var input=OpenInputDesktop(0,false,0x0001);
    try {
      var a=DesktopName(input); var b=DesktopName(GetThreadDesktop(GetCurrentThreadId()));
      if(a!="Default" || b!="Default" || a!=b) throw new InvalidOperationException("Unexpected or secure input desktop: " + a + "/" + b);
      return a;
    } finally { if(input!=IntPtr.Zero) CloseDesktop(input); }
  }
  public static string[] Args(string cmdline) {
    int count; var p=CommandLineToArgvW(cmdline,out count);
    if(p==IntPtr.Zero) throw new Win32Exception();
    try { var list=new string[count]; for(int i=0;i<count;i++) list[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return list; }
    finally { LocalFree(p); }
  }
}
'@
  function Snapshot-Processes { return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop) }
  function Get-Identity([int]$Id) {
    $rows = @(Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$Id" -ErrorAction Stop)
    if ($rows.Count -eq 0) { return $null }
    if ($rows.Count -ne 1 -or -not $rows[0].CreationDate -or -not $rows[0].ExecutablePath -or -not $rows[0].CommandLine) {
      throw "Inaccessible or ambiguous process identity: $Id"
    }
    return $rows[0]
  }
  function Log-Event([string]$Kind, $Value) {
    $entry = [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); kind = $Kind; value = $Value }
    $script:events.Add($entry)
    Write-Json (Join-Path $OutputDirectory 'events.json') @($script:events.ToArray())
  }
  function Save-Screenshot([string]$Label) {
    # Never switch/bypass a secure input desktop to obtain a screenshot.
    [void][OwnedNsisUi]::AssertInputDesktop()
    $script:captures++
    $name = '{0:D3}-{1}.png' -f $script:captures,$Label
    $bounds = [Windows.Forms.SystemInformation]::VirtualScreen
    if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'Desktop has no capturable bounds.' }
    $bitmap = [Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bounds.Size,[Drawing.CopyPixelOperation]::SourceCopy)
      $bitmap.Save((Join-Path $OutputDirectory $name),[Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
    Log-Event 'screenshot' @{ file = $name; x = $bounds.Left; y = $bounds.Top; width = $bounds.Width; height = $bounds.Height }
    return $name
  }
  function Inspect-Windows {
    $result = @()
    foreach ($h in [OwnedNsisUi]::Windows()) {
      if (-not [OwnedNsisUi]::IsWindow($h)) { continue }
      try {
        $result += [pscustomobject]@{
          handle = $h.ToInt64(); pid = [OwnedNsisUi]::Pid($h); class = [OwnedNsisUi]::Class($h)
          title = [OwnedNsisUi]::Title($h); enabled = [OwnedNsisUi]::IsWindowEnabled($h)
          owner = [OwnedNsisUi]::GetWindow($h,4).ToInt64()
        }
      } catch {
        if (-not [OwnedNsisUi]::IsWindow($h)) { continue }; throw
      }
    }
    return $result
  }
  function Assert-NoPrompt($Windows) {
    [void][OwnedNsisUi]::AssertInputDesktop()
    $foreground = [OwnedNsisUi]::GetForegroundWindow()
    foreach ($window in $Windows) {
      if (-not [OwnedNsisUi]::IsWindow([IntPtr]::new([long]$window.handle))) { continue }
      # Any foreground foreign dialog is a blocker; named OS warnings are blockers even in the background.
      $known = @($script:processes | Where-Object { $_.id -eq $window.pid }).Count -gt 0
      $warningTitle = $window.title -match '(?i)^(Open File - Security Warning|Windows Security|User Account Control|Windows protected your PC|Windows Defender SmartScreen|Security Warning|用户帐户控制|Windows 安全中心|打开文件 - 安全警告)$'
      $procName = ''
      try { $procName = [Diagnostics.Process]::GetProcessById($window.pid).ProcessName } catch [ArgumentException] {}
      if ($warningTitle -or $procName -match '^(?i:consent|smartscreen)$' -or
          (-not $known -and $window.class -eq '#32770' -and $window.handle -eq $foreground.ToInt64())) {
        Log-Event 'blocked-other-process-or-os-prompt' $window
        throw 'An OS/security or other-process foreground prompt is present; no control will be invoked.'
      }
    }
  }
  function Pin-Installer($Row, $Parent = $null) {
    $image = Full-LocalPath ([string]$Row.ExecutablePath)
    if ($null -eq $Parent -and $image -ine $ExpectedInstaller) { throw 'Only the exact Shell-opened installer path may be the root.' }
    if ($Row.CreationDate.ToUniversalTime() -lt $startedAfter) { throw 'Installer process predates the native-confirm observation bound.' }
    $held = [Diagnostics.Process]::GetProcessById([int]$Row.ProcessId)
    $imageFile = $null
    try {
      [void]$held.Handle
      $now = Get-Identity $held.Id
      if ($null -eq $now -or $held.HasExited) { throw 'Installer exited before its identity could be pinned.' }
      if ([Math]::Abs(($held.StartTime.ToUniversalTime() - $now.CreationDate.ToUniversalTime()).Ticks) -gt 10000 -or
          $now.CreationDate -ne $Row.CreationDate -or $now.ParentProcessId -ne $Row.ParentProcessId -or
          [string]$now.ExecutablePath -ine $image -or [string]$now.CommandLine -cne [string]$Row.CommandLine -or
          (Full-LocalPath ([OwnedNsisUi]::Image($held.Handle))) -ine $image) {
        throw 'Held installer process does not match the observed process creation and image.'
      }
      if ($held.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'Installer is in another session.' }
      $args = [OwnedNsisUi]::Args([string]$now.CommandLine)
      if ($args.Count -ne 1 -or (Full-LocalPath $args[0]) -ine $image) { throw 'Installer process has arguments; only the real flag-free Shell open is accepted.' }
      Assert-RealChain $image -File
      $imageFile = [IO.File]::Open($image,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
      $hash = Hash-Stream $imageFile
      if ($hash -cne $ExpectedHash) {
        Log-Event 'different-image-child-not-authorized' @{ pid = $held.Id; path = $image; sha256 = $hash; parentPid = $Row.ParentProcessId }
        throw 'Different-hash inner executable is unresolved; exact packaged NSIS provenance is required before any action.'
      }
      Assert-ImageVersion $image
      if ($null -ne $Parent) {
        Assert-Pinned $Parent
        if ([int]$now.ParentProcessId -ne $Parent.id -or $now.CreationDate.ToUniversalTime() -lt $Parent.started) {
          throw 'Same-byte child is not a direct descendant of the still-pinned installer process.'
        }
      }
      $record = [pscustomobject]@{
        id = $held.Id; held = $held; file = $imageFile; path = $image; sha256 = $hash
        started = $held.StartTime.ToUniversalTime(); cimCreated = $now.CreationDate
        parentId = [int]$now.ParentProcessId; commandLine = [string]$now.CommandLine
        relationship = $(if ($null -eq $Parent) { 'exact-downloaded-shell-image' } else { 'direct-child-same-bytes' })
      }
      $script:processes.Add($record)
      Log-Event 'installer-process-pinned' @{ pid = $record.id; image = $image; sha256 = $hash; startedUtc = $record.started.ToString('o'); parentPid = $record.parentId; relationship = $record.relationship; flags = @() }
      return $record
    } catch {
      if ($null -ne $imageFile) { $imageFile.Dispose() }; $held.Dispose(); throw
    }
  }
  function Assert-Pinned($Record, [switch]$VerifyBytes) {
    $Record.held.Refresh()
    if ($Record.held.HasExited) { throw 'The owned installer identity ended before the requested UI action.' }
    $now = Get-Identity $Record.id
    if ($null -eq $now -or $now.CreationDate -ne $Record.cimCreated -or
        [int]$now.ParentProcessId -ne $Record.parentId -or [string]$now.CommandLine -cne $Record.commandLine -or
        (Full-LocalPath ([string]$now.ExecutablePath)) -ine $Record.path -or
        (Full-LocalPath ([OwnedNsisUi]::Image($Record.held.Handle))) -ine $Record.path -or
        $Record.held.StartTime.ToUniversalTime().Ticks -ne $Record.started.Ticks -or
        ($VerifyBytes -and (Hash-Stream $Record.file) -cne $ExpectedHash)) {
      throw 'Installer held-handle/start-time/path/hash identity changed; refusing the UI action.'
    }
  }
  function Read-Registration([Microsoft.Win32.RegistryHive]$Hive) {
    $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($Hive,[Microsoft.Win32.RegistryView]::Registry64)
    $key = $null; $productKey = $null
    try {
      # UUIDv5(local.luheng.officeagent, electron-builder NS UUID 50e065bc-3134-11e6-9bab-38c9862bdaf3).
      $guid = '20be089a-e364-59fe-9bf1-70ea22b78d3f'
      $key = $base.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid",$false)
      $productKey = $base.OpenSubKey("Software\$guid",$false)
      if ($null -eq $key -and $null -eq $productKey) { return $null }
      if ($null -eq $key -or $null -eq $productKey) { throw 'Incomplete NSIS product registration.' }
      return [pscustomobject]@{
        hive = $Hive.ToString(); guid = $guid; displayName = [string]$key.GetValue('DisplayName')
        displayVersion = [string]$key.GetValue('DisplayVersion')
        installLocation = [string]$productKey.GetValue('InstallLocation')
        uninstallString = [string]$key.GetValue('UninstallString')
      }
    } finally {
      if ($null -ne $key) { $key.Dispose() }; if ($null -ne $productKey) { $productKey.Dispose() }; $base.Dispose()
    }
  }
  function Assert-Registration([string]$ExpectedVersion) {
    if ($null -ne (Read-Registration ([Microsoft.Win32.RegistryHive]::LocalMachine))) { throw 'A machine-wide registration exists; this test is current-user only.' }
    $reg = Read-Registration ([Microsoft.Win32.RegistryHive]::CurrentUser)
    if ($null -eq $reg -or $reg.displayVersion -cne $ExpectedVersion -or
        $reg.displayName -cne "Luheng Office Agent $ExpectedVersion" -or
        (Full-LocalPath $reg.installLocation) -ine $ExpectedInstallDirectory -or
        $reg.uninstallString -cne ('"' + (Join-Path $ExpectedInstallDirectory 'Uninstall Luheng Office Agent.exe') + '" /currentuser')) {
      throw 'HKCU registration does not identify the expected version and exact existing install directory.'
    }
    return $reg
  }
  function Assert-AppExited {
    $rows = Snapshot-Processes
    # A same-name product process with an inaccessible image is also a blocker, never evidence of exit.
    $matching = @($rows | Where-Object { [string]$_.Name -ieq 'Luheng Office Agent.exe' -or
      ($_.ExecutablePath -and [string]$_.ExecutablePath -ieq $expectedAppExe) })
    if ($matching.Count) { throw 'The original installed app or its same-image helpers are still running.' }
    if ($ExpectedAppPid -gt 0) {
      $still = @($rows | Where-Object { [int]$_.ProcessId -eq $ExpectedAppPid })
      if ($still.Count) { throw 'Expected original application PID remains present or has been reused; identity is unresolved.' }
    }
    return @{ observedUtc = [DateTime]::UtcNow.ToString('o'); expectedPidAbsent = ($ExpectedAppPid -gt 0); installedImageAbsent = $true }
  }
  function Read-PendingJournal {
    Assert-RealChain $journalPath -File
    $file = [IO.File]::Open($journalPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
      if ($file.Length -le 0 -or $file.Length -gt 512) { throw 'Pending install journal has an invalid length.' }
      $reader = [IO.StreamReader]::new($file,$script:utf8,$true,1024,$true)
      try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
      $json = $text | ConvertFrom-Json -ErrorAction Stop
      $keys = @($json.PSObject.Properties.Name | Sort-Object) -join ','
      if ($keys -cne 'schema,sha256,version' -or $json.schema -ne 1 -or
          $json.version -cne $Version -or $json.sha256 -cne $ExpectedHash) {
        throw 'Real pending.json is not bound to schema 1 and the locked Beta2 version/SHA256.'
      }
      Write-Json (Join-Path $OutputDirectory 'pending-after-beta1-exit.json') $json
      return @{ path = $journalPath; observedAfterAppExit = $true; value = $json; sha256 = (Hash-Stream $file) }
    } finally { $file.Dispose() }
  }
  function Observe-OwnedLoader([IntPtr]$Window, $Record) {
    Assert-Pinned $Record
    $title = [OwnedNsisUi]::Title($Window)
    if ($title -cnotmatch '^(Verifying installer|Unpacking data): (100|[0-9]{1,2})%$') { return $false }
    if ([OwnedNsisUi]::Pid($Window) -ne $Record.id -or [OwnedNsisUi]::Class($Window) -cne '#32770' -or
        [OwnedNsisUi]::GetWindow($Window,4) -ne [IntPtr]::Zero) { throw 'NSIS loader owner/class identity is inconsistent.' }
    $controls = @()
    foreach ($h in [OwnedNsisUi]::Children($Window)) {
      if ([OwnedNsisUi]::Pid($h) -ne $Record.id) { throw 'Foreign control in the owned NSIS loader.' }
      $controls += [pscustomobject]@{
        handle = $h.ToInt64(); id = [OwnedNsisUi]::GetDlgCtrlID($h); class = [OwnedNsisUi]::Class($h)
        name = [OwnedNsisUi]::ControlText($h); visible = [OwnedNsisUi]::IsWindowVisible($h)
        enabled = [OwnedNsisUi]::IsWindowEnabled($h)
      }
    }
    # NSIS v304 fileform.c verProc writes the same percent string to dialog title and IDC_STR.
    # This is an observe-only state. It has no authorized buttons, and can only time out or become a wizard.
    if (@($controls | Where-Object { $_.visible -and $_.class -ceq 'Static' -and $_.name -ceq $title }).Count -ne 1 -or
        @($controls | Where-Object { $_.visible -and $_.class -cnotin @('Static','msctls_progress32') }).Count -gt 0) {
      throw 'Owned loader contains unexpected controls; no loader interaction is permitted.'
    }
    $element = [Windows.Automation.AutomationElement]::FromHandle($Window)
    if ($element.Current.ProcessId -ne $Record.id) { throw 'Owned loader accessibility identity is inconsistent.' }
    $all = $element.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
    if ($all.Count -gt 32) { throw 'Owned loader accessibility tree is unexpectedly large.' }
    $accessible = @()
    foreach ($e in $all) {
      if ($e.Current.ProcessId -ne $Record.id -or $e.Current.ControlType -in @([Windows.Automation.ControlType]::Button,[Windows.Automation.ControlType]::CheckBox,[Windows.Automation.ControlType]::Edit)) {
        throw 'Owned loader exposes an unexpected actionable accessible control.'
      }
      $accessible += @{ name = $e.Current.Name; automationId = $e.Current.AutomationId; controlType = $e.Current.ControlType.ProgrammaticName; nativeHandle = $e.Current.NativeWindowHandle }
    }
    Log-Event 'observed-only-owned-nsis-loader' @{ pid = $Record.id; title = $title; native = $controls; accessible = $accessible; action = 'none' }
    return $true
  }
  function Inspect-Wizard([IntPtr]$Window, $Record) {
    Assert-Pinned $Record
    if ([OwnedNsisUi]::Pid($Window) -ne $Record.id -or [OwnedNsisUi]::Class($Window) -cne '#32770' -or
        [OwnedNsisUi]::Title($Window).TrimEnd(' ') -cne 'Luheng Office Agent Setup' -or
        [OwnedNsisUi]::GetWindow($Window,4) -ne [IntPtr]::Zero -or -not [OwnedNsisUi]::IsWindowEnabled($Window)) {
      throw 'Unexpected owned modal/title/class/owner; only the regular English NSIS setup wizard is supported.'
    }
    $native = @()
    foreach ($h in [OwnedNsisUi]::Children($Window)) {
      if ([OwnedNsisUi]::Pid($h) -ne $Record.id) { throw 'A wizard descendant belongs to another process.' }
      $native += [pscustomobject]@{
        handle = $h.ToInt64(); id = [OwnedNsisUi]::GetDlgCtrlID($h); class = [OwnedNsisUi]::Class($h)
        name = [OwnedNsisUi]::ControlText($h); visible = [OwnedNsisUi]::IsWindowVisible($h)
        enabled = [OwnedNsisUi]::IsWindowEnabled($h)
      }
    }
    $element = [Windows.Automation.AutomationElement]::FromHandle($Window)
    if ($element.Current.ProcessId -ne $Record.id -or $element.Current.Name.TrimEnd(' ') -cne 'Luheng Office Agent Setup') { throw 'UIAutomation top-level identity differs from Win32.' }
    $all = $element.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
    if ($all.Count -gt 2048) { throw 'Unexpectedly large wizard accessibility tree.' }
    $accessible = @()
    foreach ($e in $all) {
      if ($e.Current.ProcessId -ne $Record.id) { throw 'Foreign process in the wizard accessibility tree.' }
      $accessible += [pscustomobject]@{
        name = $e.Current.Name; automationId = $e.Current.AutomationId; class = $e.Current.ClassName
        controlType = $e.Current.ControlType.ProgrammaticName; nativeHandle = $e.Current.NativeWindowHandle
        enabled = $e.Current.IsEnabled; offscreen = $e.Current.IsOffscreen
      }
    }
    Log-Event 'observed-wizard-controls' @{ pid = $Record.id; window = $Window.ToInt64(); native = $native; accessible = $accessible }
    $buttons = @($native | Where-Object { $_.visible -and $_.class -ceq 'Button' -and $_.id -eq 1 })
    if ($buttons.Count -ne 1) { throw 'The single NSIS ID 1 forward button is not observable.' }
    $button = $buttons[0]
    $action = switch -CaseSensitive ($button.name) {
      '&Next >' { 'next' }; 'Next >' { 'next' }; '&Install' { 'install' }; 'Install' { 'install' }
      '&Finish' { 'finish' }; 'Finish' { 'finish' }; default { throw "Unexpected NSIS forward control label: $($button.name)" }
    }
    # MUI2 FullWindow Finish deliberately hides native branding ID1256, while retaining its text.
    # Permit that source-defined visibility change only after the exact successful finish page is observed.
    $visibleText = ($native | Where-Object { $_.visible } | ForEach-Object { $_.name }) -join "`n"
    $isSuccessfulFinish = $action -ceq 'finish' -and
      $visibleText -match 'Luheng Office Agent has been installed on your computer\.' -and
      $visibleText -match 'Completing the Luheng Office Agent Setup Wizard'
    $branding = @($native | Where-Object {
      $_.id -eq 1256 -and $_.class -ceq 'Static' -and $_.name.TrimEnd(' ') -ceq "Luheng Office Agent $Version" -and
      ($_.visible -or $isSuccessfulFinish)
    })
    if ($branding.Count -ne 1) { throw 'The exact native NSIS ID1256 product/version branding is missing or ambiguous.' }
    if ($action -ceq 'finish' -and -not $isSuccessfulFinish) { throw 'Owned Finish page does not state the expected successful installation.' }
    # Different page types (license, install mode, custom prompt) are not generated by this source config.
    $unexpectedButtons = @($native | Where-Object {
      $_.visible -and $_.enabled -and $_.class -ceq 'Button' -and $_.id -notin @(1,2,3,1001) -and
      -not ($action -eq 'finish' -and $_.name -cin @('&Run Luheng Office Agent','Run Luheng Office Agent'))
    })
    if ($unexpectedButtons.Count) { throw 'Unexpected actionable controls in the owned wizard.' }
    $directory = @($native | Where-Object { $_.visible -and $_.class -ceq 'Edit' -and $_.id -eq 1019 })
    return [pscustomobject]@{ window = $Window; element = $element; native = $native; accessible = $accessible; button = $button; action = $action; directory = $directory }
  }
  function Invoke-Forward($Wizard, $Record, [string]$Action) {
    Assert-Pinned $Record -VerifyBytes
    $windows = Inspect-Windows
    Assert-NoPrompt $windows
    $foreground = [OwnedNsisUi]::GetForegroundWindow()
    if ($foreground -ne $Wizard.window) { throw 'Owned wizard is not the foreground window; possible other-process prompt or interference.' }
    $fresh = Inspect-Wizard $Wizard.window $Record
    if ($fresh.action -cne $Action -or -not $fresh.button.enabled) { throw 'Wizard page changed or forward button is disabled.' }
    $nativeHandle = [IntPtr]::new([long]$fresh.button.handle)
    $btn = [Windows.Automation.AutomationElement]::FromHandle($nativeHandle)
    if (-not [OwnedNsisUi]::IsChild($Wizard.window,$nativeHandle) -or
        [OwnedNsisUi]::Pid($nativeHandle) -ne $Record.id -or [OwnedNsisUi]::GetDlgCtrlID($nativeHandle) -ne 1 -or
        $btn.Current.ProcessId -ne $Record.id -or $btn.Current.ControlType -ne [Windows.Automation.ControlType]::Button -or
        $btn.Current.NativeWindowHandle -ne $nativeHandle.ToInt64() -or -not $btn.Current.IsEnabled -or $btn.Current.IsOffscreen -or
        $btn.Current.Name -cnotin @($fresh.button.name,$fresh.button.name.Replace('&',''))) {
      throw 'Accessible forward button does not match the owned native NSIS control.'
    }
    $pattern = $null
    if (-not $btn.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { throw 'The verified NSIS button has no accessible Invoke pattern.' }
    [void](Save-Screenshot ('before-' + $Action))
    # The held read-only file prevents changes during polling; rehash immediately before an actual action.
    # Last check uses the held process and exact native button, never a label-only search or coordinates.
    Assert-Pinned $Record -VerifyBytes
    Assert-NoPrompt (Inspect-Windows)
    if ($Action -eq 'finish') { [void](Assert-AppExited); [void](Read-PendingJournal); [void](Get-RunCheckbox $fresh $Record -RequireOff) }
    if ([OwnedNsisUi]::GetForegroundWindow() -ne $Wizard.window -or [OwnedNsisUi]::Pid($nativeHandle) -ne $Record.id -or
        -not [OwnedNsisUi]::IsWindowEnabled($nativeHandle) -or [OwnedNsisUi]::ControlText($nativeHandle) -cne $fresh.button.name) {
      throw 'The verified button or desktop changed immediately before Invoke.'
    }
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
    $entry = @{ utc = [DateTime]::UtcNow.ToString('o'); pid = $Record.id; window = $Wizard.window.ToInt64(); controlId = 1; label = $fresh.button.name; action = $Action }
    $script:report.actions += $entry
    Log-Event 'invoked-owned-regular-nsis-forward' $entry
    Start-Sleep -Milliseconds 200
    [void](Save-Screenshot ('after-' + $Action))
  }

  function Get-RunCheckbox($Wizard, $Record, [switch]$RequireOff) {
    Assert-Pinned $Record
    if ($Wizard.action -cne 'finish' -or [OwnedNsisUi]::GetForegroundWindow() -ne $Wizard.window) {
      throw 'The requested Run checkbox is only supported on the foreground verified finish page.'
    }
    $matches = @($Wizard.native | Where-Object {
      $_.visible -and $_.enabled -and $_.class -ceq 'Button' -and
      $_.name -cin @('&Run Luheng Office Agent','Run Luheng Office Agent')
    })
    if ($matches.Count -ne 1) { throw 'Finish page has no single exact Run Luheng Office Agent checkbox; leaving it untouched.' }
    $native = $matches[0]
    $handle = [IntPtr]::new([long]$native.handle)
    $element = [Windows.Automation.AutomationElement]::FromHandle($handle)
    if ([OwnedNsisUi]::Pid($handle) -ne $Record.id -or -not [OwnedNsisUi]::IsChild($Wizard.window,$handle) -or
        $element.Current.ProcessId -ne $Record.id -or $element.Current.ControlType -ne [Windows.Automation.ControlType]::CheckBox -or
        $element.Current.Name -cnotin @($native.name,$native.name.Replace('&','')) -or
        $element.Current.NativeWindowHandle -ne $handle.ToInt64() -or -not $element.Current.IsEnabled -or $element.Current.IsOffscreen) {
      throw 'Observed Run control is not the exact accessible owned NSIS checkbox.'
    }
    $toggle = $null
    if (-not $element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$toggle)) {
      throw 'The genuine Run checkbox has no Toggle pattern; no fallback click is permitted.'
    }
    $state = ([Windows.Automation.TogglePattern]$toggle).Current.ToggleState
    $nativeState = [OwnedNsisUi]::CheckState($handle)
    if (($state -eq [Windows.Automation.ToggleState]::On -and $nativeState -ne 1) -or
        ($state -eq [Windows.Automation.ToggleState]::Off -and $nativeState -ne 0) -or
        $state -eq [Windows.Automation.ToggleState]::Indeterminate) {
      throw 'Accessible and native Run checkbox states are inconsistent or indeterminate.'
    }
    if ($RequireOff -and $state -ne [Windows.Automation.ToggleState]::Off) { throw 'Run-after-finish remained selected; Beta2 must not autostart in this acceptance flow.' }
    return [pscustomobject]@{ native = $native; handle = $handle; element = $element; toggle = $toggle; state = $state.ToString() }
  }
  function Uncheck-RunAfterFinish($Wizard, $Record) {
    [void](Assert-AppExited)
    [void](Read-PendingJournal)
    Assert-NoPrompt (Inspect-Windows)
    $fresh = Inspect-Wizard $Wizard.window $Record
    $checkbox = Get-RunCheckbox $fresh $Record
    [void](Save-Screenshot 'before-owned-run-option')
    if ($checkbox.state -ceq 'On') {
      Assert-Pinned $Record -VerifyBytes
      Assert-NoPrompt (Inspect-Windows)
      $last = Get-RunCheckbox (Inspect-Wizard $Wizard.window $Record) $Record
      if ($last.handle -ne $checkbox.handle -or $last.native.id -ne $checkbox.native.id -or $last.state -cne 'On') {
        throw 'Owned Run checkbox identity/state changed immediately before its single Toggle.'
      }
      ([Windows.Automation.TogglePattern]$last.toggle).Toggle()
      Start-Sleep -Milliseconds 150
      $confirmed = Get-RunCheckbox (Inspect-Wizard $Wizard.window $Record) $Record -RequireOff
      if ($confirmed.handle -ne $checkbox.handle -or $confirmed.native.id -ne $checkbox.native.id) { throw 'Run checkbox changed identity after Toggle.' }
      $entry = @{ utc = [DateTime]::UtcNow.ToString('o'); pid = $Record.id; window = $Wizard.window.ToInt64(); controlId = $checkbox.native.id; label = $checkbox.native.name; action = 'uncheck-run-after-finish'; before = 'On'; after = 'Off' }
      $script:report.actions += $entry
      Log-Event 'toggled-exact-owned-run-checkbox' $entry
    } else {
      Log-Event 'owned-run-checkbox-already-off' @{ pid = $Record.id; controlId = $checkbox.native.id; label = $checkbox.native.name; observedState = 'Off' }
    }
    [void](Save-Screenshot 'after-owned-run-option-off')
    $script:report.runAfterFinishDisabled = $true
  }

  if (($ExpectedAppPid -gt 0) -or $ExpectedAppStartUtc -or $ExpectedAppHash) {
    if ($ExpectedAppPid -le 0 -or -not $ExpectedAppStartUtc -or $ExpectedAppHash -notmatch '^[a-fA-F0-9]{64}$') {
      throw 'Pass all three optional original-app identity fields together.'
    }
    $appStarted = Parse-Utc $ExpectedAppStartUtc
    if ($appStarted -ge $startedAfter) { throw 'Original Beta1 process start must precede native confirmation.' }
    Assert-RealChain $expectedAppExe -File
    if ((Get-FileHash -LiteralPath $expectedAppExe -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedAppHash.ToLowerInvariant()) {
      throw 'Original Beta1 installed EXE differs from its native-proof hash.'
    }
    $script:report.expected.beta1StartUtc = $appStarted.ToString('o')
    $script:report.expected.beta1ExeSha256 = $ExpectedAppHash.ToLowerInvariant()
  }
  $script:report.appExit = Assert-AppExited
  $script:report.registrationBefore = Assert-Registration '0.6.0-beta.1'
  $script:report.journalAfterAppExit = Read-PendingJournal
  [void](Save-Screenshot 'start-after-beta1-exit')
  $end = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $root = $null; $installInvoked = $false; $finishInvoked = $false; $directoryVerified = $false
  $lastPage = ''; $nextCount = 0
  while ([DateTime]::UtcNow -lt $end) {
    [void][OwnedNsisUi]::AssertInputDesktop()
    $rows = Snapshot-Processes
    if ($null -eq $root) {
      $candidates = @($rows | Where-Object { $_.ExecutablePath -and [string]$_.ExecutablePath -ieq $ExpectedInstaller })
      if ($candidates.Count -gt 1) { throw 'Multiple exact downloaded installer processes are ambiguous.' }
      if ($candidates.Count -eq 1) { $root = Pin-Installer $candidates[0] }
    }
    $windows = Inspect-Windows
    # Pin only a still-parented same-byte image that owns a visible window. Silent NSIS uninstaller
    # support processes are never acted on. A different-image visible child is an explicit blocker.
    foreach ($window in $windows) {
      if (@($script:processes | Where-Object { $_.id -eq $window.pid }).Count) { continue }
      $childRows = @($rows | Where-Object { [int]$_.ProcessId -eq $window.pid })
      if ($childRows.Count -eq 0) { $freshRow = Get-Identity $window.pid; if ($null -eq $freshRow) { continue }; $childRows = @($freshRow) }
      if ($childRows.Count -ne 1) { throw 'A visible window process has an ambiguous identity.' }
      $parents = @($script:processes | Where-Object { $_.id -eq [int]$childRows[0].ParentProcessId })
      if ($parents.Count -eq 1) { [void](Pin-Installer $childRows[0] $parents[0]) }
    }
    Assert-NoPrompt $windows
    $own = @($windows | Where-Object { $windowPid = $_.pid; @($script:processes | Where-Object { $_.id -eq $windowPid }).Count -gt 0 })
    if ($own.Count -gt 1) { Log-Event 'unexpected-owned-windows' $own; throw 'Multiple owned top-level windows or an owned modal are unsupported; no warning is dismissed.' }
    if ($own.Count -eq 1 -and -not $finishInvoked) {
      $windowPid = $own[0].pid
      $record = @($script:processes | Where-Object { $_.id -eq $windowPid })[0]
      if (-not $installInvoked -and -not $directoryVerified -and (Observe-OwnedLoader ([IntPtr]::new([long]$own[0].handle)) $record)) {
        if ($lastPage -cne $own[0].title) { [void](Save-Screenshot 'observed-owned-loader-no-action'); $lastPage = $own[0].title }
        Start-Sleep -Milliseconds 150; continue
      }
      $wizard = Inspect-Wizard ([IntPtr]::new([long]$own[0].handle)) $record
      $pageKey = $wizard.action + ':' + [string]$wizard.button.enabled + ':' + (($wizard.native | Where-Object { $_.visible } | ForEach-Object { "{0}={1}" -f $_.id,$_.name }) -join '|')
      if ($pageKey -cne $lastPage) { [void](Save-Screenshot 'observed-page'); $lastPage = $pageKey }
      if ($wizard.button.enabled) {
        switch ($wizard.action) {
          { $_ -in @('next','install') } {
            if ($installInvoked) { throw 'Unexpected actionable Next/Install after installation started.' }
            $script:report.appExit = Assert-AppExited
            [void](Assert-Registration '0.6.0-beta.1')
            [void](Read-PendingJournal)
            if ($wizard.directory.Count -ne 1 -or (Full-LocalPath $wizard.directory[0].name) -ine $ExpectedInstallDirectory) {
              throw 'Visible directory page does not expose the exact existing current-user Beta1 install path.'
            }
            $directoryVerified = $true
            if ($wizard.action -eq 'next') {
              $nextCount++; if ($nextCount -gt 2) { throw 'Unexpected repeated Next page.' }
              Invoke-Forward $wizard $record 'next'
            } else {
              Invoke-Forward $wizard $record 'install'; $installInvoked = $true
            }
          }
          'finish' {
            if (-not $installInvoked -or -not $directoryVerified -or $finishInvoked) { throw 'Finish was observed without this run verifying the directory and invoking Install.' }
            $text = ($wizard.native | Where-Object { $_.visible } | ForEach-Object { $_.name }) -join "`n"
            if ($text -notmatch 'Luheng Office Agent has been installed on your computer\.' -or
                $text -notmatch 'Completing the Luheng Office Agent Setup Wizard') {
              throw 'Finish page does not state the expected successful regular NSIS completion.'
            }
            $script:report.registrationAfter = Assert-Registration $Version
            Uncheck-RunAfterFinish $wizard $record
            Invoke-Forward $wizard $record 'finish'; $finishInvoked = $true
          }
        }
      }
    }
    if ($finishInvoked) {
      $alive = @($script:processes | Where-Object { -not $_.held.HasExited })
      if ($alive.Count -eq 0) {
        foreach ($record in $script:processes) {
          $record.held.WaitForExit()
          if ($record.held.ExitCode -ne 0) { throw "Owned installer process exited $($record.held.ExitCode), expected zero." }
        }
        $script:report.registrationAfter = Assert-Registration $Version
        [void](Assert-AppExited)
        [void](Read-PendingJournal)
        if (-not $script:report.runAfterFinishDisabled) { throw 'Run-after-finish option was not observed off.' }
        $script:report.status = 'owned-installer-wizard-passed'
        $script:report.wizardCompleted = $true
        break
      }
    } elseif ($null -ne $root -and $root.held.HasExited -and $own.Count -eq 0) {
      throw 'Shell-opened installer exited without this helper observing and completing its visible wizard.'
    }
    Start-Sleep -Milliseconds 150
  }
  if (-not $script:report.wizardCompleted) { throw 'Visible wizard observation/completion exceeded the bounded timeout.' }
} catch {
  $script:report.error = $_.Exception.Message
  if ('OwnedNsisUi' -as [type]) {
    try { Log-Event 'blocked-final-windows' (Inspect-Windows) } catch { $script:report.evidenceError = $_.Exception.Message }
    try { [void](Save-Screenshot 'blocked-no-warning-clicked') } catch {
      $script:report.evidenceError = [string]$script:report.evidenceError + ' | screenshot unavailable: ' + $_.Exception.Message
    }
  }
} finally {
  foreach ($record in $script:processes) {
    $exit = $null
    try { if ($record.held.HasExited) { $exit = $record.held.ExitCode } } catch {}
    $script:report.processes += @{
      pid = $record.id; image = $record.path; sha256 = $record.sha256; parentPid = $record.parentId
      startedUtc = $record.started.ToString('o'); relationship = $record.relationship; exitCode = $exit
    }
    $record.file.Dispose(); $record.held.Dispose()
  }
  if ($null -ne $installerFile) { $installerFile.Dispose() }
  # No taskkill, Kill, CloseMainWindow, cancellation or uninstall. Leave any blocker untouched.
  Write-Json (Join-Path $OutputDirectory 'owned-installer-wizard.json') $script:report
}
$script:report | ConvertTo-Json -Depth 24
if (-not $script:report.wizardCompleted -or $script:report.error -or $script:report.evidenceError) { exit 1 }
Write-Output 'LUHENG_OWNED_VISIBLE_NSIS_WIZARD_COMPLETED'
exit 0
