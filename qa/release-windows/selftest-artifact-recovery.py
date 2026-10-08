"""Exercise recovery provenance and real-file custody without running an installer."""
import copy
import json
import os
from pathlib import Path
import runpy
import tempfile
from unittest.mock import patch

r = runpy.run_path(str(Path(__file__).with_name("artifact-recovery.py")))
c = runpy.run_path(str(Path(__file__).with_name("prepare-lifecycle-contract.py")))


def rejected(action):
    try:
        action()
    except (ValueError, KeyError):
        return
    raise AssertionError("Tampered recovery evidence was accepted")


def context_fixture():
    pin = {**r["PRODUCERS"]["0.7.0"], "evidenceArtifactId": 11543060233,
           "installerArtifactDigest": "sha256:" + "a" * 64, "evidenceArtifactDigest": "sha256:" + "b" * 64}
    run = {"id": pin["runId"], "head_sha": pin["headSha"], "status": "completed", "conclusion": "failure",
           "repository": {"full_name": r["REPOSITORY"]}, "path": ".github/workflows/hermes-native-package-experiment.yml"}
    steps = [{"name": name, "conclusion": "success"} for name in r["REQUIRED"]]
    steps.extend({"name": name, "conclusion": "failure"} for name in r["FAILURES"])
    jobs = {"total_count": 1, "jobs": [{"name": "windows-x64", "run_id": run["id"], "status": "completed", "conclusion": "failure", "steps": steps}]}
    artifacts = {kind: {"id": pin[kind + "ArtifactId"], "name": name, "expired": False,
                       "workflow_run": {"id": run["id"], "head_sha": run["head_sha"]},
                       "digest": pin[kind + "ArtifactDigest"], "size_in_bytes": 100}
                 for kind, name in (("installer", "luheng-windows-installer-unreleased"), ("evidence", "luheng-windows-release-evidence"))}
    return {"lock": {"schema": "luheng-artifact-recovery/v1", "repository": r["REPOSITORY"], "version": "0.7.0", "producer": pin},
            "producerRun": run, "producerJobs": jobs, "artifacts": artifacts,
            "acceptance": {"runId": 999, "headSha": "c" * 40, "workflow": r["WORKFLOW"]}}


