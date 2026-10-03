# Independent ordinary NSIS directory fixture

This directory is a standalone functional harness for the supplied mask-fixed
directory helper. It is separate from the product checkout and contains no
application payload, uninstaller, release version, update manifest, or product
registry writes. Nothing in this artifact has been executed as an installer.

The copied helper is byte-exact:

`helper/current-user-install-directory.nsh`

SHA-256: `b7190fdd950c88c94d421d33d60a3cc344f1a64b16c1c3ad6dcd6bda3afc9f2f`

The helper guards, numeric mask comparisons, functions, and callbacks are
unchanged. The fixture defines its normal compile-time inputs, inserts the
helper's delayed `customHeader`, supplies its unreachable `GetInQuotes`
dependency, and supplies a fixed-false delete-app-data predicate. The full argv
allowlist rejects delete-app-data, allusers, directory overrides, and every
other unrecognized option.

## Compile normally

Use an already installed official Unicode NSIS 3.x distribution with its
standard LogicLib, x64, MUI2, System, and UserInfo includes/plugins. The helper
requires the normal **x86 Unicode installer stub**, even on x64 Windows.

From this directory on Windows:

```powershell
& 'C:\Program Files (x86)\NSIS\makensis.exe' /V3 fixture.nsi
```

Or use the compile-only wrapper:

```powershell
node scripts/fixture.mjs compile --makensis 'C:\Program Files (x86)\NSIS\makensis.exe'
```

The wrapper verifies the helper fingerprint and source contract, invokes only
the installed compiler, and reports the resulting fixture.exe fingerprint.
It **never executes fixture.exe**. It has no `run` command and downloads or
installs nothing. No compiler defines can change the fixed application leaf,
GUID, registry keys, or helper. The output is an unsigned test fixture; any
Windows warning remains for the operator to handle normally.

## Publisher-owned actual Windows probe

Run this only in a disposable, clean Windows context with no Luheng Office
Agent application records. The publisher/operator owns the actual execution.
Use the token Windows provides by default. Do not change privileges, elevate
the process, adjust ACLs, disable protections, or bypass Windows warnings or
PowerShell execution policy to make the probe pass.

`prepare` first performs read-only registry checks, then atomically creates a
new random nonce root directly under the process's existing local TEMP folder.
It creates only a new empty `parent`, a new empty `evidence`, an ownership marker,
and a run-config JSON file. Existing root names are never reused. The parent
exists before the helper runs. The fixed target is:

`<TEMP>\luheng-nsis-functional-<32 lowercase hex>\parent\Luheng Office Agent`

Application GUID: `20be089a-e364-59fe-9bf1-70ea22b78d3f`

Example for an actual GitHub Actions Windows runner, after compilation:

```powershell
$prepared = node scripts/fixture.mjs prepare --github-actions | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Preparation/preflight failed' }
$fixtureArgs = @($prepared.argv)
# This is the publisher's explicit actual probe, separate from the wrapper.
& $prepared.executable @fixtureArgs
$fixtureExit = $LASTEXITCODE
node scripts/fixture.mjs report --root $prepared.root --nonce $prepared.nonce --github-actions
if ($LASTEXITCODE -ne 0) { throw 'Evidence validation failed' }
if ($fixtureExit -ne 0) { throw "Actual helper fixture returned $fixtureExit" }
```

`--github-actions` requires both GITHUB_ACTIONS=true and RUNNER_OS=Windows.
Every prepare/preflight/report/compile wrapper operation requires the actual
win32 platform, including local operator use without that optional CI flag.
There is no Windows platform simulation or injected helper success. Local
operator use runs the same commands without `--github-actions`.

The exact installer arguments are three complete arguments:

`/S`, `/ROOT=<prepared.root>`, `/NONCE=<prepared.nonce>`

Use the generated argv array to preserve paths containing spaces. Do not add
NSIS `/D` or product options. `preflight --root ... --nonce ...` can repeat the
read-only gate before execution; it refuses a used evidence directory. A root
is single-use: prepare a new nonce root for each real attempt.

## Runtime boundaries and evidence

