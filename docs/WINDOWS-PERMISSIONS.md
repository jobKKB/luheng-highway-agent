# Office artifact permissions on Windows

This patch is a local candidate for the Windows build failure at commit
`2fbf853de794bb4dcaeef4e088ce2a7ad05ab007`. It has not yet been executed on Windows.

## Why the original assertion fails

`fs.stat().mode & 0o777` reports emulated POSIX bits on Windows. Node's `chmod`
does not implement owner/group/other distinctions there, so an ordinary writable
file can report `0666` after requesting `0600`. Accepting `0666` or skipping the
permission assertion would not establish Windows access protection.

## Native protection

Before writing an Office document, the application prepares its trusted artifact
directory with a protected, inheritable Windows DACL. Only the current user,
Local System (`S-1-5-18`) and built-in Administrators (`S-1-5-32-544`) receive full
control. Their SIDs avoid localized account-name assumptions. Existing broader
directory rules are replaced. The applied directory descriptor is read back and
checked before the exclusive file creation writes any document bytes. New files
inherit this DACL. POSIX retains `0700` directories and `0600` files.

The implementation invokes the Windows-bundled Windows PowerShell executable
under `SystemRoot`, with no profile, shell interpolation, execution-policy change,
network request, extra download or administrator prompt. The directory path is
passed as data through an environment variable. If this native facility is absent,
blocked, times out, or cannot apply/verify the ACL, export fails closed with a
sanitized error. There is no permissive fallback. Windows PowerShell and an
ACL-supporting local filesystem are therefore required for Office export.

The directory and its ancestors remain trusted, application-owned configuration.
This helper is not a filesystem sandbox, does not defend against a compromised
same-user process or administrator, and does not retrofit ACLs onto every other
application data file. It rejects a final-component directory link/reparse point.
Exclusive file creation still rejects existing files and links.

## Tests and remaining release gates

- Office tests use a separate `Get-Acl` reader on Windows to inspect actual
  directory and file access rules, inheritance, and ownership; they retain mode-bit
  assertions on POSIX
- Native creation/reapplication covers nested directories and Chinese, spaces,
  quotes, brackets and shell-like characters as literal path data
- Windows link regression coverage uses hard links and directory junctions, which
  do not require symlink privileges. POSIX continues testing symbolic links
- The native command wrapper's timeout, error, missing-verification and
  path-as-data behavior is tested with mocks on every host
- Vault persistence fixtures use the host platform. Linux keyring-policy tests
  still explicitly simulate Linux to reject `basic_text` and unknown backends

Before calling a Windows installer ready, run on Windows:

1. `npm test` (including native DACL assertions)
2. `npm --prefix desktop run check`
3. `npm --prefix desktop run package:win`
4. Install, launch, export DOCX/XLSX, close/reopen, and uninstall on a clean
   standard-user Windows account; verify document ACLs and retained app data

The workflow must still succeed for the exact published candidate commit and
produce its `.exe` artifact. Linux tests or mock runner tests do not replace this.

## Primary references

- [Node.js 24 file modes](https://nodejs.org/docs/latest-v24.x/api/fs.html#file-modes)
- [Directory creation with a Windows security descriptor](https://learn.microsoft.com/en-us/dotnet/api/system.io.directory.createdirectory?view=netframework-4.8.1)
- [Disabling DACL inheritance](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.objectsecurity.setaccessruleprotection?view=netframework-4.8.1)
- [Get-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-acl)
- [Owner of a new Windows object](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object)
