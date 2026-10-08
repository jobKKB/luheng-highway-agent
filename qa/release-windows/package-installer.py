"""Wrap an admitted Windows payload with the source's prepared NSIS tools."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def regular_path(path: Path, *, directory: bool = False) -> Path:
    path = path.absolute()
    for part in (path, *path.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise ValueError(f"Input crosses a link or junction: {path}")
    if not (path.is_dir() if directory else path.is_file()):
        raise ValueError(f"Missing input: {path}")
    return path.resolve()


def validate_inputs(args: argparse.Namespace) -> tuple[Path, Path, dict]:
    source = regular_path(args.source, directory=True)
    for key in ("prepared", "structure", "health", "archive"):
        setattr(args, key, regular_path(getattr(args, key)))
    if not re.fullmatch(r"[1-9][0-9]*", args.run_id):
        raise ValueError("An actual positive GitHub run ID is required")
    if args.archive.suffix.lower() != ".7z" or args.archive.stat().st_size == 0:
        raise ValueError("The pristine portable 7z archive is required")
    with args.archive.open("rb") as stream:
        if stream.read(6) != b"7z\xbc\xaf\x27\x1c":
            raise ValueError("The portable input is not a 7z archive")
    output = args.output.absolute()
    for part in (output, *output.parents):
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise ValueError("Installer output crosses a link or junction")
    output = output.resolve()
    if output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError("Installer output must be separate from the source checkout")
    if output.exists():
        raise ValueError("Installer output must be fresh; existing files are preserved")
    prepared = read_json(args.prepared)
    request = prepared["request"]
    if (prepared["schema"] != 1 or Path(request["source"]).resolve() != source
            or request["target"] != "win32-x64" or request["variant"] != "bundled"
            or request.get("channel_request") is not None or request.get("tag") is not None):
        raise ValueError("Expected this source's prepared bundled Windows commit build")
    structure = read_json(args.structure)
    if structure["source_commit"] != request["commit"] or structure["base_version"] != request["version"]:
        raise ValueError("Prepared request and immutable payload identity differ")
    regular_path(source / "apps/desktop/release/win-unpacked", directory=True)
    if (source / "apps/desktop/release/nsis-prepackaged-test").exists():
        raise ValueError("NSIS output already exists; refusing stale installer selection")
    return source, output, prepared


def package(args: argparse.Namespace) -> dict:
    if sys.platform != "win32":
        raise ValueError("NSIS packaging requires native Windows")
    source, output, _ = validate_inputs(args)
    sys.path.insert(0, str(source))
    from scripts.bundles.desktop_prepare import PreparedDesktop
    from scripts.bundles.desktop_inputs import build_environment

    prepared = PreparedDesktop.load(args.prepared)
    # Keep the original prepared receipt intact: NSIS adds tools, not a rebuild.
    tools = prepared.request.work / "nsis-packager"
    if tools.exists():
        raise ValueError("NSIS preparation directory must be fresh")
    env = build_environment(prepared, "bundled", os.environ)
    for key in list(env):
        if re.search(r"TOKEN|SECRET|PASSWORD|API_KEY|CSC_LINK|AZURE_SIGN|APPLE_ID", key, re.I):
            env.pop(key)
    env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
    scripts = source / "apps/desktop/scripts"
    payload = source / "apps/desktop/release/win-unpacked"
    node = str(regular_path(prepared.node))

    def run(script: str, *values: object) -> None:
        subprocess.run([node, str(scripts / script), *map(str, values)],
                       cwd=source, env=env, check=True)

    run("prepare-packaging-tools.mjs", "--source", source, "--out", tools,
        "--cache", prepared.request.cache / "packager", "--target", "win32-x64", "--format", "nsis")
    packaging = tools / "prepared.json"
    run("prepared-prepackaged.mjs", "--source", source, "--prepared", packaging,
        "--prepackaged", payload, "--payload-manifest", args.structure,
        "--payload-manifest-sha256", sha256(args.structure), "--native-health", args.health,
        "--native-health-sha256", sha256(args.health), "--run-id", args.run_id,
        "--archive", args.archive, "--archive-sha256", sha256(args.archive),
        "--archive-bytes", args.archive.stat().st_size)
    receipt = tools / "prepackaged.prepared.json"
    command = ("--prepared", packaging, "--native-deps", prepared.native,
               "--prepackaged", payload, "--prepackaged-receipt", receipt, "--win", "nsis", "--x64")
    run("run-electron-builder.mjs", "--validate-only", *command)
    run("run-electron-builder.mjs", *command)
    installers = list((source / "apps/desktop/release/nsis-prepackaged-test").glob("*.exe"))
    if len(installers) != 1:
        raise ValueError("Expected exactly one newly built NSIS installer")
    installer = regular_path(installers[0])
    with installer.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("NSIS output is not a Windows executable")
    digest = sha256(installer)
    custody = read_json(receipt)
    output.mkdir(parents=True)
    destination = output / installer.name
    shutil.copyfile(installer, destination)
    if sha256(destination) != digest:
        raise ValueError("Copied installer checksum differs")
    result = {"schema": 1, "installer": str(destination), "bytes": destination.stat().st_size,
              "sha256": digest, "signed": False, "payload": custody["payload"],
              "custody": custody["custody"], "installation_verified": False,
              "published": False, "prepared_desktop": str(args.prepared),
              "prepared_nsis": str(packaging)}
    (output / "SHA256SUMS").write_text(f"{digest}  {destination.name}\n", encoding="utf-8")
    (output / "installer-build.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "prepared", "structure", "health", "archive", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--run-id", required=True)
    print(json.dumps(package(parser.parse_args()), indent=2))


if __name__ == "__main__":
    main()