The installer first refuses **any existing product key**, including empty keys,
in HKCU and HKLM under both 32-bit and 64-bit registry views. The checked keys
are `Software\20be089a-e364-59fe-9bf1-70ea22b78d3f` and its normal Windows
Uninstall key. Unreadable keys also refuse the test. On 32-bit Windows both
requested wrapper views refer to that OS's available registry; the installer
checks its native view. The product keys are never written or removed.

It requires a canonical absolute fixed local TEMP path, the exact nonce-bound
ownership marker contents, existing ordinary root/parent/evidence directories,
an ordinary retained marker file, and an absent fixed APP leaf. The real helper
then checks and holds every target-parent ancestor and rejects reparse points.
The wrapper separately checks the same existing ancestry with literal paths.

It calls the untouched helper's real functions, in order:

1. luhengPreflightDirectory
2. luhengCreateDirectory, only after successful preflight
3. luhengFinishDirectory, only after successful creation

The helper's own unpredictable DELETE_ON_CLOSE sibling probe runs naturally.
There is no uninstaller, payload extraction, registry mutation, provider data,
credential data, privilege change, or existing-object owner/DACL repair.

`evidence\trace.ini` is a fresh CREATE_NEW UTF-16LE INI file outside NSIS's
plugin extraction directory. `report` reads it as pure data and creates a fresh
`evidence\result.json`. Neither file is sourced or evaluated as code. Evidence
includes each entered/exited stage, luidError, nativeStatus, nativeInformation,
nativeHandle, checkIdentity, ownedIdentity, ownedHandle, ready, current SID,
the actual owner SID, DACL control, ACE count, and read-back SDDL. Account type,
TokenElevation, and TokenElevationType describe the unchanged default token.

The globals are recorded **after each untouched helper returns**. The native
handle can correctly be zero after transfer/close; finish clears owned handles
and ready. If preflight fails, later stages are absent. Failure causes are
inferred from luidError and the final native globals, not from instrumentation
inside the helper. The fixture cannot expose every internal intermediate
operation. No source-contract or parser test is a Windows runtime pass.

After preserving flow evidence, cleanup may remove only the known newly created
empty APP directory. It reopens that leaf relative to its retained parent,
checks non-reparse directory attributes and the exact created file identity,
then sets FileDispositionInfo on that handle. Windows refuses a nonempty
directory. There is no recursive/path-based delete or link traversal. Unknown
or changed identity leaves the directory in place and is reported. The marker,
nonce root, parent, and evidence are retained for review; this artifact contains
no cleanup command for deleting them.

Exit 0 means helper flow and known-empty-directory cleanup succeeded. Exit 1
means helper/readback failure; exit 2 means flow succeeded but cleanup is not
confirmed; exit 20 means the front gate refused execution; exit 21 means fresh
evidence creation failed. A front-gate refusal does not create a trace file.

## Checks performed here

```sh
node --test tests/*.test.mjs
node scripts/fixture.mjs contract
node --check scripts/fixture.mjs
```

All 14 source-contract/argument/evidence tests pass in the supplied Linux
workspace. These verify byte identity, helper calls and dependencies, callbacks,
registry gates, fixed paths, marker data, handle-bound cleanup source, compiler
scope, actual-Windows gates, and report refusal of inconsistent evidence.
Parser tests use synthetic data to test rejection rules; they do not represent
an actual helper execution. No makensis is installed here. NSIS compilation,
PowerShell preflight, the actual Windows probe, native status/ACL readback, and
cleanup behavior are **unrun and unverified on Windows** until the publisher's
actual probe supplies evidence.

Token sizing diagnostic revision

The fixture itself now uses initialized output destinations as 0 rN. Its read-only TokenUser probe uses a valid queried token and compares original *i 0 .r3 against corrected *i 0 r3, recording immediate raw return, required length and Win32 error. The included product helper is the corrected initialized-output candidate b7190fdd950c88c94d421d33d60a3cc344f1a64b16c1c3ad6dcd6bda3afc9f2f; all other product helper bytes match the original, so this second fixture exercises actual corrected preflight/create/finish. This revision has 15 source contracts; compilation and Windows runtime of this revised fixture remain unrun here.
