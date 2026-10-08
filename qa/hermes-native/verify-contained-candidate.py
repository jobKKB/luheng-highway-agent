"""Bind an unpacked build's structure to the admitted source. Do not launch it."""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import re


def owned(root, relative, directory=False):
    if not isinstance(relative, str) or not relative or "\\" in relative or ":" in relative:
        raise ValueError("Unsafe contained path")
    parts = relative.split("/")
    if PurePosixPath(relative).is_absolute() or any(part in ("", ".", "..") for part in parts):
        raise ValueError("Unsafe contained path")
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise ValueError("Contained path crosses a link or junction")
    if not path.resolve().is_relative_to(root.resolve()) or not (path.is_dir() if directory else path.is_file()):
        raise ValueError("Missing or unowned contained path")
    return path


def inspect_candidate(source, prepared_path, identity):
    admission = json.loads((source.parent / "source-admission.json").read_text(encoding="utf-8-sig"))
    commit = (source.parent / "admitted-source-sha.txt").read_text(encoding="utf-8-sig").strip()
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or admission["source_commit"] != commit:
        raise ValueError("Admitted source commit differs")
    for key in ("source_count", "source_tree_sha256", "upstream_commit"):
        if admission[key] != identity[key]:
            raise ValueError("Source receipt differs from the frozen controller pin")
    if not admission.get("source_only"):
        raise ValueError("Missing source-only admission")
    prepared = json.loads(prepared_path.read_text(encoding="utf-8-sig"))
    request = prepared["request"]
    if request["commit"] != commit or Path(request["source"]).resolve() != source or request["variant"] != "bundled" or not request["target"].startswith("win32-x64"):
        raise ValueError("Preparation is not for this admitted bundled Windows x64 source")
    root = owned(source, "apps/desktop/release/win-unpacked", directory=True)
    owned(root, identity["artifact_contract"]["desktop_executable"])
    owned(root, identity["artifact_contract"]["electron_archive"])
    resources = owned(root, "resources", directory=True)
    payload = owned(resources, "agent-payload", directory=True)
    stamp_path = owned(resources, "install-stamp.json")
    stamp = json.loads(stamp_path.read_text(encoding="utf-8-sig"))
    manifest = json.loads(owned(payload, "manifest.json").read_text(encoding="utf-8-sig"))
    if stamp["commit"] != commit or stamp.get("dirty") or stamp["payload"] != "bundled" or not manifest["target"].startswith("win32-x64"):
        raise ValueError("Unpacked artifact provenance or target differs")
    if stamp.get("desktopReleasePolicy", {}).get("enabled") or stamp.get("updateMechanism") != "external":
        raise ValueError("Build-only candidate must keep production updates disabled")
    if stamp["runtime"] != manifest["runtime"]:
        raise ValueError("Stamp and payload runtime contracts differ")
    runtime = manifest["runtime"]
    commands = runtime["commands"]
    if not commands or "hermes" not in commands:
        raise ValueError("Missing contained launcher contract")
    for relative in commands.values():
        owned(payload, relative)
    owned(payload, runtime["storePython"])
    owned(payload, runtime["sitePackages"], directory=True)
    repo = owned(payload, runtime["repoDir"], directory=True)
    nested_stamp_path = owned(repo, "install-stamp.json")
    nested_stamp = json.loads(nested_stamp_path.read_text(encoding="utf-8-sig"))
    if nested_stamp != stamp:
        raise ValueError("Embedded CLI and desktop source stamps differ")
    files = []
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise ValueError("Artifact tree contains an unadmitted link")
        if path.is_file():
            owned(root, relative)
            with path.open("rb") as handle:
                digest = hashlib.file_digest(handle, "sha256").hexdigest()
            files.append({"path": relative, "bytes": path.stat().st_size, "sha256": digest})
    extra_packages = sorted(path.name for path in root.parent.iterdir()
                            if path.is_file() and path.suffix.lower() in {".msix", ".msixbundle", ".msi", ".exe"})
    return {"schema": 2, "artifact_kind": "official-prepared-unpacked-Windows-x64-build-only",
            "structural_only": True, "source_commit": commit,
            "source_tree_sha256": identity["source_tree_sha256"], "source_count": identity["source_count"],
            "target": manifest["target"], "base_version": stamp["baseVersion"],
            "desktop_and_embedded_cli_stamp_match": True, "contained_commands": sorted(commands),
            "installer_produced": bool(extra_packages), "native_packages_not_delivered": extra_packages,
            "unpacked_only_delivered": True, "native_installation_verified": False,
            "offline_startup_verified": False, "physical_ime_verified": False,
            "standard_user_installation_verified": False, "update_verified": False,
            "production_update_enabled": False, "files": files}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("prepared", type=Path)
    args = parser.parse_args()
    source = args.source.resolve()
    identity = json.loads((Path(__file__).parent / "source-identity.json").read_text(encoding="utf-8"))
    result = inspect_candidate(source, args.prepared.resolve(), identity)
    output = source.parent / "windows-unpacked-structure.json"
    output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: value for key, value in result.items() if key != "files"}))


if __name__ == "__main__":
    main()
