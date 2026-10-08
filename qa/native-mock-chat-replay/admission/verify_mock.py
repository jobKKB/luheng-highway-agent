"""Exact 0.7.1 consumer-only admission. Stdlib only; never build or launch.

Qualification semantics adapted from verify-online-update.py at reviewed
controller 589eb5bdc8fc66569500903ca733c4e01dd592db, with narrower immutable
pins, original restricted-token proof, and separate new elevated test scope.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

HEX = re.compile(r"[a-f0-9]{64}\Z")
REPOSITORY = "jobKKB/luheng-highway-agent"
API = "https://api.github.com/repos/" + REPOSITORY
BUILD = {"runId": 37773394370, "head": "441086c414182d204e438df598ad8f967cd23761",
         "runAttempt": 1, "workflowPath": ".github/workflows/hermes-native-package-experiment.yml"}
SOURCE = {"commit": "c3490f7ffe0eaa501aa1e20c55e84fd5180e66dd",
          "treeSha256": "b5350603c19132f71748bbcbc436ef20e897513210a8538bfb2d30ceb3081031",
          "count": 17266, "baseVersion": "0.7.1"}
INSTALLER = {"url": "https://github.com/jobKKB/luheng-highway-agent/releases/download/v0.7.1-beta.1/Luheng-Office-Agent-0.7.1-windows-x64.exe",
             "path": "Luheng-Office-Agent-0.7.1-windows-x64.exe", "bytes": 1593299205,
             "sha256": "e510b8d17bd8145f1fcbfe5ab3e57070988b1b62f6d9c6e1f169233de1dd080f",
             "exeSha256": "25836d42c1b97983dd88093d1c475da54aba896e7466a720d3111e6a3fbf4599",
             "asarSha256": "77eb8388efa9951b755ea4ad1e4f47dc581f9282cfc296090d9fd2428271f880"}
ARTIFACT = {"id": 11554708380, "name": "luheng-windows-release-evidence", "bytes": 5808718,
            "digest": "sha256:0d2f55db77a006bcb04a5573ba3f345bd7d593274b8c1d3f6da3399ef791084a"}
RELEASE = {"id": 406894002, "tag": "v0.7.1-beta.1", "assetId": 621995936, "assetName": INSTALLER["path"]}
PREFIX = "luheng-highway-agent/luheng-highway-agent/"
EVIDENCE_FILES = {
    "sourceAdmission": {"path": PREFIX + "source-admission.json", "bytes": 468, "sha256": "83662a1e265d66961db1dcd6c5898b7c6aba5e4a2d86f92b5c3e837089d62d1f"},
    "structure": {"path": PREFIX + "windows-unpacked-structure.json", "bytes": 28476068, "sha256": "402375d298166512a02ee07b7ecaa671610b55dd1551251582ce2c354b2d0e5f"},
    "health": {"path": PREFIX + "native-smoke-evidence/native-startup.json", "bytes": 430, "sha256": "7e230ef087e0bc392a043cf45dde7e769f3db5a6d52d111df6d91315f7634233"},
    "installerReceipt": {"path": PREFIX + "installer-product/installer-build.json", "bytes": 3395, "sha256": "d379aeed84f0904c524accaeb2dc587875015899ae104c532f1c821a2b2b4523"},
    "lifecycle": {"path": "_temp/luheng-installer-acceptance/evidence/installer-lifecycle.json", "bytes": 10225, "sha256": "e5fc3c4096fba2d2d8184d1c287cf0d75180926455bcb199be1f368e3777b778"},
}
GENERATED = [
    {"path": "Uninstall LuhengOfficeAgent.exe", "bytes": 201575, "sha256": "103ca0de8e3872d4628f1096d3bbefc81bd49a1e4b46faa2129948fd08bd6c91"},
    {"path": "resources/package-type", "bytes": 4, "sha256": "c5c323aec3f9d0b72cf187886981dee0f111fa12249e38e447d0e477df153176"},
]
PAYLOAD = {"files": 117874, "bytes": 6470743229}
UPDATE_POLICY = {"schema": 1, "enabled": True, "windowsMode": "nsis-preview",
                 "repository": REPOSITORY, "publicBase": "https://apps.luotuai.me/updates/windows",
                 "channel": "stable", "windowsPublisher": None, "macTeamId": None}
LIFECYCLE_TRUE = ("accepted_with_declared_limits", "installed", "every_installed_payload_file_verified",
                  "native_window", "contained_backend_health", "normal_window_close", "contained_processes_stopped",
                  "normal_uninstall", "installed_tree_removed", "synthetic_userdata_retained", "native_windows")
LIMITS_FALSE = ("standard_user_installation_verified", "default_shell_appdata_retention_verified",
                "registration_scope_verified", "offline_verified", "physical_ime_verified", "automatic_update_verified")


def require(value, message):
    if not value:
        raise ValueError(message)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key: " + key)
        result[key] = value
    return result


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"), object_pairs_hook=no_duplicates,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Nonfinite JSON: " + value)))


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def exact(value, expected, message):
    # JSON canonical equality additionally rejects bool-as-int and float-as-int.
    require(json.dumps(value, sort_keys=True) == json.dumps(expected, sort_keys=True), message)


def safe_name(value):
    require(isinstance(value, str) and value and "\\" not in value and ":" not in value, "Unsafe Windows path")
    parts = value.split("/")
    require(not PurePosixPath(value).is_absolute() and all(p not in ("", ".", "..") for p in parts), "Unsafe Windows path")
    reserved = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"} | {
        f"{prefix}{number}" for prefix in ("COM", "LPT") for number in (*range(1, 10), "¹", "²", "³")}
    for part in parts:
        require(not part.endswith((".", " ")) and not any(ord(c) < 32 or c in '<>"|?*' for c in part), "Windows-aliased path")
        require(part.split(".", 1)[0].upper() not in reserved, "Reserved Windows filename")
    return parts


def not_link(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400),
            "Input crosses a symbolic link or reparse point")


def owned(root, name):
    current = Path(root).absolute()
    for ancestor in [current, *current.parents]:
        not_link(ancestor)
    for part in safe_name(name):
        current /= part
        not_link(current)
    require(current.resolve().is_relative_to(Path(root).resolve()), "Input escapes its root")
    return current


def ordinary_file(path):
    path = Path(path)
    for ancestor in [path, *path.parents]:
        not_link(ancestor)
    require(path.is_file() and stat.S_ISREG(path.stat().st_mode), "Not a regular file: " + str(path))
    require(path.stat().st_nlink == 1, "Hard-linked input is not isolated")
    return path


def verify_file(root, row):
    path = ordinary_file(owned(root, row["path"]))
    require(type(row["bytes"]) is int and row["bytes"] >= 0 and HEX.fullmatch(row["sha256"]), "Invalid byte pin")
    require(path.stat().st_size == row["bytes"] and sha(path) == row["sha256"], "Pinned file differs: " + row["path"])
    return path


def contract(path):
    value = read_json(ordinary_file(path))
    require(type(value["schema"]) is int and value["schema"] == 1 and value["qualified"] is True, "Unqualified contract")
    require(value["repository"] == REPOSITORY, "Wrong repository")
    for key, expected in (("build", BUILD), ("source", SOURCE), ("installer", INSTALLER),
                          ("evidenceArtifact", ARTIFACT), ("release", RELEASE), ("evidenceFiles", EVIDENCE_FILES),
                          ("payload", PAYLOAD), ("generatedInstallerFiles", GENERATED)):
        exact(value[key], expected, "Unreviewed immutable contract: " + key)
    require(value["lifecycleMode"] == "elevated-runner-explicitly-limited" and
            value["priorLifecycleMode"] == "restricted-token-same-user", "Lifecycle scopes changed or conflated")
    require(value["reviewedController"] == "589eb5bdc8fc66569500903ca733c4e01dd592db", "Unreviewed controller")
    minimum = 2 * PAYLOAD["bytes"] + INSTALLER["bytes"] + ARTIFACT["bytes"] + 4 * 1024**3
    require(type(value["minimumScratchBytes"]) is int and value["minimumScratchBytes"] >= minimum,
            "Scratch budget does not cover two payload trees, installer, evidence and reserve")
    return value


def verify_api(pins, api_root):
    run = read_json(ordinary_file(owned(api_root, "producer-run.json")))
    artifact = read_json(ordinary_file(owned(api_root, "evidence-artifact.json")))
    release = read_json(ordinary_file(owned(api_root, "release.json")))
    b, a, r, i = pins["build"], pins["evidenceArtifact"], pins["release"], pins["installer"]
    require(type(run["id"]) is int and run["id"] == b["runId"] and run["head_sha"] == b["head"] and
            type(run["run_attempt"]) is int and run["run_attempt"] == b["runAttempt"] and
            run["path"] == b["workflowPath"] and run["status"] == "completed" and run["conclusion"] == "success" and
            run["repository"]["full_name"] == pins["repository"] and run["head_repository"]["full_name"] == pins["repository"] and
            run["url"] == API + "/actions/runs/" + str(b["runId"]), "Producer API identity/status differs")
    require(type(artifact["id"]) is int and artifact["id"] == a["id"] and artifact["name"] == a["name"] and
            type(artifact["size_in_bytes"]) is int and artifact["size_in_bytes"] == a["bytes"] and
            artifact["digest"] == a["digest"] and artifact["expired"] is False and
            artifact["url"] == API + "/actions/artifacts/" + str(a["id"]) and
            artifact["archive_download_url"] == API + "/actions/artifacts/" + str(a["id"]) + "/zip" and
            artifact["workflow_run"]["id"] == b["runId"] and artifact["workflow_run"]["head_sha"] == b["head"] and
            artifact["workflow_run"]["repository_id"] == run["repository"]["id"] and
            artifact["workflow_run"]["head_repository_id"] == run["head_repository"]["id"], "Evidence artifact API custody differs")
    require(release["id"] == r["id"] and release["tag_name"] == r["tag"] and release["draft"] is False and
            release["prerelease"] is True and release["target_commitish"] == b["head"] and
            release["url"] == API + "/releases/" + str(r["id"]), "Published preview release identity differs")
    matches = [v for v in release["assets"] if v["id"] == r["assetId"] or v["name"] == r["assetName"] or
               v["browser_download_url"] == i["url"]]
    require(len(matches) == 1, "Release asset absent, duplicated or ambiguous")
    asset = matches[0]
    require(asset["id"] == r["assetId"] and asset["name"] == r["assetName"] and asset["state"] == "uploaded" and
            asset["size"] == i["bytes"] and asset["digest"] == "sha256:" + i["sha256"] and
            asset["browser_download_url"] == i["url"] and asset["url"] == API + "/releases/assets/" + str(r["assetId"]),
            "Release installer metadata differs; downloaded bytes still require verification")
    return {"api_admission_passed": True, "build_run_id": b["runId"], "evidence_artifact_id": a["id"],
            "release_asset_id": r["assetId"], "installer_bytes_verified": False, "rebuilt": False}


def inventory(manifest):
    expected, folded, directories = {}, set(), {}
    for row in manifest["files"]:
        parts = safe_name(row["path"])
        require(row["path"].casefold() not in folded and type(row["bytes"]) is int and row["bytes"] >= 0 and
                HEX.fullmatch(row["sha256"]), "Invalid or duplicate/case-aliased manifest file")
        folded.add(row["path"].casefold())
        expected[row["path"]] = row
        for n in range(1, len(parts)):
            d = "/".join(parts[:n])
            require(d.casefold() not in directories or directories[d.casefold()] == d, "Case-aliased manifest directory")
            directories[d.casefold()] = d
    require(expected and not (folded & set(directories)), "Empty inventory or file/directory collision")
    return expected


def validate_update_policy(manifest, source):
    require(manifest["production_update_enabled"] is True and manifest["update_mechanism"] == "electron-updater",
            "Expected update-enabled 0.7.1 payload, not old disabled-update policy")
    stamp = manifest["update_stamp"]
    exact(stamp, {"source": "commit-build", "payload": "bundled", "distribution": "desktop-app", "dirty": False,
                  "commit": source["commit"], "baseVersion": source["baseVersion"], "channelBuild": None,
                  "updateMechanism": "electron-updater", "desktopReleasePolicy": UPDATE_POLICY},
          "Payload preview update policy differs")
    exact(manifest["update_configuration"], {"provider": "generic", "url": UPDATE_POLICY["publicBase"] + "/",
          "channel": "latest", "updaterCacheDirName": "luhengofficeagent-updater"}, "Packaged update authority differs")


def validate_lifecycle(pins, value, prior):
    for key in LIFECYCLE_TRUE:
        require(value[key] is True, "Incomplete installer lifecycle: " + key)
    for key in LIMITS_FALSE:
        require(value[key] is False, "Lifecycle overclaims: " + key)
    require(value["schema"] == 1 and value["error"] is None and value.get("cleanup_error") is None and
            value.get("uninstall_error") is None and value["forced_cleanup"] is False and
            str(value["build_run_id"]) == str(pins["build"]["runId"]) and
            value["installer_sha256"] == pins["installer"]["sha256"] and value["health_version"] == pins["source"]["baseVersion"] and
            value["architecture"] == "X64" and value["immutable_payload_rebuilt"] is False and
            value["unsigned_installer"] is True, "Lifecycle custody, cleanup or identity failed")
    token = value["runner_token"]
    require(isinstance(token["UserSid"], str) and token["UserSid"].startswith("S-1-5-"), "Runner user token missing")
    if prior:
        require(value["coverage"] == pins["priorLifecycleMode"] and value["restricted_token_lifecycle_verified"] is True and
                value["scope"] == "same-job" and str(value["consumer_run_id"]) == str(pins["build"]["runId"]) and
                str(value["acceptance_run_id"]) == str(pins["build"]["runId"]), "Prior restricted proof was weakened")
    else:
        require(value["coverage"] == pins["lifecycleMode"] and value["restricted_token_lifecycle_verified"] is False and
                re.fullmatch(r"[1-9][0-9]*", str(value["consumer_run_id"])), "New lifecycle scope is unqualified")
        for key in ("debugger_owned_loopback", "mocked_model_orchestration_verified", "mock_controller_closed"):
            require(value[key] is True, "New lifecycle missing: " + key)
        require(value["plain_launch"] is False and value["model_chat_verified"] is False and
                value["ui_probe_mode"] == "fresh-synthetic-profile-loopback-cdp-mock-chat", "Mock test scope overclaimed")
    token_names = ("installer", "desktop", "backend", "uninstaller") + (() if prior else ("mock-controller",))
    for name in token_names:
        child = value["tokens"][name]
        require(child["UserSid"] == token["UserSid"] and child["IntegritySid"] == token["IntegritySid"] and
                child["IsElevated"] == token["IsElevated"], "Lifecycle process changed token: " + name)
        if prior:
            require(child["IsElevated"] == 0 and child["IntegritySid"] == "S-1-16-8192" and child["HasRestrictions"] == 1,
                    "Original restricted token was elevated or unrestricted")
    if prior:
        require(token["IsElevated"] == 0 and token["IntegritySid"] == "S-1-16-8192" and token["HasRestrictions"] == 1,
                "Original runner was not restricted medium integrity")


def evidence_documents(pins, evidence):
    paths = {name: verify_file(evidence, row) for name, row in pins["evidenceFiles"].items()}
    values = {name: read_json(path) for name, path in paths.items()}
    source = pins["source"]
    admission, manifest, health, build, life = (values[name] for name in
                                               ("sourceAdmission", "structure", "health", "installerReceipt", "lifecycle"))
    require(admission["source_only"] is True and admission["license_preserved"] is True and
            admission["build_performed"] is False and admission["fresh_upstream_reconstruction"] is True, "Source admission failed")
    for v in (admission, manifest):
        require(v["source_commit"] == source["commit"] and v["source_tree_sha256"] == source["treeSha256"] and
                v["source_count"] == source["count"], "Evidence source identity differs")
    require(manifest["schema"] == 2 and manifest["target"] == "win32-x64" and
            manifest["artifact_kind"] == "official-prepared-unpacked-Windows-x64-build-only" and
            manifest["base_version"] == source["baseVersion"] and manifest["desktop_and_embedded_cli_stamp_match"] is True,
            "Wrong original Windows payload")
    validate_update_policy(manifest, source)
    rows = inventory(manifest)
    require(len(rows) == pins["payload"]["files"] and sum(row["bytes"] for row in rows.values()) == pins["payload"]["bytes"],
            "Original payload inventory totals differ")
    require(rows["LuhengOfficeAgent.exe"]["sha256"] == pins["installer"]["exeSha256"] and
            rows["resources/app.asar"]["sha256"] == pins["installer"]["asarSha256"], "Original entrypoint hashes differ")
    require(build["schema"] == 1 and build["signed"] is False and build["bytes"] == pins["installer"]["bytes"] and
            build["sha256"] == pins["installer"]["sha256"] and str(build["custody"]["runId"]) == str(pins["build"]["runId"]) and
            build["custody"]["manifestSha256"] == pins["evidenceFiles"]["structure"]["sha256"] and
            build["custody"]["nativeHealthSha256"] == pins["evidenceFiles"]["health"]["sha256"], "Installer original custody differs")
    exact(build["payload"], {"sourceCommit": source["commit"], "sourceTreeSha256": source["treeSha256"],
          "sourceCount": source["count"], "baseVersion": source["baseVersion"], "fileCount": len(rows), "rebuilt": False},
          "Installer payload was rebuilt or changed")
    for key in ("native_windows", "plain_launch", "contained_backend_health", "normal_window_close"):
        require(health[key] is True, "Original native startup failed: " + key)
    require(health["architecture"] == "X64" and health["error"] is None and health["forced_cleanup"] is False and
            str(health["build_run_id"]) == str(pins["build"]["runId"]) and health["health_version"] == source["baseVersion"],
            "Original native startup identity differs")
    validate_lifecycle(pins, life, prior=True)
    return paths, values


def verify_evidence(pins, evidence):
    paths, values = evidence_documents(pins, evidence)
    return {"frozen_evidence_admission_passed": True, "payload_files": pins["payload"]["files"],
            "payload_bytes": pins["payload"]["bytes"], "source_commit": pins["source"]["commit"],
            "source_tree_sha256": pins["source"]["treeSha256"], "previous_lifecycle_accepted": True,
            "previous_lifecycle_scope": pins["priorLifecycleMode"], "new_lifecycle_scope": pins["lifecycleMode"],
            "updates_enabled": True, "windows_update_mode": "nsis-preview", "installer_downloaded": False, "rebuilt": False}


def verify_downloads(pins, evidence, installer, relocated_path):
    paths, values = evidence_documents(pins, evidence)
    installer = ordinary_file(Path(installer).absolute())
    require(installer.name == pins["installer"]["path"] and installer.stat().st_size == pins["installer"]["bytes"] and
            sha(installer) == pins["installer"]["sha256"], "Downloaded installer is not the exact public release bytes")
    output = Path(relocated_path).absolute()
    require(not output.resolve().is_relative_to(Path(evidence).resolve()) and output != installer,
            "Relocation must not write into original evidence or installer")
    relocated = copy.deepcopy(values["installerReceipt"])
    relocated["installer"] = str(installer)
    save_json(output, relocated)
    # Recheck original after writing; relocation changes exactly one field.
    verify_file(evidence, pins["evidenceFiles"]["installerReceipt"])
    original = values["installerReceipt"]
    recovered = read_json(output)
    recovered["installer"] = original["installer"]
    exact(recovered, original, "Relocation altered original installer metadata")
    return {"download_admission_passed": True, "installer": str(installer), "installer_receipt": str(output),
            "original_installer_receipt_preserved": True, "installer_sha256": pins["installer"]["sha256"],
            "source_commit": pins["source"]["commit"], "source_tree_sha256": pins["source"]["treeSha256"], "rebuilt": False}


def verify_tree(pins, root, manifest, uninstaller):
    root = Path(root).absolute()
    require(root.is_dir(), "Install root missing")
    not_link(root)
    require(uninstaller == pins["generatedInstallerFiles"][0]["path"] and len(safe_name(uninstaller)) == 1,
            "Unreviewed uninstaller basename")
    expected = inventory(manifest)
    require(len(expected) == pins["payload"]["files"] and
            sum(row["bytes"] for row in expected.values()) == pins["payload"]["bytes"], "Payload inventory totals differ")
    generated = {row["path"]: row for row in pins["generatedInstallerFiles"]}
    require(not (set(expected) & set(generated)), "Generated installer file collides with original payload")
    all_files = set(expected) | set(generated)
    actual, folded = set(), set()
    def fail_walk(error):
        raise error
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=fail_walk):
        for name in dirs + files:
            path = Path(directory) / name
            rel = path.relative_to(root).as_posix()
            owned(root, rel)
            require(rel.casefold() not in folded, "Case-aliased installed entry")
            folded.add(rel.casefold())
            if name in dirs:
                # The immutable producer inventory records files, not empty
                # directories. Match its semantics while rejecting every link,
                # reparse point, unsafe/case-aliased path and additional file.
                require(path.is_dir(), "Non-directory installed entry")
            else:
                ordinary_file(path)
                actual.add(rel)
    require(actual == all_files, "Exact installed membership differs")
    for row in [*expected.values(), *generated.values()]:
        verify_file(root, row)
    require(owned(root, "resources/package-type").read_bytes() == b"nsis", "NSIS marker differs")
    with owned(root, uninstaller).open("rb") as stream:
        require(stream.read(2) == b"MZ", "Uninstaller is not PE")
    return {"every_payload_file_sha256_verified": True, "exact_membership": True,
            "payload_files": len(expected), "payload_bytes": sum(row["bytes"] for row in expected.values()),
            "generated_installer_files": pins["generatedInstallerFiles"], "source_commit": manifest["source_commit"],
            "source_tree_sha256": manifest["source_tree_sha256"], "rebuilt": False}


def verify_acceptance(pins, evidence, root, current_run):
    # Original restricted-token qualification remains independently hash-admitted.
    verify_evidence(pins, evidence)
    lifecycle = read_json(ordinary_file(owned(root, "installer-lifecycle.json")))
    require(isinstance(current_run, str) and re.fullmatch(r"[1-9][0-9]*", current_run) and
            str(lifecycle["consumer_run_id"]) == current_run, "Acceptance belongs to another consumer run")
    validate_lifecycle(pins, lifecycle, prior=False)
    receipts = [read_json(ordinary_file(owned(root, name))) for name in
                ("installed-payload-before-launch.json", "installed-payload-after-exit.json")]
    for value in receipts:
        require(value["every_payload_file_sha256_verified"] is True and value["exact_membership"] is True and
                value["payload_files"] == pins["payload"]["files"] and value["payload_bytes"] == pins["payload"]["bytes"] and
                value["source_commit"] == pins["source"]["commit"] and value["source_tree_sha256"] == pins["source"]["treeSha256"] and
                value["rebuilt"] is False, "Native before/after tree receipt incomplete")
        exact(value["generated_installer_files"], pins["generatedInstallerFiles"], "Uninstaller or package marker changed")
    mock = read_json(ordinary_file(owned(root, "mock-chat.json")))
    require(mock["schema"] == 1 and mock["kind"] == "mocked-model-orchestration" and
            mock["installer_sha256"] == pins["installer"]["sha256"] and mock["accepted_with_declared_limits"] is True and
            mock["error"] is None, "Mock receipt failed/incomplete")
    for key in ("title_generation_disabled", "synthetic_key_only", "local_model_request_verified",
                "real_read_file_roundtrip_verified", "assistant_reply_rendered", "marker_file_unchanged"):
        require(mock[key] is True, "Mock receipt missing: " + key)
    for key in ("real_provider_verified", "llm_quality_verified", "offline_verified", "physical_ime_verified", "os_network_settings_changed"):
        require(mock[key] is False, "Mock receipt overclaimed: " + key)
    return {"lifecycle_acceptance_admission_passed": True, "base_lifecycle_only": True,
            "independent_node_protocol_visual_ownership_verifier_required": True,
            "new_lifecycle_scope": pins["lifecycleMode"], "prior_lifecycle_scope": pins["priorLifecycleMode"],
            "installer_sha256": pins["installer"]["sha256"], "real_provider_verified": False,
            "standard_user_installation_verified": False, "offline_verified": False, "rebuilt": False}


def save_json(path, value):
    path = Path(path).absolute()
    for ancestor in [path, *path.parents]:
        not_link(ancestor)
    require(not path.exists(), "Refusing to overwrite an existing evidence output: " + str(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("contract", "api", "evidence", "downloads", "tree", "acceptance"))
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    for name in ("api-root", "evidence", "installer", "root", "relocated-receipt"):
        parser.add_argument("--" + name, type=Path)
    parser.add_argument("--uninstaller")
    parser.add_argument("--current-run")
    args = parser.parse_args()
    pins = contract(args.contract)
    require(not args.output.exists(), "Output already exists; stale receipt must not impersonate a fresh check")
    if args.mode == "contract":
        result = {"pins_reviewed": True, "build_run_id": pins["build"]["runId"],
                  "minimum_scratch_bytes": pins["minimumScratchBytes"], "rebuilt": False}
    elif args.mode == "api":
        require(args.api_root, "--api-root is required")
        result = verify_api(pins, args.api_root)
    elif args.mode == "evidence":
        require(args.evidence, "--evidence is required")
        result = verify_evidence(pins, args.evidence)
    elif args.mode == "downloads":
        require(args.evidence and args.installer, "--evidence and --installer are required")
        relocated = args.relocated_receipt or args.output.with_name("installer-build.relocated.json")
        require(relocated.absolute() != args.output.absolute(), "Relocated receipt and result output must differ")
        result = verify_downloads(pins, args.evidence, args.installer, relocated)
    elif args.mode == "tree":
        require(args.evidence and args.root and args.uninstaller, "--evidence, --root and --uninstaller are required")
        _, values = evidence_documents(pins, args.evidence)
        result = verify_tree(pins, args.root, values["structure"], args.uninstaller)
    else:
        require(args.evidence and args.root and args.current_run, "--evidence, --root and --current-run are required")
        result = verify_acceptance(pins, args.evidence, args.root, args.current_run)
    save_json(args.output, result)
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        print("Admission failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