def main():
    original = context_fixture()
    for mutate in (
        lambda x: x["producerRun"].update(conclusion="cancelled"),
        lambda x: x["producerRun"].update(status="in_progress"),
        lambda x: x["producerRun"].update(head_sha="0" * 40),
        lambda x: x["producerJobs"]["jobs"][0]["steps"][0].update(conclusion="failure"),
        lambda x: x["producerJobs"]["jobs"][0]["steps"].append({"name": "Unexpected failure", "conclusion": "failure"}),
        lambda x: x["producerJobs"]["jobs"][0]["steps"].pop(),
        lambda x: x["artifacts"]["installer"].update(digest="sha256:" + "f" * 64),
        lambda x: x["artifacts"]["evidence"]["workflow_run"].update(id=1),
        lambda x: x["acceptance"].update(runId=x["producerRun"]["id"]),
    ):
        altered = copy.deepcopy(original)
        mutate(altered)
        rejected(lambda: r["validate_context"](altered))
    with patch.dict(os.environ, {"GITHUB_RUN_ID": "999", "GITHUB_SHA": "c" * 40}):
        r["validate_context"](original, current=True)
        changed = copy.deepcopy(original)
        changed["acceptance"]["runId"] = 1000
        rejected(lambda: r["validate_context"](changed, current=True))
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            admission = {"source_commit": "d" * 40, "source_tree_sha256": "e" * 64, "source_count": 1,
                         "source_only": True, "license_preserved": True}
            inventory = [{"path": name, "bytes": 1, "sha256": "f" * 64} for name in ("LuhengOfficeAgent.exe", "resources/app-update.yml", "resources/app.asar")]
            stamp = {"desktopReleasePolicy": dict(c["update_policy"]["UPDATE_POLICY"]), "source": "commit-build",
                     "payload": "bundled", "distribution": "desktop-app", "dirty": False, "commit": admission["source_commit"],
                     "baseVersion": "0.7.0", "channelBuild": None, "updateMechanism": "electron-updater"}
            structure = {**admission, "schema": 2, "target": "win32-x64", "base_version": "0.7.0", "files": inventory,
                         "artifact_kind": "official-prepared-unpacked-Windows-x64-build-only", "desktop_and_embedded_cli_stamp_match": True,
                         "production_update_enabled": True, "update_mechanism": "electron-updater", "update_stamp": stamp,
                         "update_configuration": {"provider": "generic", "url": "https://apps.luotuai.me/updates/windows/", "channel": "latest"}}
            health = {"native_windows": True, "architecture": "X64", "plain_launch": True, "contained_backend_health": True,
                      "normal_window_close": True, "forced_cleanup": False, "error": None, "health_version": "0.7.0",
                      "build_run_id": str(original["producerRun"]["id"])}
            installer = root / "installer/setup.exe"
            installer.parent.mkdir()
            installer.write_bytes(b"MZ harmless custody fixture")
            context = copy.deepcopy(original)
            files = {}
            for key, data in (("sourceAdmission", admission), ("structure", structure), ("health", health)):
                target = root / "producer" / r["NAMES"][key]
                r["save"](target, data)
                files[key] = r["pin"](root, target)
            build = {"schema": 1, "signed": False, "installer": "D:\\original-run\\setup.exe", "bytes": installer.stat().st_size,
                     "sha256": r["sha"](installer), "payload": {"sourceCommit": admission["source_commit"], "sourceTreeSha256": admission["source_tree_sha256"],
                     "sourceCount": 1, "baseVersion": "0.7.0", "fileCount": 3, "rebuilt": False},
                     "custody": {"runId": str(original["producerRun"]["id"]), "manifestSha256": files["structure"]["sha256"],
                                 "nativeHealthSha256": files["health"]["sha256"]}}
            receipt = root / "producer/installer-build.json"
            r["save"](receipt, build)
            files["installerReceipt"] = r["pin"](root, receipt)
            context.update(producerFiles=files, installer=r["pin"](root, installer))
            recovery = root / "recovery-admission.json"
            r["save"](recovery, context)
            contract = c["prepare"](root, receipt, recovery=recovery)
            assert contract["scope"] == "artifact-recovery" and contract["build"]["runId"] == original["producerRun"]["id"]
            assert contract["acceptance"]["runId"] == 999 and r["read"](receipt) == build
            contract_path = root / "contract.json"
            r["save"](contract_path, contract)
            assert c["validate_contract"](contract_path, root) == contract
            rejected(lambda: c["prepare"](root, receipt))
            life = {key: True for key in ("restricted_token_lifecycle_verified", "accepted_with_declared_limits", "installed",
                    "every_installed_payload_file_verified", "native_window", "contained_backend_health", "normal_window_close",
                    "contained_processes_stopped", "normal_uninstall", "installed_tree_removed", "synthetic_userdata_retained")}
            life.update(error=None, forced_cleanup=False, immutable_payload_rebuilt=False, scope="artifact-recovery",
                        build_run_id=original["producerRun"]["id"], consumer_run_id=999, acceptance_run_id=999,
                        installer_sha256=build["sha256"], health_version="0.7.0", coverage="restricted-token-same-user", architecture="X64")
            life_path = root / "acceptance/installer-lifecycle.json"
            r["save"](life_path, life)
            provenance = {"schema": "luheng-recovery-provenance/v1", "context": context, "producerFiles": files,
                          "installer": context["installer"], "lifecycle": r["pin"](root, life_path)}
            prov_path = root / "acceptance/provenance.json"
            r["save"](prov_path, provenance)
            entry = {"version": "0.7.0", "bytes": build["bytes"], "sha256": build["sha256"], "exeSha256": "f" * 64, "asarSha256": "f" * 64,
                     "url": "https://github.com/jobKKB/luheng-highway-agent/releases/download/v0.7.0-beta.1/Luheng.exe",
                     "evidence": {"runId": original["producerRun"]["id"], "headSha": original["producerRun"]["head_sha"],
                     "artifact": "luheng-windows-release-evidence", "files": files,
                     "recovery": {"runId": 999, "headSha": "c" * 40, "artifactId": 123, "artifact": "luheng-windows-recovery-evidence-0.7.0",
                                  "files": {"lifecycle": r["pin"](root, life_path), "provenance": r["pin"](root, prov_path)}}}}
            accepted = {"id": 999, "head_sha": "c" * 40, "path": r["WORKFLOW"], "status": "completed", "conclusion": "success",
                        "repository": {"full_name": r["REPOSITORY"]}}
            bundle = {"producer": context["producerRun"], "producerJobs": context["producerJobs"], "acceptance": accepted,
                      "producerArtifacts": context["artifacts"], "acceptanceArtifact": {"id": 123, "name": entry["evidence"]["recovery"]["artifact"],
                      "expired": False, "size_in_bytes": 100, "digest": "sha256:" + "a" * 64, "workflow_run": {"id": 999, "head_sha": "c" * 40}}}
            qualify = runpy.run_path(str(Path(__file__).with_name("verify-online-update.py")))["qualify"]
            assert qualify(entry, root, bundle) == str((root / files["structure"]["path"]).absolute())
            for mutate in (lambda x: x["acceptance"].update(conclusion="failure"),
                           lambda x: x["acceptanceArtifact"]["workflow_run"].update(id=998),
                           lambda x: x["producerArtifacts"]["evidence"].update(digest="sha256:" + "0" * 64)):
                altered = copy.deepcopy(bundle)
                mutate(altered)
                rejected(lambda: qualify(entry, root, altered))
            life["consumer_run_id"] = original["producerRun"]["id"]
            r["save"](life_path, life)
            rejected(lambda: qualify(entry, root, bundle))
            installer.write_bytes(b"MZ changed fixture")
            rejected(lambda: c["validate_contract"](contract_path, root))
    print("Recovery source, exact failure allowlist, API artifact digests, current-run identity and unchanged receipt tests passed")


if __name__ == "__main__":
    main()
