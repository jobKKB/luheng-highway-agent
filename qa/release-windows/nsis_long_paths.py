"""Adapt the pinned upstream NSIS script without changing packaged application bytes."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

TEMPLATE_HASHES = {
    "assistedInstaller.nsh": "8aa1230e9717b428664d613fcc5c6a060883410b34cb7853b517fe11b4ee0a76",
    "common.nsh": "281e8071663d2ef3e9f00bb27e6ef09d2c2b52b85458da07082f2b186100e259",
    "multiUser.nsh": "9aca256695c289ec8a875143101fae8c6236bc8c6a7cf369bbe8b4986e09c9cb",
    "multiUserUi.nsh": "f7a4524244e68dc0782a759e076e5e55fadef0f22bbccf33100a4ab59d69c066",
    "oneClick.nsh": "87d6c095f37716759c8d9373dcab906394546007abb626c04e1c784158f6de5b",
    "installer.nsi": "8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8",
    "installSection.nsh": "f45a19cda4d5277629dd83e45891d282d96b4eddd87d363c315d8b7bae51aa51",
    "include/installer.nsh": "0e319437dd01dcbf911f3f48f664fde0cefbaef704f1cdb1739f63d563f5d4a0",
    "include/extractAppPackage.nsh": "e4174388a0f7a1df0b85a0742aa1ea7a4b2b18f9f29dccd6ef10a66212f68148",
    "uninstaller.nsh": "9ee2dac4593478083e8aa6f8487287ce9401006ccd50ecc538871d133ea4a42c",
}

LONG_PATH_MACRO = r'''
; Explicit extended paths work without changing Windows LongPathsEnabled policy.
!macro LuhengExtendedPath OUTPUT INPUT
  Push $R9
  StrCpy $R9 "${INPUT}" 4
  ${If} $R9 == "\\?\"
    StrCpy ${OUTPUT} "${INPUT}"
  ${Else}
    StrCpy $R9 "${INPUT}" 2
    ${If} $R9 == "\\"
      StrCpy $R9 "${INPUT}" "" 2
      StrCpy ${OUTPUT} "\\?\UNC\$R9"
    ${Else}
      StrCpy ${OUTPUT} "\\?\${INPUT}"
    ${EndIf}
  ${EndIf}
  Pop $R9
!macroend
'''

EXTRACT_MACRO = r'''!macro extractUsing7za FILE
  ; The upstream plugin accepts extended paths but its automatic retry is disabled.
  ; SHFileOperation-based CopyFiles cannot move long paths, even with a manifest.
  Push $OUTDIR
  !insertmacro LuhengExtendedPath $OUTDIR $OUTDIR
  Nsis7z::Extract "${FILE}"
  Pop $OUTDIR
!macroend
'''


def replace_once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise ValueError(f"Pinned NSIS template shape changed: {old!r}")
    return text.replace(old, new)


def prepare(builder: Path, destination: Path) -> dict:
    """Use nsis.include and NSIS !cd; retain upstream two-pass uninstaller generation."""
    if json.loads((builder / "package.json").read_text())["version"] != "27.0.0-alpha.6":
        raise ValueError("Unexpected NSIS template supplier")
    if destination.exists():
        raise ValueError("Long-path NSIS templates must be generated into a fresh directory")
    template_root = builder / "templates/nsis"
    originals = {}
    for name, digest in TEMPLATE_HASHES.items():
        data = (template_root / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError(f"NSIS template checksum differs: {name}")
        originals[name] = data.decode("utf-8").replace("\r\n", "\n")
    destination = destination.resolve()
    if any(character in str(path) for path in (destination, template_root) for character in '$"\n\r'):
        raise ValueError("NSIS script directory contains an unsafe literal character")

    # NSIS searches its current compiler directory before include directories.
    # Keep the original main script so electron-builder still builds the uninstaller.
    adapted = {"installer.nsh": originals["include/installer.nsh"],
        "header.nsh": f'!addincludedir "{template_root.resolve()}"\n!cd "{destination}"\n'
        + LONG_PATH_MACRO + '\n!ifdef BUILD_UNINSTALLER\nVar luhengInstallRoot\nVar luhengOldRoot\n!endif\n'}
    # Preserve current-directory precedence: NSIS itself ships a different MultiUser.nsh.
    for name, content in originals.items():
        if "/" not in name and name.endswith(".nsh"):
            adapted[name] = content
    # A per-user installer must retain its token, even when Explorer is elevated.
    adapted["assistedInstaller.nsh"] = replace_once(originals["assistedInstaller.nsh"],
        '        ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"',
        '        ClearErrors\n'
        '        Exec \'"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" $1\'\n'
        '        IfErrors 0 +2\n'
        '        MessageBox MB_OK|MB_ICONSTOP "Unable to start the installed application."')
    extraction = originals["include/extractAppPackage.nsh"]
    start = extraction.index("!macro extractUsing7za FILE\n")
    if not extraction[start:].rstrip().endswith("!macroend"):
        raise ValueError("Unexpected extraction macro suffix")
    adapted["extractAppPackage.nsh"] = extraction[:start] + EXTRACT_MACRO
    uninstall = originals["uninstaller.nsh"]
    uninstall = replace_once(uninstall, "  !insertmacro initMultiUser\n",
        '  !insertmacro initMultiUser\n  InitPluginsDir\n'
        '  !insertmacro LuhengExtendedPath $luhengInstallRoot $INSTDIR\n'
        '  !insertmacro LuhengExtendedPath $luhengOldRoot "$PLUGINSDIR\\old-install"\n')
    # Keep the upstream per-file move/rollback sequence; only its filesystem roots change.
    uninstall = uninstall.replace("$INSTDIR$R0", "$luhengInstallRoot$R0")
    uninstall = uninstall.replace("$PLUGINSDIR\\old-install", "$luhengOldRoot")
    # Restore the initialization input after replacing the filesystem operations.
    uninstall = uninstall.replace('LuhengExtendedPath $luhengOldRoot "$luhengOldRoot"',
                                  'LuhengExtendedPath $luhengOldRoot "$PLUGINSDIR\\old-install"')
    uninstall = replace_once(uninstall, "    RMDir /r $INSTDIR\n",
        '    RMDir /r $luhengInstallRoot\n'
        '    ; NSIS automatic plugin cleanup also uses ordinary paths.\n'
        '    RMDir /r $luhengOldRoot\n')
    adapted["uninstaller.nsh"] = uninstall
    for name, text in adapted.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
    return {"schema": 1, "builder": "27.0.0-alpha.6", "mechanism": "official-nsis-include-extended-paths",
            "original_templates": TEMPLATE_HASHES,
            "generated_templates": {name: hashlib.sha256((destination / name).read_bytes()).hexdigest()
                                    for name in adapted}}
