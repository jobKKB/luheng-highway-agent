"""Admit immutable A/B producer evidence and verify installed payload membership."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import runpy

ROOT = Path(__file__).resolve().parents[2]
consumer = runpy.run_path(str(ROOT / "qa/native-installer-consumer/verify_consumer.py"))
policy = runpy.run_path(str(ROOT / "qa/hermes-native/verify-contained-candidate.py"))
require, read, sha, owned = (consumer[key] for key in ("require", "read_json", "sha", "owned"))
FEED = "https://apps.luotuai.me/updates/windows/"


def validate(pair):
    require(pair["schema"] == "luheng-online-update/v1" and pair["repository"] == "jobKKB/luheng-highway-agent"
            and pair["feed"] == FEED, "Unexpected update authority")
    for side, version in (("from", "0.7.0"), ("to", "0.7.1")):
        entry = pair[side]
        require(entry["version"] == version, "Unexpected A/B version")
        require(type(entry["bytes"]) is int and entry["bytes"] > 0, "Invalid installer size")
        for key in ("sha256", "exeSha256", "asarSha256"):
            require(re.fullmatch(r"[a-f0-9]{64}", entry[key]), "Invalid artifact hash")
        prefix = "https://github.com/jobKKB/luheng-highway-agent/releases/download/v" + version + "-beta.1/"
        require(entry["url"].startswith(prefix) and re.fullmatch(r"[A-Za-z0-9._-]+\.exe", entry["url"][len(prefix):]),
                "Installer URL outside fixed release")
        evidence = entry["evidence"]
        require(type(evidence["runId"]) is int and evidence["runId"] > 0 and
                re.fullmatch(r"[a-f0-9]{40}", evidence["headSha"]), "Invalid producer identity")
        require(evidence["artifact"] == "luheng-windows-release-evidence", "Unexpected producer artifact")
        require(set(evidence["files"]) == {"sourceAdmission", "structure", "health", "installerReceipt", "lifecycle"},
                "Missing qualification evidence")
        for row in evidence["files"].values():
            consumer["safe_name"](row["path"])
            require(type(row["bytes"]) is int and row["bytes"] > 0 and re.fullmatch(r"[a-f0-9]{64}", row["sha256"]),
                    "Invalid evidence pin")
    return pair


def qualify(entry, evidence_root, run):
    identity = entry["evidence"]
    require(run["id"] == identity["runId"] and run["head_sha"] == identity["headSha"] and
            run["status"] == "completed" and run["conclusion"] == "success" and
            run["repository"]["full_name"] == "jobKKB/luheng-highway-agent" and
            run["path"] == ".github/workflows/hermes-native-package-experiment.yml", "Producer run did not qualify")
    paths = {name: consumer["verify_file"](evidence_root, row) for name, row in identity["files"].items()}
    admission, structure, health, build, lifecycle = (read(paths[name]) for name in
                                                    ("sourceAdmission", "structure", "health", "installerReceipt", "lifecycle"))
    require(admission["source_only"] is True and admission["license_preserved"] is True, "Source admission failed")
    require(re.fullmatch(r"[a-f0-9]{40}", admission["source_commit"]) and
            re.fullmatch(r"[a-f0-9]{64}", admission["source_tree_sha256"]) and
            type(admission["source_count"]) is int and admission["source_count"] > 0, "Invalid source identity")
    for key in ("source_commit", "source_tree_sha256", "source_count"):
        require(structure[key] == admission[key], "Source and structure identity differ")
    require(structure["schema"] == 2 and structure["target"] == "win32-x64" and
            structure["artifact_kind"] == "official-prepared-unpacked-Windows-x64-build-only" and
            structure["base_version"] == entry["version"] and
            structure["desktop_and_embedded_cli_stamp_match"] is True and
            structure["production_update_enabled"] is True and structure["update_mechanism"] == "electron-updater",
            "Payload is not the intended update-enabled version")
    policy["validate_update_policy"](structure["update_stamp"])
    policy["validate_update_configuration"](structure["update_configuration"])
    require(structure["update_stamp"]["commit"] == admission["source_commit"] and
            structure["update_stamp"]["baseVersion"] == entry["version"], "Update stamp identity differs")
    inventory = {}
    folded = set()
    for row in structure["files"]:
        consumer["safe_name"](row["path"])
        require(row["path"].casefold() not in folded and type(row["bytes"]) is int and row["bytes"] >= 0 and
                re.fullmatch(r"[a-f0-9]{64}", row["sha256"]), "Invalid or duplicate manifest entry")
        inventory[row["path"]] = row
        folded.add(row["path"].casefold())
    require(inventory["LuhengOfficeAgent.exe"]["sha256"] == entry["exeSha256"] and
            inventory["resources/app.asar"]["sha256"] == entry["asarSha256"], "Entrypoint hashes differ")
    require(build["schema"] == 1 and build["signed"] is False and build["bytes"] == entry["bytes"] and build["sha256"] == entry["sha256"] and
            str(build["custody"]["runId"]) == str(identity["runId"]) and
            build["custody"]["manifestSha256"] == sha(paths["structure"]) and
            build["custody"]["nativeHealthSha256"] == sha(paths["health"]), "Installer custody differs")
    payload = build["payload"]
    require(payload["baseVersion"] == entry["version"] and payload["sourceCommit"] == admission["source_commit"] and
            payload["sourceTreeSha256"] == admission["source_tree_sha256"] and
            payload["sourceCount"] == admission["source_count"] and payload["fileCount"] == len(inventory) and
            payload["rebuilt"] is False, "Installer rebuilt or changed the admitted payload")
    for key in ("native_windows", "plain_launch", "contained_backend_health", "normal_window_close"):
        require(health[key] is True, "Original native startup failed: " + key)
    require(health["architecture"] == "X64" and health["forced_cleanup"] is False and health["error"] is None and
            health["health_version"] == entry["version"] and str(health["build_run_id"]) == str(identity["runId"]),
            "Original native startup identity differs")
    for key in ("restricted_token_lifecycle_verified", "accepted_with_declared_limits", "installed",
                "every_installed_payload_file_verified", "native_window", "contained_backend_health", "normal_window_close",
                "contained_processes_stopped", "normal_uninstall", "installed_tree_removed", "synthetic_userdata_retained"):
        require(lifecycle[key] is True, "Original installer lifecycle failed: " + key)
    require(lifecycle["error"] is None and lifecycle["forced_cleanup"] is False and
            str(lifecycle["build_run_id"]) == str(identity["runId"]) and
            lifecycle["installer_sha256"] == entry["sha256"] and lifecycle["health_version"] == entry["version"] and
            lifecycle["coverage"] == "restricted-token-same-user" and lifecycle["architecture"] == "X64" and
            lifecycle["immutable_payload_rebuilt"] is False, "Installer lifecycle custody or cleanup failed")
    return str(paths["structure"].absolute())


def self_test():
    import copy
    pin = {"path": "file.json", "bytes": 1, "sha256": "a" * 64}
    pair = {"schema": "luheng-online-update/v1", "repository": "jobKKB/luheng-highway-agent", "feed": FEED}
    for side, version in (("from", "0.7.0"), ("to", "0.7.1")):
        pair[side] = {"version": version, "bytes": 1, "sha256": "a" * 64, "exeSha256": "b" * 64,
                      "asarSha256": "c" * 64,
                      "url": f"https://github.com/jobKKB/luheng-highway-agent/releases/download/v{version}-beta.1/Luheng.exe",
                      "evidence": {"runId": 1, "headSha": "d" * 40, "artifact": "luheng-windows-release-evidence",
                                   "files": {key: dict(pin) for key in ("sourceAdmission", "structure", "health", "installerReceipt", "lifecycle")}}}
    validate(pair)
    for mutation in (
        lambda value: value.update(feed="https://example.com/"),
        lambda value: value["to"].update(version="0.7.0"),
        lambda value: value["from"].update(url=value["from"]["url"] + "?redirect=1"),
        lambda value: value["from"]["evidence"]["files"]["health"].update(path="../outside.json"),
        lambda value: value["to"]["evidence"].update(runId=-1),
    ):
        altered = copy.deepcopy(pair)
        mutation(altered)
        try:
            validate(altered)
        except (ValueError, KeyError):
            continue
        raise AssertionError("Tampered pair accepted")
    print("Pair authority, versions, producer IDs, and evidence path negative self-tests passed")
    qualification_self_test(pair)


def qualification_self_test(pair):
    """Real tiny evidence files exercise custody failures without executing a product."""
    import copy
    import tempfile
    entry = copy.deepcopy(pair["from"])
    run = {"id": 1, "head_sha": "d" * 40, "status": "completed", "conclusion": "success",
           "repository": {"full_name": pair["repository"]}, "path": ".github/workflows/hermes-native-package-experiment.yml"}
    admission = {"source_commit": "e" * 40, "source_tree_sha256": "f" * 64, "source_count": 2,
                 "source_only": True, "license_preserved": True}
    structure = {**admission, "schema": 2, "target": "win32-x64", "base_version": "0.7.0",
                 "artifact_kind": "official-prepared-unpacked-Windows-x64-build-only",
                 "desktop_and_embedded_cli_stamp_match": True, "production_update_enabled": True,
                 "update_mechanism": "electron-updater", "files": [
                     {"path": "LuhengOfficeAgent.exe", "bytes": 1, "sha256": entry["exeSha256"]},
                     {"path": "resources/app.asar", "bytes": 1, "sha256": entry["asarSha256"]}],
                 "update_stamp": {"desktopReleasePolicy": dict(policy["UPDATE_POLICY"]), "source": "commit-build",
                                  "payload": "bundled", "distribution": "desktop-app", "dirty": False,
                                  "commit": admission["source_commit"], "baseVersion": "0.7.0",
                                  "channelBuild": None, "updateMechanism": "electron-updater"},
                 "update_configuration": {"provider": "generic", "url": FEED, "channel": "latest"}}
    health = {"native_windows": True, "architecture": "X64", "plain_launch": True, "contained_backend_health": True,
              "normal_window_close": True, "forced_cleanup": False, "error": None, "health_version": "0.7.0", "build_run_id": "1"}
    lifecycle = {key: True for key in ("restricted_token_lifecycle_verified", "accepted_with_declared_limits", "installed",
                                      "every_installed_payload_file_verified", "native_window", "contained_backend_health",
                                      "normal_window_close", "contained_processes_stopped", "normal_uninstall", "installed_tree_removed",
                                      "synthetic_userdata_retained")}
    lifecycle.update(error=None, forced_cleanup=False, build_run_id=1, installer_sha256=entry["sha256"],
                     health_version="0.7.0", coverage="restricted-token-same-user", architecture="X64", immutable_payload_rebuilt=False)
    build = {"schema": 1, "signed": False, "bytes": entry["bytes"], "sha256": entry["sha256"],
             "payload": {"baseVersion": "0.7.0", "sourceCommit": admission["source_commit"],
                         "sourceTreeSha256": admission["source_tree_sha256"], "sourceCount": 2, "fileCount": 2, "rebuilt": False},
             "custody": {"runId": "1"}}
    with tempfile.TemporaryDirectory(prefix="luheng-update-admission-") as directory:
        root = Path(directory)
        def save(name, value):
            target = root / (name + ".json")
            target.write_text(json.dumps(value), encoding="utf-8")
            entry["evidence"]["files"][name] = {"path": target.name, "bytes": target.stat().st_size, "sha256": sha(target)}
        for name, value in (("sourceAdmission", admission), ("structure", structure), ("health", health), ("lifecycle", lifecycle)):
            save(name, value)
        build["custody"].update(manifestSha256=sha(root / "structure.json"), nativeHealthSha256=sha(root / "health.json"))
        save("installerReceipt", build)
        qualify(entry, root, run)
        for altered_run in ({**run, "conclusion": "failure"}, {**run, "head_sha": "0" * 40}):
            try:
                qualify(entry, root, altered_run)
            except ValueError:
                continue
            raise AssertionError("Unqualified run accepted")
        for name, original, field, value in (("lifecycle", lifecycle, "forced_cleanup", True),
                                             ("lifecycle", lifecycle, "installer_sha256", "0" * 64),
                                             ("lifecycle", lifecycle, "health_version", "0.7.1"),
                                             ("lifecycle", lifecycle, "coverage", "elevated-runner-explicitly-limited"),
                                             ("lifecycle", lifecycle, "architecture", "Arm64"),
                                             ("lifecycle", lifecycle, "immutable_payload_rebuilt", True),
                                             ("health", health, "health_version", "0.7.1"),
                                             ("sourceAdmission", admission, "source_tree_sha256", "0" * 64),
                                             ("installerReceipt", build, "sha256", "0" * 64)):
            save(name, {**original, field: value})
            try:
                qualify(entry, root, run)
            except ValueError:
                pass
            else:
                raise AssertionError("Re-pinned inconsistent evidence accepted: " + name)
            save(name, original)
        (root / "health.json").write_text("{}", encoding="utf-8")
        try:
            qualify(entry, root, run)
        except ValueError:
            pass
        else:
            raise AssertionError("Tampered evidence bytes accepted")
    print("Exact evidence hashes, run status, source identity, cleanup, and installer custody self-tests passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("lock", "evidence", "tree", "self-test"))
    for name in ("pair", "evidence", "runs", "baseline", "output", "root"):
        parser.add_argument("--" + name, type=Path)
    parser.add_argument("--side", choices=("from", "to"))
    args = parser.parse_args()
    if args.mode == "self-test":
        self_test()
        return
    pair = validate(read(args.pair))
    if args.mode == "lock":
        print(json.dumps({side: pair[side]["evidence"] for side in ("from", "to")}))
    elif args.mode == "evidence":
        for side in ("from", "to"):
            pair[side]["structurePath"] = qualify(pair[side], args.evidence / side, read(args.runs / (side + ".json")))
        baseline = args.baseline.absolute()
        require(baseline.is_file() and baseline.stat().st_size == pair["from"]["bytes"] and
                sha(baseline) == pair["from"]["sha256"], "Downloaded baseline differs")
        pair["from"]["path"] = str(baseline)
        args.output.write_text(json.dumps(pair, indent=2) + "\n", encoding="utf-8")
    else:
        entry = pair[args.side]
        manifest = Path(entry["structurePath"])
        require(sha(manifest) == entry["evidence"]["files"]["structure"]["sha256"], "Installed-tree manifest pin differs")
        uninstallers = list(args.root.glob("Uninstall *.exe"))
        require(len(uninstallers) == 1, "Expected exactly one native NSIS uninstaller")
        result = consumer["verify_tree"](args.root, read(manifest), uninstallers[0].name)
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
