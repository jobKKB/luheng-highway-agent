"""Admit one frozen unsigned EXE for replay; never rebuild, wrap or repair it."""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import shutil


def load_consumer(path):
    spec = importlib.util.spec_from_file_location("reviewed_consumer", Path(path) / "verify_consumer.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_contract(v, replay_path, consumer_path):
    replay = v.read_json(replay_path)
    v.require(replay["schema"] == 1 and replay["installerAcceptancePending"] is True,
              "Replay must not claim the retained candidate is accepted")
    v.require(replay["repository"] == "jobKKB/luheng-highway-agent", "Unexpected replay repository")
    v.verify_file(Path(consumer_path).parent, replay["consumerContract"])
    v.require(Path(consumer_path).name == replay["consumerContract"]["path"], "Consumer contract path differs")
    source = v.contract(consumer_path)
    b = replay["builder"]
    v.require(type(b["runId"]) is int and b["runId"] > 0 and v.COMMIT.fullmatch(b["head"])
              and b["runAttempt"] == 1 and b["workflowPath"] == ".github/workflows/native-installer-consumer.yml"
              and b["conclusion"] == "failure" and type(b["jobId"]) is int and b["jobId"] > 0,
              "Exact failed builder identity is required, not overall qualification")
    ids = []
    for a in (replay["candidateArtifact"], replay["builderEvidenceArtifact"], source["evidenceArtifact"]):
        v.require(type(a["id"]) is int and a["id"] > 0 and type(a["bytes"]) is int and a["bytes"] > 0
                  and a["digest"].startswith("sha256:") and v.HEX.fullmatch(a["digest"][7:]), "Artifact pins missing")
        ids.append(a["id"])
    v.require(len(set(ids)) == 3, "Three separate artifacts required")
    for p in (replay["installer"], *replay["builderEvidenceFiles"].values()):
        v.safe_name(p["path"])
        v.require(type(p["bytes"]) is int and p["bytes"] > 0 and v.HEX.fullmatch(p["sha256"]), "File pins missing")
    budget = replay["scratchBudgetBasis"]
    v.require(budget["payloadBytes"] == source["scratchBudgetBasis"]["payloadBytes"]
              and budget["expandedCopies"] == 2 and budget["installerBytes"] == replay["installer"]["bytes"]
              and budget["artifactStagingBytes"] == replay["candidateArtifact"]["bytes"]
              and budget["reserveBytes"] >= 4 * 1024**3, "Measured two-copy scratch budget differs")
    minimum = 2 * budget["payloadBytes"] + budget["installerBytes"] + budget["artifactStagingBytes"] + budget["reserveBytes"]
    v.require(replay["minimumScratchBytes"] == minimum, "Scratch arithmetic differs")
    return replay, source


def verify_api(v, replay, source, root, now=None):
    now = now or datetime.now(timezone.utc)
    repo = replay["repository"]
    def run_check(run, pin, conclusion):
        v.require(run["id"] == pin["runId"] and run["head_sha"] == pin["head"]
                  and run["run_attempt"] == pin["runAttempt"] and run["path"] == pin["workflowPath"]
                  and run["status"] == "completed" and run["conclusion"] == conclusion
                  and run["head_repository"]["full_name"] == repo, "Run identity/status differs")
    run_check(v.read_json(root / "builder-run-api.json"), replay["builder"], "failure")
    run_check(v.read_json(root / "source-run-api.json"), source["build"], "success")
    jobs = v.read_json(root / "builder-jobs-api.json")
    v.require(jobs["total_count"] == len(jobs["jobs"]), "Incomplete builder job API response")
    selected = [j for j in jobs["jobs"] if j["id"] == replay["builder"]["jobId"]]
    v.require(len(selected) == 1, "Exact builder job missing")
    job, b = selected[0], replay["builder"]
    v.require(job["run_id"] == b["runId"] and job["run_attempt"] == b["runAttempt"]
              and job["head_sha"] == b["head"] and job["name"] == b["jobName"]
              and job["status"] == "completed" and job["conclusion"] == "failure", "Builder job identity differs")
    def step_check(pin, conclusion):
        found = [s for s in job["steps"] if s["number"] == pin["number"] and s["name"] == pin["name"]]
        v.require(len(found) == 1 and found[0]["status"] == "completed" and found[0]["conclusion"] == conclusion,
                  "Required builder step differs: " + pin["name"])
    for step in b["requiredSuccessfulSteps"]:
        step_check(step, "success")
    step_check(b["failedLifecycleStep"], "failure")
    for name, pin, run in (("candidate", replay["candidateArtifact"], b),
                           ("builder-evidence", replay["builderEvidenceArtifact"], b),
                           ("source-evidence", source["evidenceArtifact"], source["build"])):
        actual = v.read_json(root / (name + "-artifact-api.json"))
        v.require(actual["id"] == pin["id"] and actual["name"] == pin["name"]
                  and actual["size_in_bytes"] == pin["bytes"] and actual["digest"] == pin["digest"]
                  and actual["expired"] is False
                  and datetime.fromisoformat(actual["expires_at"].replace("Z", "+00:00")) > now
                  and actual["workflow_run"]["id"] == run["runId"]
                  and actual["workflow_run"]["head_sha"] == run["head"], "Artifact API identity differs: " + name)
    return {"api_admission_passed": True, "builder_overall_qualified": False,
            "wrapping_and_candidate_retention_passed": True, "previous_lifecycle_accepted": False,
            "builder_run_id": b["runId"], "builder_head": b["head"], "source_run_id": source["build"]["runId"]}


def verify_evidence(v, replay, source, builder_root, source_root):
    paths = {k: v.verify_file(source_root, p) for k, p in source["evidenceFiles"].items()}
    manifest, health, admission, portable = [v.read_json(paths[k]) for k in
        ("structure", "health", "sourceAdmission", "portableReceipt")]
    s = source["source"]
    for obj in (manifest, admission, portable):
        v.require(obj["source_commit"] == s["commit"] and obj["source_tree_sha256"] == s["treeSha256"],
                  "Frozen source evidence identity differs")
    v.require(manifest["source_count"] == admission["source_count"] == s["count"]
              and manifest["schema"] == 2 and manifest["target"] == "win32-x64"
              and manifest["artifact_kind"] == "official-prepared-unpacked-Windows-x64-build-only"
              and manifest["desktop_and_embedded_cli_stamp_match"] is True
              and manifest["production_update_enabled"] is False and manifest["base_version"] == s["baseVersion"],
              "Original manifest qualification differs")
    v.require(health["native_windows"] is True and health["architecture"] == "X64" and health["plain_launch"] is True
              and health["contained_backend_health"] is True and health["normal_window_close"] is True
              and health["forced_cleanup"] is False and health["error"] is None
              and health["health_version"] == s["baseVersion"]
              and str(health["build_run_id"]) == str(source["build"]["runId"]), "Original native health differs")
    v.require(portable["archive"] == source["archive"]["path"] and portable["sha256"] == source["archive"]["sha256"]
              and portable["bytes"] == source["archive"]["bytes"] and portable["compression_before_any_launch"] is True
              and portable["seven_zip_roundtrip_every_file_sha256_verified"] is True
              and portable["all_hidden_files_included"] is True, "Original portable custody differs")
    rows = manifest["files"]
    names = set()
    for row in rows:
        v.safe_name(row["path"])
        v.require(row["path"].casefold() not in names and type(row["bytes"]) is int and row["bytes"] >= 0
                  and v.HEX.fullmatch(row["sha256"]), "Manifest row duplicate or malformed")
        names.add(row["path"].casefold())
    payload_bytes = sum(row["bytes"] for row in rows)
    v.require(payload_bytes == replay["scratchBudgetBasis"]["payloadBytes"], "Measured payload budget differs")
    receipts = {k: v.read_json(v.verify_file(builder_root, p)) for k, p in replay["builderEvidenceFiles"].items()}
    build, prepared = receipts["installer-build.json"], receipts["prepackaged.prepared.json"]
    expected_payload = {"sourceCommit": s["commit"], "sourceTreeSha256": s["treeSha256"], "sourceCount": s["count"],
                        "baseVersion": s["baseVersion"], "fileCount": len(rows), "rebuilt": False}
    v.require(build["payload"] == prepared["payload"] == expected_payload, "Original builder payload differs")
    v.require(build["bytes"] == replay["installer"]["bytes"] and build["sha256"] == replay["installer"]["sha256"]
              and build["installer"].replace("\\", "/").split("/")[-1] == replay["installer"]["path"]
              and build["custody"] == prepared["custody"] and build["helperSource"] == prepared["packagingSource"]
              and build["fresh_native_inputs"] is True and build["real_consumer_vitest_passed"] is True
              and build["immutable_payload_before_after_match"] is True and build["signed"] is False
              and build["installation_verified"] is False and build["standard_user_installation_verified"] is False,
              "Build receipt is not the frozen unaccepted unsigned candidate")
    v.require(prepared["schema"] == 1 and prepared["lane"] == "unsigned-manual-nsis-prepackaged-test"
              and prepared["target"] == "win32-x64", "Prepared receipt lane differs")
    c = build["custody"]
    v.require(c["runId"] == str(source["build"]["runId"]) and c["archiveSha256"] == source["archive"]["sha256"]
              and c["archiveBytes"] == source["archive"]["bytes"]
              and c["manifestSha256"] == source["evidenceFiles"]["structure"]["sha256"]
              and c["nativeHealthSha256"] == source["evidenceFiles"]["health"]["sha256"], "Cross-run custody differs")
    before = receipts["payload-before.json"]
    v.require(before == receipts["payload-after.json"] == receipts["pristine-tree.json"]
              and before["every_payload_file_sha256_verified"] is True and before["exact_membership"] is True
              and before["payload_files"] == len(rows) and before["payload_bytes"] == payload_bytes
              and before["source_commit"] == s["commit"] and before["source_tree_sha256"] == s["treeSha256"]
              and before["rebuilt"] is False, "Original wrapping changed the payload")
    previous = receipts["installer-lifecycle.json"]
    v.require(previous["accepted_with_declared_limits"] is False and previous["installed"] is True
              and previous["every_installed_payload_file_verified"] is False and previous["native_window"] is False
              and previous["normal_uninstall"] is False and previous["forced_cleanup"] is False
              and previous["installer_sha256"] == replay["installer"]["sha256"]
              and str(previous["consumer_run_id"]) == str(replay["builder"]["runId"]), "Previous failure evidence differs")
    return {"frozen_evidence_admission_passed": True, "payload_files": len(rows), "payload_bytes": payload_bytes,
            "source_commit": s["commit"], "source_tree_sha256": s["treeSha256"],
            "previous_lifecycle_accepted": False, "portable_downloaded": False, "rebuilt": False}, build


def relocate(v, replay, build, candidate, builder_root, output):
    installer = v.verify_file(candidate, replay["installer"])
    actual = set()
    for p in Path(candidate).rglob("*"):
        v.owned(candidate, p.relative_to(candidate).as_posix())
        if p.is_file():
            actual.add(p.relative_to(candidate).as_posix())
    v.require(actual == {replay["installer"]["path"]}, "Candidate artifact membership differs")
    with installer.open("rb") as stream:
        v.require(stream.read(2) == b"MZ", "Candidate is not a PE executable")
    original_dir = output / "original-builder-receipts"
    original_dir.mkdir(parents=True, exist_ok=False)
    for row in replay["builderEvidenceFiles"].values():
        original = v.verify_file(builder_root, row)
        destination = original_dir / row["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, destination)
        v.verify_file(original_dir, row)
    relocated = copy.deepcopy(build)
    relocated["installer"] = str(installer.resolve())
    v.require({k: x for k, x in relocated.items() if k != "installer"}
              == {k: x for k, x in build.items() if k != "installer"}, "Receipt relocation changed frozen facts")
    path = output / "installer-build.relocated.json"
    v.require(not path.exists(), "Fresh relocated receipt required")
    path.write_text(json.dumps(relocated, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"exact_installer_admitted": True, "installer": str(installer.resolve()),
            "bytes": replay["installer"]["bytes"], "sha256": replay["installer"]["sha256"],
            "original_build_receipt_sha256": replay["builderEvidenceFiles"]["installer-build.json"]["sha256"],
            "relocated_receipt_sha256": v.sha(path), "only_changed_field": "installer",
            "repackaged": False, "rebuilt": False, "lifecycle_accepted": False}


def verify_acceptance(v, replay, source, root, current_run):
    value = v.read_json(root / "installer-lifecycle.json")
    required = ("native_windows", "unsigned_installer", "installed", "every_installed_payload_file_verified",
                "native_window", "contained_backend_health", "normal_window_close", "contained_processes_stopped",
                "normal_uninstall", "installed_tree_removed", "synthetic_userdata_retained", "accepted_with_declared_limits")
    v.require(all(value[k] is True for k in required) and value["forced_cleanup"] is False and value["error"] is None
              and value["immutable_payload_rebuilt"] is False and value["installer_sha256"] == replay["installer"]["sha256"]
              and value["build_run_id"] == source["build"]["runId"] and str(value["consumer_run_id"]) == str(current_run)
              and value["coverage"] == source["lifecycleMode"] and value["architecture"] == "X64",
              "Current replay lifecycle is not accepted")
    return {"accepted_with_declared_limits": True, "coverage": value["coverage"], "current_run_id": str(current_run),
            "installer_sha256": replay["installer"]["sha256"], "standard_user_installation_verified": False,
            "offline_verified": False, "physical_ime_verified": False, "automatic_update_verified": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("contract", "api", "evidence", "downloads", "acceptance"))
    for name in ("consumer", "contract", "source-contract", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    for name in ("api-root", "builder-evidence", "source-evidence", "candidate", "evidence-root"):
        parser.add_argument("--" + name, type=Path)
    parser.add_argument("--current-run")
    args = parser.parse_args()
    v = load_consumer(args.consumer)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        replay, source = read_contract(v, args.contract, args.source_contract)
        if args.mode == "contract":
            result = {"replay_contract_admitted": True, "minimum_scratch_bytes": replay["minimumScratchBytes"]}
        elif args.mode == "api":
            result = verify_api(v, replay, source, args.api_root)
        elif args.mode in ("evidence", "downloads"):
            verify_api(v, replay, source, args.api_root)
            result, build = verify_evidence(v, replay, source, args.builder_evidence, args.source_evidence)
            if args.mode == "downloads":
                result.update(relocate(v, replay, build, args.candidate, args.builder_evidence, args.output.parent))
        else:
            v.require(args.current_run, "Current replay run identity required")
            result = verify_acceptance(v, replay, source, args.evidence_root, args.current_run)
        args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:
        args.output.write_text(json.dumps({"admitted": False, "mode": args.mode, "error": str(exc)}, indent=2) + "\n")
        raise


if __name__ == "__main__":
    main()
