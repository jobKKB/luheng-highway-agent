"""Qualify same-job installer custody without inventing uploaded artifact IDs."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import runpy

consumer = runpy.run_path(str(Path(__file__).resolve().parents[1] / "native-installer-consumer/verify_consumer.py"))
update_policy = runpy.run_path(str(Path(__file__).resolve().parents[1] / "hermes-native/verify-contained-candidate.py"))
require, owned, read_json, sha = (consumer[key] for key in ("require", "owned", "read_json", "sha"))


def pin(evidence, path):
    relative = Path(path).absolute().relative_to(Path(evidence).absolute()).as_posix()
    path = owned(evidence, relative)
    require(path.is_file(), "Evidence file missing: " + relative)
    return {"path": relative, "bytes": path.stat().st_size, "sha256": sha(path)}


def prepare(evidence, receipt, lifecycle_mode="restricted-token-same-user"):
    evidence = Path(evidence).absolute()
    files = {
        "sourceAdmission": pin(evidence, evidence / "source-admission.json"),
        "structure": pin(evidence, evidence / "windows-unpacked-structure.json"),
        "health": pin(evidence, evidence / "native-smoke-evidence/native-startup.json"),
        "installerReceipt": pin(evidence, receipt),
    }
    admission, structure, health, build = (read_json(owned(evidence, files[key]["path"]))
                                         for key in files)
    require(lifecycle_mode in ("restricted-token-same-user", "elevated-runner-explicitly-limited"),
            "Unknown lifecycle coverage")
    require(admission["source_only"] is True and admission["license_preserved"] is True,
            "Source admission did not pass")
    require(consumer["COMMIT"].fullmatch(admission["source_commit"]) and
            consumer["HEX"].fullmatch(admission["source_tree_sha256"]) and
            type(admission["source_count"]) is int and admission["source_count"] > 0,
            "Invalid admitted source identity")
    for key in ("source_commit", "source_tree_sha256", "source_count"):
        require(structure[key] == admission[key], "Structure and admitted source differ: " + key)
    require(structure["schema"] == 2 and structure["target"] == "win32-x64" and
            structure["artifact_kind"] == "official-prepared-unpacked-Windows-x64-build-only" and
            structure["desktop_and_embedded_cli_stamp_match"] is True and
            structure["production_update_enabled"] is True and
            structure["update_mechanism"] == "electron-updater", "Unqualified payload structure")
    update_policy["validate_update_policy"](structure["update_stamp"])
    update_policy["validate_update_configuration"](structure["update_configuration"])
    require(structure["update_stamp"]["commit"] == admission["source_commit"] and
            structure["update_stamp"]["baseVersion"] == structure["base_version"],
            "Update authority is stamped for a different payload")
    require(re.fullmatch(r"\d+\.\d+\.\d+", structure["base_version"]), "Invalid product version")
    inventory = structure["files"]
    names = set()
    for row in inventory:
        consumer["safe_name"](row["path"])
        require(row["path"].casefold() not in names and type(row["bytes"]) is int and
                row["bytes"] >= 0 and consumer["HEX"].fullmatch(row["sha256"]),
                "Invalid or case-conflicting payload inventory")
        names.add(row["path"].casefold())
    require("luhengofficeagent.exe" in names, "Desktop entry missing")
    require("resources/app-update.yml" in names, "Immutable updater configuration missing")
    run_id = build["custody"]["runId"]
    require(re.fullmatch(r"[1-9][0-9]*", str(run_id)), "Missing producer run ID")
    if os.environ.get("GITHUB_RUN_ID"):
        require(str(run_id) == os.environ["GITHUB_RUN_ID"], "Contract is not from this producer run")
    require(health["native_windows"] is True and health["architecture"] == "X64" and
            health["plain_launch"] is True and health["contained_backend_health"] is True and
            health["normal_window_close"] is True and health["forced_cleanup"] is False and
            health["error"] is None and health["health_version"] == structure["base_version"] and
            str(health["build_run_id"]) == str(run_id), "Native startup did not qualify this run/version")
    expected_payload = {"sourceCommit": admission["source_commit"],
                        "sourceTreeSha256": admission["source_tree_sha256"],
                        "sourceCount": admission["source_count"], "baseVersion": structure["base_version"],
                        "fileCount": len(inventory), "rebuilt": False}
    require(build["schema"] == 1 and build["signed"] is False and
            all(build["payload"][key] == value for key, value in expected_payload.items()) and
            build["payload"]["rebuilt"] is False, "Installer wraps a different or rebuilt payload")
    require(build["custody"]["manifestSha256"] == files["structure"]["sha256"] and
            build["custody"]["nativeHealthSha256"] == files["health"]["sha256"],
            "Installer custody points to different structure/native evidence")
    installer = Path(build["installer"])
    require(installer.is_absolute(), "Installer path must be absolute")
    installer_pin = pin(evidence, installer)
    require(type(build["bytes"]) is int and build["bytes"] > 0 and
            installer_pin["bytes"] == build["bytes"] and installer_pin["sha256"] == build["sha256"],
            "Installer bytes differ from the build receipt")
    with installer.open("rb") as stream:
        require(stream.read(2) == b"MZ", "Installer is not a Windows executable")
    return {"schema": 1, "scope": "same-job", "qualified": True,
            "repository": "jobKKB/luheng-highway-agent", "build": {"runId": int(run_id)},
            "source": {"commit": admission["source_commit"], "treeSha256": admission["source_tree_sha256"],
                       "count": admission["source_count"], "baseVersion": structure["base_version"]},
            "evidenceFiles": files, "installer": installer_pin, "lifecycleMode": lifecycle_mode}


def validate_contract(path, evidence):
    pins = read_json(path)
    require(pins["scope"] == "same-job" and pins["qualified"] is True,
            "Expected a qualified same-job contract")
    actual = prepare(evidence, owned(evidence, pins["evidenceFiles"]["installerReceipt"]["path"]),
                     pins["lifecycleMode"])
    require(pins == actual, "Contract differs from its original qualified evidence")
    return pins


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--build-receipt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--lifecycle-mode", default="restricted-token-same-user",
                        choices=["restricted-token-same-user", "elevated-runner-explicitly-limited"])
    args = parser.parse_args()
    result = prepare(args.evidence, args.build_receipt, args.lifecycle_mode)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
