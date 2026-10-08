"""Exercise the pinned NSIS extraction and upstream replacement functions in scratch only.

Run with uv run --with py7zr python selftest-nsis-long-paths.py --builder ... --makensis ... --work ...
The synthetic installers do not create registry entries, shortcuts, or launch a product.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import winreg

import py7zr

NS = runpy.run_path(str(Path(__file__).with_name("nsis_long_paths.py")))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("builder", "makensis", "work"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    root = args.work.resolve()
    if root.exists() or any(c in str(root) for c in '$"\n\r'):
        raise ValueError("A fresh scratch directory with a literal NSIS-safe path is required")
    root.mkdir(parents=True)
    staged = root / "templates"
    receipt = NS["prepare"](args.builder.resolve(), staged)
    # A relative payload path comparable to the real Python dependency tree.
    relative = "/".join(["a" * 70, "b" * 70, "c" * 70, "fixture.txt"])
    installed = root / "installed"
    backup = root / "old-install"
    assert 260 < len(str(installed / relative)) < 950
    expected = {}
    for version in ("A", "B"):
        data = f"Synthetic immutable payload {version}\n".encode()
        expected[version] = hashlib.sha256(data).hexdigest()
        with py7zr.SevenZipFile(root / f"{version}.7z", "w") as archive:
            archive.writestr(data, relative)
            archive.writestr(data, "short.txt")
    patched = (staged / "uninstaller.nsh").read_text()
    functions = patched[patched.index("Function un.atomicRMDir"):patched.index("!ifndef UNINSTALL_SECTION_NAME")]
    functions = functions.replace("Function un.", "Function probe.").replace("Call un.", "Call probe.")
    env = dict(os.environ, NSISDIR=str(args.makensis.resolve().parent))
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = 0

    def execute(name: str, action: str, version: str = "A") -> None:
        script = root / f"{name}.nsi"
        script.write_text(f'''Unicode true
Name "Synthetic long path fixture"
OutFile "{root / (name + '.exe')}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
!include LogicLib.nsh
!define BUILD_UNINSTALLER
!include "{staged / 'header.nsh'}"
!include extractAppPackage.nsh
!define UNINSTALL_FILENAME "synthetic-uninstaller.exe"
{functions}
Section
  StrCpy $INSTDIR "{installed}"
  !insertmacro LuhengExtendedPath $luhengInstallRoot $INSTDIR
  !insertmacro LuhengExtendedPath $luhengOldRoot "{backup}"
  InitPluginsDir
  File /oname=$PLUGINSDIR\\fixture.7z "{root / (version + '.7z')}"
  {action}
SectionEnd
''', encoding="utf-8")
        result = subprocess.run([str(args.makensis.resolve()), "/V4", str(script)], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        (root / f"{name}-compile.log").write_text(result.stdout)
        if result.returncode:
            raise RuntimeError(result.stdout[-6000:])
        subprocess.run([str(root / (name + ".exe"))], check=True, timeout=30,
                       startupinfo=startup, creationflags=subprocess.CREATE_NO_WINDOW)

    def check(directory: Path, version: str) -> None:
        assert {p.relative_to(directory).as_posix() for p in directory.rglob("*") if p.is_file()} == {relative, "short.txt"}
        for name in (relative, "short.txt"):
            assert hashlib.sha256((directory / name).read_bytes()).hexdigest() == expected[version]

    # No longPathAware manifest is emitted. Extended roots must carry the behavior.
    execute("install", 'SetOutPath $INSTDIR\n!insertmacro extractUsing7za "$PLUGINSDIR\\fixture.7z"')
    check(installed, "A")
    # Deny sharing on the deep file to exercise upstream failure rollback.
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                  ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateFileW("\\\\?\\" + str(installed / relative), 0x80000000, 0, None, 3, 0, None)
    if handle == ctypes.c_void_p(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        execute("blocked-rollback", '''CreateDirectory $luhengOldRoot
Push ""
Call probe.atomicRMDir
Pop $R0
StrCmp $R0 0 unexpected_success
Push ""
Call probe.restoreFiles
Pop $R0
Goto rollback_done
unexpected_success:
SetErrorLevel 3
rollback_done:''')
    finally:
        kernel.CloseHandle(handle)
    check(installed, "A")
    assert not any(p.is_file() for p in backup.rglob("*"))
    move = '''CreateDirectory $luhengOldRoot
Push ""
Call probe.atomicRMDir
Pop $R0
StrCmp $R0 0 +3
SetErrorLevel 2
Quit'''
    execute("move", move)
    check(backup, "A")
    assert not any(p.is_file() for p in installed.rglob("*"))
    execute("restore", 'Push ""\nCall probe.restoreFiles\nPop $R0')
    check(installed, "A")
    assert not any(p.is_file() for p in backup.rglob("*"))
    execute("replace", move + '\nSetOutPath $TEMP\nRMDir /r $luhengInstallRoot\n'
            'RMDir /r $luhengOldRoot\nSetOutPath $INSTDIR\n'
            '!insertmacro extractUsing7za "$PLUGINSDIR\\fixture.7z"', "B")
    check(installed, "B")
    assert not backup.exists()
    execute("uninstall", 'SetOutPath $TEMP\nRMDir /r $luhengInstallRoot\nRMDir /r $luhengOldRoot')
    assert not installed.exists() and not backup.exists()
    # Negative supplier and stale-output cases must stop before emitting new templates.
    try:
        NS["prepare"](args.builder.resolve(), staged)
    except ValueError:
        pass
    else:
        raise AssertionError("Stale wrapper accepted")
    tampered = root / "tampered-builder"
    (tampered / "templates/nsis").mkdir(parents=True)
    shutil.copyfile(args.builder / "package.json", tampered / "package.json")
    for name in NS["TEMPLATE_HASHES"]:
        target = tampered / "templates/nsis" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.builder / "templates/nsis" / name, target)
    with (tampered / "templates/nsis/include/extractAppPackage.nsh").open("ab") as stream:
        stream.write(b"\n; tampered supplier\n")
    rejected = root / "must-not-exist"
    try:
        NS["prepare"](tampered, rejected)
    except ValueError as error:
        assert "checksum differs" in str(error)
    else:
        raise AssertionError("Changed supplier template accepted")
    assert not rejected.exists()
    subprocess.run([args.node, str(Path(__file__).with_name("nsis-compile-probe.mjs")),
                    str(root), str(args.builder.resolve())], check=True)
    for mode in ("installer", "uninstaller"):
        result = subprocess.run([str(args.makensis.resolve()), "/WX", "/V4",
                                 str(root / f"official-{mode}.nsi")], env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        (root / f"official-{mode}-compile.log").write_text(result.stdout)
        if result.returncode:
            raise RuntimeError(result.stdout[-6000:])
        assert "!insertmacro: LuhengExtendedPath" in result.stdout
        if mode == "installer":
            assert '!include: "extractAppPackage.nsh"' in result.stdout
            assert 'LoopExtract7za' not in result.stdout
        else:
            assert 'Rename: $luhengInstallRoot$R0\\$R2->$luhengOldRoot$R0\\$R2' in result.stdout
            assert 'RMDir: /r "$luhengOldRoot"' in result.stdout
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\FileSystem") as key:
        policy = winreg.QueryValueEx(key, "LongPathsEnabled")[0]
    report = {"status": "passed", "pathLength": len(str(installed / relative)),
              "manifestLongPathAware": False, "observedLongPathsEnabled": policy,
              "stages": ["install", "blocked-file-rollback", "atomic-move", "restore", "replace", "uninstall"],
              "officialCompilerPasses": ["installer-WX", "uninstaller-WX"],
              "payloadHashes": expected, "wrapper": receipt}
    (root / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
