"""Private artifact admission. Stdlib only; never build, install, or repair."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat

HEX = re.compile(r"[a-f0-9]{64}\Z")
COMMIT = re.compile(r"[a-f0-9]{40}\Z")
NSIS_PACKAGE_TYPE = {"path": "resources/package-type", "bytes": 4,
                     "sha256": hashlib.sha256(b"nsis").hexdigest()}


def require(value, message):
    if not value:
        raise ValueError(message)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def safe_name(value):
    require(isinstance(value, str) and value and "\\" not in value and ":" not in value,
            "Unsafe Windows path")
    parts = value.split("/")
    require(not PurePosixPath(value).is_absolute() and all(p not in ("", ".", "..") for p in parts),
            "Unsafe Windows path")
    for part in parts:
        stem = part.split(".", 1)[0].upper()
        require(not part.endswith((".", " ")) and not any(ord(c) < 32 or c in '<>"|?*' for c in part),
                "Windows-aliased path")
        require(stem not in {"CON", "PRN", "AUX", "NUL"} | {
            f"{prefix}{number}" for prefix in ("COM", "LPT") for number in range(1, 10)},
            "Reserved Windows filename")
    return parts


def owned(root, name):
    current = Path(root)
    # Include the root and every existing ancestor, not only the final file.
    for ancestor in [current, *current.parents]:
        require(not ancestor.is_symlink() and not (hasattr(ancestor, "is_junction") and ancestor.is_junction()),
                "Input ancestor crosses a link/junction")
    for part in safe_name(name):
        current /= part
        require(not current.is_symlink() and not (hasattr(current, "is_junction") and current.is_junction()),
                "Input path crosses a link/junction")
    require(current.resolve().is_relative_to(Path(root).resolve()), "Input escapes its root")
    return current


def contract(path):
    value = read_json(path)
    require(value["schema"] == 1 and value["qualified"] is True,
            "Qualification pins are placeholders; do not run this draft")
    require(value["repository"] == "jobKKB/luheng-highway-agent", "Unexpected repository")
    require(type(value["build"]["runId"]) is int and value["build"]["runId"] > 0 and
            COMMIT.fullmatch(value["build"]["head"]) and value["build"]["runAttempt"] == 1 and
            value["build"]["workflowPath"] == ".github/workflows/hermes-native-package-experiment.yml",
            "Missing explicitly reviewed build identity")
    require(value["source"]["treeSha256"] == "d37c08c19b1e57ce4829682c4f84ec5fc89bf1fd3c5fc56e0e2b7153f462b4cb"
            and value["source"]["count"] == 17260 and COMMIT.fullmatch(value["source"]["commit"]),
            "Unqualified payload source identity")
    for key in ("portableArtifact", "evidenceArtifact"):
        a = value[key]
        require(type(a["id"]) is int and a["id"] > 0 and type(a["bytes"]) is int and a["bytes"] > 0
                and a["digest"].startswith("sha256:") and HEX.fullmatch(a["digest"][7:]),
                "Artifact identity pins missing")
    require(value["portableArtifact"]["id"] != value["evidenceArtifact"]["id"], "Separate artifacts required")
    for item in [value["archive"], *value["evidenceFiles"].values()]:
        safe_name(item["path"])
        require(type(item["bytes"]) is int and item["bytes"] > 0 and HEX.fullmatch(item["sha256"]),
                "Missing immutable byte pin")
    require(value["archive"]["path"] == "Luheng-Windows-x64-verified.7z", "Unexpected portable format")
    require(type(value["minimumScratchBytes"]) is int and value["minimumScratchBytes"] >= 20 * 1024**3,
            "Reviewed scratch budget missing")
    return value


def verify_file(root, row):
    path = owned(root, row["path"])
    require(path.is_file() and path.stat().st_size == row["bytes"] and sha(path) == row["sha256"],
            "Pinned file differs: " + row["path"])
    return path


def verify_downloads(pins, portable, evidence):
    archive = verify_file(portable, pins["archive"])
    require({p.relative_to(portable).as_posix() for p in Path(portable).rglob("*") if p.is_file()}
            == {pins["archive"]["path"], "SHA256SUMS"}, "Portable artifact membership differs")
    sums = owned(portable, "SHA256SUMS").read_text(encoding="utf-8-sig").splitlines()
    require(sums == [pins["archive"]["sha256"] + "  " + pins["archive"]["path"]], "Archive checksum sidecar differs")
    paths = {name: verify_file(evidence, row) for name, row in pins["evidenceFiles"].items()}
    manifest = read_json(paths["structure"])
    health = read_json(paths["health"])
    admission = read_json(paths["sourceAdmission"])
    portable_receipt = read_json(paths["portableReceipt"])
    source = pins["source"]
    for value in (manifest, admission, portable_receipt):
        require(value["source_commit"] == source["commit"] and value["source_tree_sha256"] == source["treeSha256"],
                "Original evidence source identity differs")
    require(manifest["source_count"] == admission["source_count"] == source["count"], "Original source count differs")
    require(manifest["schema"] == 2 and manifest["target"] == "win32-x64" and
            manifest["artifact_kind"] == "official-prepared-unpacked-Windows-x64-build-only" and
            manifest["desktop_and_embedded_cli_stamp_match"] is True and
            manifest["production_update_enabled"] is False, "Unqualified payload manifest")
    require(manifest["base_version"] == pins["source"]["baseVersion"], "Original version differs")
    require(health["native_windows"] is True and health["architecture"] == "X64" and
            health["plain_launch"] is True and health["contained_backend_health"] is True and
            health["normal_window_close"] is True and health["forced_cleanup"] is False and
            health["error"] is None and health["health_version"] == manifest["base_version"] and
            str(health["build_run_id"]) == str(pins["build"]["runId"]), "Original native startup is not qualified")
    require(portable_receipt["archive"] == archive.name and portable_receipt["sha256"] == pins["archive"]["sha256"]
            and portable_receipt["bytes"] == pins["archive"]["bytes"] and
            portable_receipt["compression_before_any_launch"] is True and
            portable_receipt["seven_zip_roundtrip_every_file_sha256_verified"] is True and
            portable_receipt["all_hidden_files_included"] is True, "Pristine portable custody differs")
    # Native regression log is pinned as evidence. Its pass condition is reviewed
    # in the producer run; a substring in a log is not independent test execution.
    return {"archive": str(archive), "structure": str(paths["structure"]), "health": str(paths["health"]),
            "source_commit": source["commit"], "source_tree_sha256": source["treeSha256"],
            "rebuilt": False, "download_admission_passed": True}


def verify_tree(root, manifest, uninstaller=None):
    root = Path(root)
    require(root.is_dir(), "Payload root missing")
    expected = {}
    folded = set()
    for row in manifest["files"]:
        safe_name(row["path"])
        require(row["path"] not in expected and row["path"].casefold() not in folded,
                "Duplicate/case-conflicting manifest rows")
        require(type(row["bytes"]) is int and row["bytes"] >= 0 and HEX.fullmatch(row["sha256"]), "Invalid manifest row")
        expected[row["path"]] = row
        folded.add(row["path"].casefold())
    require(expected, "Empty payload inventory")
    actual = set()
    actual_folded = set()
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            owned(root, relative)
            require(stat.S_ISREG(path.stat().st_mode) or path.is_dir(), "Nonregular payload entry")
        for name in files:
            relative = (Path(directory) / name).relative_to(root).as_posix()
            require(relative.casefold() not in actual_folded, "Case-conflicting payload files")
            actual.add(relative)
            actual_folded.add(relative.casefold())
    allowed = set()
    if uninstaller:
        require(re.fullmatch(r"Uninstall [^/\\]+\.exe", uninstaller), "Expected a root NSIS uninstaller")
        allowed = {uninstaller, NSIS_PACKAGE_TYPE["path"]}
        require(not (set(expected) & allowed), "Installer-generated files cannot replace original payload files")
    require(actual == set(expected) | allowed, "Exact payload membership differs")
    for row in expected.values():
        verify_file(root, row)
    generated = []
    if uninstaller:
        path = owned(root, uninstaller)
        require(path.is_file(), "Generated uninstaller missing")
        with path.open("rb") as stream:
            require(stream.read(2) == b"MZ", "Generated uninstaller is not a Windows executable")
        generated = [{"path": uninstaller, "bytes": path.stat().st_size, "sha256": sha(path)}]
        # The pinned NSIS template writes this exact four-byte install-method marker.
        # It is required only for installed trees and is never a wildcard exception.
        verify_file(root, NSIS_PACKAGE_TYPE)
        generated.append(dict(NSIS_PACKAGE_TYPE))
    return {"every_payload_file_sha256_verified": True, "exact_membership": True,
            "payload_files": len(expected), "payload_bytes": sum(row["bytes"] for row in expected.values()),
            "generated_installer_files": generated, "source_commit": manifest["source_commit"],
            "source_tree_sha256": manifest["source_tree_sha256"], "rebuilt": False}


def verify_archive_listing(listing, manifest):
    expected = {"Luheng-Windows-x64/" + row["path"]: row for row in manifest["files"]}
    require(len(expected) == len(manifest["files"]), "Duplicate payload rows")
    records = []
    current = {}
    for line in Path(listing).read_text(encoding="utf-8-sig").splitlines() + [""]:
        if not line.strip():
            if current:
                records.append(current)
                current = {}
        else:
            require(" = " in line, "Unexpected native 7z technical-list output")
            key, value = line.split(" = ", 1)
            require(key not in current, "Ambiguous native 7z listing record")
            current[key] = value
    seen = set()
    folded = set()
    files = set()
    for row in records:
        name = row["Path"].replace("\\", "/")
        safe_name(name)
        require(name not in seen and name.casefold() not in folded, "Duplicate/case-aliased archive paths")
        require(name == "Luheng-Windows-x64" or name.startswith("Luheng-Windows-x64/"), "Archive path escapes its root")
        seen.add(name)
        folded.add(name.casefold())
        require(not any("link" in key.casefold() or "reparse" in key.casefold() for key in row), "Archive links are forbidden")
        attributes = row.get("Attributes", "")
        require("l" not in attributes and "L" not in attributes, "Archive link attribute is forbidden")
        if attributes.startswith("D") or row.get("Folder") == "+":
            require(any(path.startswith(name + "/") for path in expected), "Unrecorded archive directory")
        else:
            require(name in expected and int(row["Size"]) == expected[name]["bytes"] and row.get("Encrypted", "-") == "-",
                    "Archive entry differs from the exact payload manifest")
            files.add(name)
    require(files == set(expected), "Archive membership omits or adds payload files")
    return {"archive_paths_admitted_before_extraction": True, "payload_files": len(files)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["contract", "downloads", "tree", "archive-listing"])
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--portable", type=Path)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--uninstaller")
    parser.add_argument("--listing", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    pins = contract(args.contract)
    if args.mode == "contract":
        result = {"pins_reviewed": True, "build_run_id": pins["build"]["runId"]}
    elif args.mode == "downloads":
        require(args.portable and args.evidence, "Both artifact roots are required")
        result = verify_downloads(pins, args.portable, args.evidence)
    elif args.mode == "tree":
        require(args.root and args.evidence, "Root and original evidence are required")
        path = verify_file(args.evidence, pins["evidenceFiles"]["structure"])
        result = verify_tree(args.root, read_json(path), args.uninstaller)
    else:
        require(args.listing and args.evidence, "Archive listing and original evidence required")
        path = verify_file(args.evidence, pins["evidenceFiles"]["structure"])
        result = verify_archive_listing(args.listing, read_json(path))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
