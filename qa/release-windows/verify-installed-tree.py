"""Verify exact installed bytes against qualified, same-job source evidence."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import runpy

contract = runpy.run_path(str(Path(__file__).with_name("prepare-lifecycle-contract.py")))
consumer = contract["consumer"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["contract", "tree", "self-test"])
    for name in ("contract", "evidence", "root", "output"):
        parser.add_argument("--" + name, type=Path)
    parser.add_argument("--uninstaller")
    args = parser.parse_args()
    if args.mode == "self-test":
        self_test()
        return
    consumer["require"](args.contract and args.evidence and args.output, "Contract, evidence and output required")
    pins = contract["validate_contract"](args.contract, args.evidence)
    result = {"same_job_custody_verified": pins["scope"] == "same-job", "scope": pins["scope"],
              "artifact_recovery_custody_verified": pins["scope"] == "artifact-recovery",
              "build_run_id": pins["build"]["runId"], "acceptance_run_id": pins.get("acceptance", {}).get("runId", pins["build"]["runId"])}
    if args.mode == "tree":
        consumer["require"](args.root, "Installed root required")
        if args.uninstaller:
            consumer["require"](re.fullmatch(r"Uninstall [^/\\]+\.exe", args.uninstaller),
                                "Only the root NSIS uninstaller can be an extra file")
        manifest = consumer["read_json"](consumer["verify_file"](args.evidence, pins["evidenceFiles"]["structure"]))
        result.update(consumer["verify_tree"](args.root, manifest, args.uninstaller))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result))


def self_test():
    """Exercise real file hashing and fail-closed custody/path checks on tiny fixtures."""
    import tempfile
    import unittest.mock

    def rejected(action):
        try:
            action()
        except (ValueError, KeyError):
            return
        raise AssertionError("Tampered input was accepted")

    with tempfile.TemporaryDirectory() as directory, unittest.mock.patch.dict("os.environ", {"GITHUB_RUN_ID": "1"}):
        root = Path(directory)
        installed = root / "installed"
        installed.mkdir()
        executable = installed / "LuhengOfficeAgent.exe"
        executable.write_bytes(b"MZ synthetic self-test payload")
        row = contract["pin"](installed, executable)
        update_file = installed / "resources/app-update.yml"
        update_file.parent.mkdir()
        update_file.write_text("provider: generic\nurl: https://apps.luotuai.me/updates/windows/\nchannel: latest\n", encoding="utf-8")
        update_row = contract["pin"](installed, update_file)
        admission = {"source_commit": "a" * 40, "source_tree_sha256": "b" * 64, "source_count": 1,
                     "source_only": True, "license_preserved": True}
        structure = {**admission, "schema": 2, "target": "win32-x64", "base_version": "0.7.0",
                     "artifact_kind": "official-prepared-unpacked-Windows-x64-build-only",
                     "desktop_and_embedded_cli_stamp_match": True, "production_update_enabled": True,
                     "update_mechanism": "electron-updater", "files": [row, update_row],
                     "update_stamp": {"desktopReleasePolicy": dict(contract["update_policy"]["UPDATE_POLICY"]),
                                      "source": "commit-build", "payload": "bundled", "distribution": "desktop-app",
                                      "dirty": False, "commit": admission["source_commit"], "baseVersion": "0.7.0",
                                      "channelBuild": None, "updateMechanism": "electron-updater"},
                     "update_configuration": {"provider": "generic", "url": "https://apps.luotuai.me/updates/windows/",
                                              "channel": "latest"}}
        health = {"native_windows": True, "architecture": "X64", "plain_launch": True,
                  "contained_backend_health": True, "normal_window_close": True, "forced_cleanup": False,
                  "error": None, "health_version": "0.7.0", "build_run_id": "1"}
        for name, value in (("source-admission.json", admission), ("windows-unpacked-structure.json", structure),
                            ("native-smoke-evidence/native-startup.json", health)):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value), encoding="utf-8")
        installer = root / "setup.exe"
        installer.write_bytes(b"MZ synthetic self-test installer")
        receipt = {"schema": 1, "installer": str(installer), "bytes": installer.stat().st_size,
                   "sha256": consumer["sha"](installer), "signed": False,
                   "payload": {"sourceCommit": admission["source_commit"], "sourceTreeSha256": admission["source_tree_sha256"],
                               "sourceCount": 1, "baseVersion": "0.7.0", "fileCount": 2, "rebuilt": False},
                   "custody": {"runId": "1", "manifestSha256": consumer["sha"](root / "windows-unpacked-structure.json"),
                               "nativeHealthSha256": consumer["sha"](root / "native-smoke-evidence/native-startup.json")}}
        receipt_path = root / "installer-build.json"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        pins = contract["prepare"](root, receipt_path)
        contract_path = root / "contract.json"
        contract_path.write_text(json.dumps(pins), encoding="utf-8")
        assert contract["validate_contract"](contract_path, root) == pins
        assert consumer["verify_tree"](installed, structure)["every_payload_file_sha256_verified"]
        policy = contract["update_policy"]
        for field, value in (("source", "build"), ("dirty", True), ("channelBuild", {}),
                             ("updateMechanism", "external"), ("payload", "bootstrap")):
            rejected(lambda: policy["validate_update_policy"]({**structure["update_stamp"], field: value}))
        for field, value in (("publicBase", "https://example.com"), ("enabled", False),
                             ("repository", "NousResearch/hermes-agent"), ("windowsMode", "signed")):
            changed = {**structure["update_stamp"], "desktopReleasePolicy": {**policy["UPDATE_POLICY"], field: value}}
            rejected(lambda: policy["validate_update_policy"](changed))
        for config in ({**structure["update_configuration"], "url": "https://example.com/"},
                       {**structure["update_configuration"], "publisherName": "Unexpected Publisher"},
                       {**structure["update_configuration"], "updaterCacheDirName": "../escape"}):
            rejected(lambda: policy["validate_update_configuration"](config))
        uninstaller = installed / "Uninstall Luheng.exe"
        uninstaller.write_bytes(b"MZ synthetic self-test uninstaller")
        assert consumer["verify_tree"](installed, structure, uninstaller.name)["exact_membership"]
        rejected(lambda: consumer["verify_tree"](installed, structure))
        uninstaller.unlink()
        executable.write_bytes(b"tampered")
        rejected(lambda: consumer["verify_tree"](installed, structure))
        for name in ("../escape", "C:/escape", "NUL", "path\\escape", "file:stream", "file."):
            rejected(lambda: consumer["owned"](root, name))
        receipt["custody"]["runId"] = "2"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        rejected(lambda: contract["prepare"](root, receipt_path))
        rejected(lambda: contract["validate_contract"](contract_path, root))
        receipt["custody"]["runId"] = "1"
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        structure["source_tree_sha256"] = "c" * 64
        (root / "windows-unpacked-structure.json").write_text(json.dumps(structure), encoding="utf-8")
        receipt["custody"]["manifestSha256"] = consumer["sha"](root / "windows-unpacked-structure.json")
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        rejected(lambda: contract["prepare"](root, receipt_path))
        structure["source_tree_sha256"] = admission["source_tree_sha256"]
        (root / "windows-unpacked-structure.json").write_text(json.dumps(structure), encoding="utf-8")
        receipt["custody"]["manifestSha256"] = consumer["sha"](root / "windows-unpacked-structure.json")
        receipt_path.write_text(json.dumps(receipt), encoding="utf-8")
        health["plain_launch"] = False
        (root / "native-smoke-evidence/native-startup.json").write_text(json.dumps(health), encoding="utf-8")
        rejected(lambda: contract["prepare"](root, receipt_path))
    print("Same-job custody, real-file hashes and tamper/path rejection self-check passed")


if __name__ == "__main__":
    main()
