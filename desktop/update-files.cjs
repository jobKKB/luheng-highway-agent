'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { parseReleaseVersion } = require('./update-policy.cjs');
const INSTALL_GUID = '20be089a-e364-59fe-9bf1-70ea22b78d3f'; // v26 UUID.v5 of unchanged appId.
const MIN_INSTALL_FREE = 2 * 1024 ** 3; // Conservative floor, not an unpacked-size guarantee.
const WINDOWS_INSPECT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('LUHENG_UPDATE_PATH', 'Process')
$mode = [Environment]::GetEnvironmentVariable('LUHENG_UPDATE_MODE', 'Process')
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($user, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
$item = Get-Item -LiteralPath $target -Force
$ancestor = $item
while ($null -ne $ancestor) {
 if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse point denied' }
 $ancestor = if ($ancestor.PSIsContainer) { $ancestor.Parent } else { $ancestor.Directory }
}
$acl = Get-Acl -LiteralPath $target
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user) { throw 'Unexpected owner' }
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
 if ($rule.AccessControlType -ne 'Allow' -or $rule.IdentityReference.Value -notin $allowed) { throw 'Unexpected ACL' }
}
if ($mode -eq 'mark' -or $mode -eq 'verify-mark') {
 if ($item.PSIsContainer) { throw 'Not a file' }
 if ($mode -eq 'mark') {
  $source = [Environment]::GetEnvironmentVariable('LUHENG_UPDATE_SOURCE', 'Process')
  $zoneText = [string]::Join([Environment]::NewLine, @('[ZoneTransfer]', 'ZoneId=3', "HostUrl=$source", ''))
  Set-Content -LiteralPath $target -Stream Zone.Identifier -Encoding ASCII -Value $zoneText -NoNewline
 }
 $zone = Get-Content -LiteralPath $target -Stream Zone.Identifier -Raw -Encoding ASCII
 if ($zone -notmatch '(?m)^ZoneId=3\r?$') { throw 'Internet zone marker absent' }
}
Write-Output 'LUHENG_UPDATE_FILE_READY'
`;
// Only called for an empty O_EXCL-created file while its original FileHandle is
// held. Windows can default a new file's owner to the Administrators token SID,
// independently of its private parent DACL. Bind the native handle to that exact
// new file before setting only OWNER_SECURITY_INFORMATION; never adopt a path.
const WINDOWS_NEW_FILE_OWNER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = [Environment]::GetEnvironmentVariable('LUHENG_UPDATE_PATH', 'Process')
$volume = [uint32]::Parse([Environment]::GetEnvironmentVariable('LUHENG_UPDATE_EXPECTED_DEV', 'Process'), [Globalization.CultureInfo]::InvariantCulture)
$fileId = [uint64]::Parse([Environment]::GetEnvironmentVariable('LUHENG_UPDATE_EXPECTED_INO', 'Process'), [Globalization.CultureInfo]::InvariantCulture)
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$sid = New-Object byte[] $user.BinaryLength
$user.GetBinaryForm($sid, 0)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LuhengNewUpdateFileOwner {
 [StructLayout(LayoutKind.Sequential)]
 public struct FileInformation {
  public uint Attributes;
  public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
  public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
 }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)]
 static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation information);
 [DllImport("advapi32.dll")]
 static extern uint SetSecurityInfo(SafeFileHandle file, uint type, uint sections, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
 [DllImport("advapi32.dll")]
 static extern uint GetSecurityInfo(SafeFileHandle file, uint type, uint sections, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
 [DllImport("advapi32.dll")]
 static extern bool EqualSid(IntPtr first, IntPtr second);
 [DllImport("kernel32.dll")]
 static extern IntPtr LocalFree(IntPtr memory);
 static void CheckNewFile(SafeFileHandle file, uint volume, ulong fileId) {
  FileInformation value;
  if (!GetFileInformationByHandle(file, out value)) throw new Win32Exception(Marshal.GetLastWin32Error());
  ulong actualId = ((ulong)value.IndexHigh << 32) | value.IndexLow;
  if (value.Volume != volume || actualId != fileId || value.Links != 1 ||
      value.SizeHigh != 0 || value.SizeLow != 0 || (value.Attributes & (0x10u | 0x400u)) != 0)
   throw new InvalidOperationException("New update file identity changed");
 }
 public static void Prepare(string path, uint volume, ulong fileId, byte[] sid) {
  // Existing access rights suffice; no token privilege or DACL is changed.
  using (SafeFileHandle file = CreateFileW(path, 0x000A0000u, 7u, IntPtr.Zero, 3u, 0x00200000u, IntPtr.Zero)) {
   if (file.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
   CheckNewFile(file, volume, fileId);
   GCHandle pinned = GCHandle.Alloc(sid, GCHandleType.Pinned);
   try {
    IntPtr expectedOwner = pinned.AddrOfPinnedObject();
    uint result = SetSecurityInfo(file, 1u, 1u, expectedOwner, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    if (result != 0) throw new Win32Exception((int)result);
    IntPtr owner, group, dacl, sacl, descriptor;
    result = GetSecurityInfo(file, 1u, 1u, out owner, out group, out dacl, out sacl, out descriptor);
    if (result != 0) throw new Win32Exception((int)result);
    try {
     if (!EqualSid(owner, expectedOwner)) throw new InvalidOperationException("New update file owner was not applied");
    } finally { LocalFree(descriptor); }
    CheckNewFile(file, volume, fileId);
   } finally { pinned.Free(); }
  }
 }
}
'@
[LuhengNewUpdateFileOwner]::Prepare($target, $volume, $fileId, $sid)
Write-Output 'LUHENG_UPDATE_NEW_FILE_READY'
`;
const WINDOWS_INSTALL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$exe = [Environment]::GetEnvironmentVariable('LUHENG_UPDATE_EXECUTABLE', 'Process')
$key = 'Software\20be089a-e364-59fe-9bf1-70ea22b78d3f'
$cu = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key)
$lm = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey($key)
try {
 if ($null -ne $lm -and $lm.GetValue('InstallLocation')) { throw 'Machine install not supported' }
 if ($null -eq $cu) { throw 'Current-user install not found' }
 $location = [string]$cu.GetValue('InstallLocation')
 if (-not $location -or -not [IO.Path]::IsPathRooted($location)) { throw 'Invalid install path' }
 $item = Get-Item -LiteralPath $location -Force
 $actual = [IO.Path]::GetFullPath($item.FullName).TrimEnd('\')
 if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($exe)).TrimEnd('\') -ine $actual) { throw 'Installation does not match executable' }
 $ancestor = $item
 while ($null -ne $ancestor) {
  if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation reparse denied' }
  $ancestor = $ancestor.Parent
 }
 $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $acl = Get-Acl -LiteralPath $location
 if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $user) { throw 'Current user does not own installation' }
 $probe = Join-Path $location ('.luheng-write-check-' + [guid]::NewGuid().ToString('N'))
 $handle = [IO.File]::Open($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
 $handle.Dispose()
 Remove-Item -LiteralPath $probe -Force
 Write-Output 'LUHENG_CURRENT_USER_INSTALL_READY'
} finally { if ($null -ne $cu) { $cu.Dispose() }; if ($null -ne $lm) { $lm.Dispose() } }
`;
function failure(code) { return Object.assign(new Error(code), { code }); }
function runFixed(script, variables, { env = process.env, run = spawnSync } = {}) {
  const systemRoot = env.SystemRoot || env.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw failure('FILE_SECURITY');
  const command = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = run(command, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...env, ...variables }, encoding: 'utf8', windowsHide: true,
    timeout: 15000, maxBuffer: 65536, shell: false,
  });
  if (result.error || result.status !== 0) throw failure('FILE_SECURITY');
  return result.stdout?.trim();
}
function inspectAncestors(target) {
  let current = path.resolve(target);
  for (;;) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw failure('FILE_SECURITY');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function inspectFile(file, directory) {
  inspectAncestors(directory);
  const realDirectory = fs.realpathSync(directory);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || path.dirname(fs.realpathSync(file)) !== realDirectory) throw failure('FILE_SECURITY');
  return stat;
}
async function createUpdateFiles({ stateRoot, privateDirectoryModule, platform = process.platform, env = process.env, run = spawnSync }) {
  const { preparePrivateDirectory } = await import(pathToFileURL(privateDirectoryModule).href);
  const cacheRoot = path.join(stateRoot, 'updates');
  inspectAncestors(stateRoot);
  preparePrivateDirectory(cacheRoot, { platform, env, run });
  inspectAncestors(cacheRoot);
  const windowsInspect = (file, mode, source) => {
    if (platform === 'win32' && runFixed(WINDOWS_INSPECT_SCRIPT, {
      LUHENG_UPDATE_PATH: file, LUHENG_UPDATE_MODE: mode, LUHENG_UPDATE_SOURCE: source || '',
    }, { env, run }) !== 'LUHENG_UPDATE_FILE_READY') throw failure('FILE_SECURITY');
  };
  windowsInspect(cacheRoot, 'inspect');
  const initializeOwnedNewFile = async (file, directory, handle, identity) => {
    inspectFile(file, directory);
    const held = await handle.stat({ bigint: true });
    const matches = value => value.isFile() && value.nlink === 1n && value.size === 0n && value.dev === held.dev && value.ino === held.ino;
    if (!matches(held) || Number(held.dev) !== identity.dev || Number(held.ino) !== identity.ino || !matches(fs.lstatSync(file, { bigint: true }))) throw failure('FILE_SECURITY');
    if (platform === 'win32' && runFixed(WINDOWS_NEW_FILE_OWNER_SCRIPT, {
      LUHENG_UPDATE_PATH: file, LUHENG_UPDATE_EXPECTED_DEV: held.dev.toString(), LUHENG_UPDATE_EXPECTED_INO: held.ino.toString(),
    }, { env, run }) !== 'LUHENG_UPDATE_NEW_FILE_READY') throw failure('FILE_SECURITY');
    if (!matches(await handle.stat({ bigint: true })) || !matches(fs.lstatSync(file, { bigint: true }))) throw failure('FILE_SECURITY');
    inspectFile(file, directory); windowsInspect(file, 'inspect');
  };
  const freeSpace = directory => {
    const space = fs.statfsSync(directory, { bigint: true });
    return space.bavail * space.bsize;
  };
  // Previous process caches are never trusted/reused for execution. Clean only
  // this app's fixed-name one-link files in private 32-hex operation directories;
  // unknown entries, symlinks, reparse points and non-private paths are untouched.
  for (const entry of await fsp.readdir(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const directory = path.join(cacheRoot, entry.name);
    try {
      inspectAncestors(directory); windowsInspect(directory, 'inspect');
      const names = await fsp.readdir(directory);
      if (names.some(name => !['installer.exe', 'installer.exe.partial'].includes(name))) continue;
      for (const name of names) { const file = path.join(directory, name); inspectFile(file, directory); windowsInspect(file, 'inspect'); }
      for (const name of names) await fsp.unlink(path.join(directory, name));
      await fsp.rmdir(directory);
    } catch {} // Fail closed; never remove an unsafe or unknown entry.
  }
  const journalPath = path.join(cacheRoot, 'pending.json');
  const journal = {
    async read() {
      try {
        const stat = inspectFile(journalPath, cacheRoot);
        if (stat.size > 512) return null;
        windowsInspect(journalPath, 'inspect');
        const value = JSON.parse(await fsp.readFile(journalPath, 'utf8'));
        if (!value || Object.keys(value).sort().join(',') !== 'schema,sha256,version' || value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.sha256)) return null;
        parseReleaseVersion(value.version);
        return value;
      } catch (error) { if (error.code === 'ENOENT') return null; throw failure('FILE_SECURITY'); }
    },
    async write(candidate) {
      inspectAncestors(cacheRoot); windowsInspect(cacheRoot, 'inspect');
      const temp = path.join(cacheRoot, '.pending-' + randomBytes(16).toString('hex') + '.tmp');
      let handle, identity;
      try {
        handle = await fsp.open(temp, 'wx', 0o600);
        identity = await handle.stat();
        await initializeOwnedNewFile(temp, cacheRoot, handle, identity);
        await handle.writeFile(JSON.stringify({ schema: 1, version: candidate.version, sha256: candidate.sha256 }) + '\n');
        await handle.sync(); await handle.close(); handle = null;
        try { inspectFile(journalPath, cacheRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fsp.rename(temp, journalPath); windowsInspect(journalPath, 'inspect');
      } finally {
        await handle?.close().catch(() => {});
        try { const stat = inspectFile(temp, cacheRoot); if (identity && stat.dev === identity.dev && stat.ino === identity.ino) await fsp.unlink(temp); } catch {}
      }
    },
    async clear() {
      try { inspectFile(journalPath, cacheRoot); windowsInspect(journalPath, 'inspect'); await fsp.unlink(journalPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    },
  };
  return {
    journal,
    async create(candidate) {
      inspectAncestors(cacheRoot);
      windowsInspect(cacheRoot, 'inspect');
      if (freeSpace(cacheRoot) < BigInt(candidate.sizeBytes * 2 + 128 * 1024 ** 2)) throw failure('DISK_SPACE');
      const directory = path.join(cacheRoot, randomBytes(16).toString('hex'));
      preparePrivateDirectory(directory, { platform, env, run });
      inspectAncestors(directory);
      windowsInspect(directory, 'inspect');
      const partial = path.join(directory, 'installer.exe.partial');
      const file = path.join(directory, 'installer.exe');
      const handle = await fsp.open(partial, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      let identity;
      try { identity = await handle.stat(); await initializeOwnedNewFile(partial, directory, handle, identity); }
      catch (error) {
        await handle.close().catch(() => {});
        try { const stat = inspectFile(partial, directory); if (identity && stat.dev === identity.dev && stat.ino === identity.ino) await fsp.unlink(partial); } catch {}
        try { await fsp.rmdir(directory); } catch {}
        throw error;
      }
      return { directory, partial, file, handle, identity };
    },
    async finish(record, candidate) {
      inspectFile(record.partial, record.directory);
      await fsp.rename(record.partial, record.file);
      inspectFile(record.file, record.directory);
      windowsInspect(record.file, 'mark', candidate.downloadUrl);
      return record;
    },
    async verify(record, candidate) {
      const stat = inspectFile(record.file, record.directory);
      if (stat.dev !== record.identity.dev || stat.ino !== record.identity.ino || stat.size !== candidate.sizeBytes) throw failure('FILE_CHANGED');
      windowsInspect(record.file, 'verify-mark');
      const handle = await fsp.open(record.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let opened;
      try {
        opened = await handle.stat();
        if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || opened.size !== stat.size) throw failure('FILE_CHANGED');
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(256 * 1024);
        let position = 0;
        for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
        const final = await handle.stat();
        if (position !== candidate.sizeBytes || hash.digest('hex') !== candidate.sha256 || final.mtimeMs !== opened.mtimeMs || final.size !== opened.size) throw failure('FILE_CHANGED');
      } finally { await handle.close(); }
      const finalPath = inspectFile(record.file, record.directory);
      if (finalPath.dev !== opened.dev || finalPath.ino !== opened.ino || finalPath.size !== opened.size || finalPath.mtimeMs !== opened.mtimeMs) throw failure('FILE_CHANGED');
      windowsInspect(record.file, 'verify-mark');
      return record.file;
    },
    async discard(record) {
      if (!record) return;
      await record.handle?.close().catch(() => {});
      // Only this operation's fixed names, never recursive user-controlled removal.
      for (const name of [record.partial, record.file]) {
        try { inspectFile(name, record.directory); await fsp.unlink(name); } catch {}
      }
      try { await fsp.rmdir(record.directory); } catch {}
    },
    async installSpace(executable) {
      if (platform !== 'win32') throw failure('UNSUPPORTED');
      if (runFixed(WINDOWS_INSTALL_SCRIPT, { LUHENG_UPDATE_EXECUTABLE: executable }, { env, run }) !== 'LUHENG_CURRENT_USER_INSTALL_READY') throw failure('INSTALL_SCOPE');
      if (freeSpace(path.dirname(executable)) < BigInt(MIN_INSTALL_FREE)) throw failure('DISK_SPACE');
    },
  };
}
module.exports = { createUpdateFiles, inspectFile, inspectAncestors, WINDOWS_INSPECT_SCRIPT, WINDOWS_NEW_FILE_OWNER_SCRIPT, WINDOWS_INSTALL_SCRIPT, INSTALL_GUID, MIN_INSTALL_FREE };
