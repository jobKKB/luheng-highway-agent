"""Admit the two retained installers without rebuilding or rewriting producer evidence."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PureWindowsPath
import re
import runpy
import shutil
import subprocess
import zipfile

REPOSITORY = "jobKKB/luheng-highway-agent"
WORKFLOW = ".github/workflows/windows-artifact-recovery.yml"
PRODUCERS = {
    "0.7.0": {"runId": 37750546324, "headSha": "88283312b213d95f330964d1d8e4302052f2be8c", "installerArtifactId": 11541422993},
    "0.7.1": {"runId": 37751086133, "headSha": "0b886722f2861ec551bb6c8c7aae24f0d260e6c1", "installerArtifactId": 11542771041},
}
FAILURES = {"Install launch and uninstall using a restricted Windows token", "Require all native acceptance stages before release"}
REQUIRED = (
    "Checkout approved source-only controller", "Checkout immutable official source",
    "Select host Python for official preparation", "Check installer helpers and release scripts before preparing payload",
    "Reconstruct and admit the exact current source-only candidate", "Run narrow real Windows Vitest before full payload preparation",
    "Prepare locked native Windows inputs", "Run canonical native launcher regression and real packaging Vitest",
    "Build only from the admitted official prepared inputs", "Bind the unpacked structure and hashes to the source admission",
    "Compress pristine package before any launch and verify every extracted file", "Preserve pristine portable before functional acceptance",
    "Exercise shipped CLI terminal files and disabled scheduler without package writes",
    "Exercise a plain native window and contained backend health", "Package the unchanged admitted payload as a Windows installer",
    "Preserve installer bytes before installation acceptance", "Preserve source build regression tool and native startup diagnostics",
)
NAMES = {"sourceAdmission": "source-admission.json", "structure": "windows-unpacked-structure.json",
         "health": "native-startup.json", "installerReceipt": "installer-build.json"}
consumer = runpy.run_path(str(Path(__file__).resolve().parents[1] / "native-installer-consumer/verify_consumer.py"))
require, read, sha, owned = (consumer[key] for key in ("require", "read_json", "sha", "owned"))


def validate_producer(run, jobs, pin):
    require(run["id"] == pin["runId"] and run["head_sha"] == pin["headSha"] and
            run["status"] == "completed" and run["conclusion"] in ("success", "failure") and
            run["repository"]["full_name"] == REPOSITORY and
            run["path"] == ".github/workflows/hermes-native-package-experiment.yml", "Wrong or unfinished producer")
    require(jobs.get("total_count") == 1 and len(jobs["jobs"]) == 1, "Unexpected producer jobs")
    job = jobs["jobs"][0]
    require(job["name"] == "windows-x64" and job["run_id"] == run["id"] and job["status"] == "completed" and
            job["conclusion"] == run["conclusion"], "Wrong producer job")
    steps = {step["name"]: step for step in job["steps"]}
    require(len(steps) == len(job["steps"]), "Duplicate producer steps")
    for name in REQUIRED:
        require(steps.get(name, {}).get("conclusion") == "success", "Producer prerequisite failed: " + name)
    failed = {name for name, step in steps.items() if step["conclusion"] not in ("success", "skipped")}
    require(failed == (FAILURES if run["conclusion"] == "failure" else set()), "Producer failed outside the lifecycle-only exception")
    return run


def validate_acceptance(run, pin):
    require(run["id"] == pin["runId"] and run["head_sha"] == pin["headSha"] and
            run["status"] == "completed" and run["conclusion"] == "success" and
            run["repository"]["full_name"] == REPOSITORY and run["path"] == WORKFLOW,
            "Recovery acceptance run is not the pinned successful workflow")


def validate_artifact(row, run, expected_id, name):
    require(row["id"] == expected_id and row["name"] == name and row["expired"] is False and
            row["workflow_run"]["id"] == run["id"] and row["workflow_run"]["head_sha"] == run["head_sha"] and
            re.fullmatch(r"sha256:[a-f0-9]{64}", row["digest"]) and type(row["size_in_bytes"]) is int and
            row["size_in_bytes"] > 0, "Artifact identity or digest is not admitted")


def validate_lock(lock, version):
    require(lock["schema"] == "luheng-artifact-recovery/v1" and lock["repository"] == REPOSITORY and
            lock["version"] == version and version in PRODUCERS, "Unexpected recovery lock")
    pin = lock["producer"]
    require(all(pin[key] == value for key, value in PRODUCERS[version].items()), "Recovery is limited to the retained A/B producer artifacts")
    require(type(pin["evidenceArtifactId"]) is int and pin["evidenceArtifactId"] > 0, "Evidence artifact must be pinned")
    for key in ("installerArtifactDigest", "evidenceArtifactDigest"):
        require(re.fullmatch(r"sha256:[a-f0-9]{64}", pin[key]), "Artifact digest must be pinned")
    return pin


def validate_context(context, current=False):
    pin = validate_lock(context["lock"], context["lock"]["version"])
    run = context["producerRun"]
    validate_producer(run, context["producerJobs"], pin)
    for kind, name in (("installer", "luheng-windows-installer-unreleased"), ("evidence", "luheng-windows-release-evidence")):
        row = context["artifacts"][kind]
        validate_artifact(row, run, pin[kind + "ArtifactId"], name)
        require(row["digest"] == pin[kind + "ArtifactDigest"], "Artifact digest changed")
    acceptance = context["acceptance"]
    require(type(acceptance["runId"]) is int and acceptance["runId"] > 0 and
            re.fullmatch(r"[a-f0-9]{40}", acceptance["headSha"]) and acceptance["workflow"] == WORKFLOW,
            "Invalid recovery execution identity")
    require(acceptance["runId"] != run["id"], "Recovery cannot impersonate the producer")
    if current:
        require(str(acceptance["runId"]) == os.environ.get("GITHUB_RUN_ID") and
                acceptance["headSha"] == os.environ.get("GITHUB_SHA"), "Recovery is not executing in its actual pinned run")
    return context


def validate_lifecycle(life, producer_id, acceptance_id, build):
    for key in ("restricted_token_lifecycle_verified", "accepted_with_declared_limits", "installed",
                "every_installed_payload_file_verified", "native_window", "contained_backend_health", "normal_window_close",
                "contained_processes_stopped", "normal_uninstall", "installed_tree_removed", "synthetic_userdata_retained"):
        require(life[key] is True, "Recovery lifecycle failed: " + key)
    require(life["error"] is None and life["forced_cleanup"] is False and life["immutable_payload_rebuilt"] is False and
            life["scope"] == "artifact-recovery" and str(life["build_run_id"]) == str(producer_id) and
            str(life["consumer_run_id"]) == str(acceptance_id) and str(life["acceptance_run_id"]) == str(acceptance_id) and
            life["installer_sha256"] == build["sha256"] and life["health_version"] == build["payload"]["baseVersion"] and
            life["coverage"] == "restricted-token-same-user" and life["architecture"] == "X64", "Recovery lifecycle identity differs")


def validate_provenance(prov, entry):
    require(prov["schema"] == "luheng-recovery-provenance/v1", "Unexpected recovery provenance")
    context = validate_context(prov["context"])
    identity, recovered = entry["evidence"], entry["evidence"]["recovery"]
    require(context["producerRun"]["id"] == identity["runId"] and context["producerRun"]["head_sha"] == identity["headSha"] and
            context["acceptance"]["runId"] == recovered["runId"] and context["acceptance"]["headSha"] == recovered["headSha"] and
            context["lock"]["version"] == entry["version"] and prov["producerFiles"] == context["producerFiles"] == identity["files"] and
            prov["installer"] == context["installer"] and
            prov["lifecycle"] == recovered["files"]["lifecycle"] and prov["installer"]["sha256"] == entry["sha256"] and
            prov["installer"]["bytes"] == entry["bytes"], "Recovery provenance disagrees with the pair")
    return context


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/{path}"], text=True))


def unique(root, basename):
    found = list(Path(root).rglob(basename))
    require(len(found) == 1, "Expected one original file: " + basename)
    return owned(root, found[0].relative_to(root).as_posix())


def pin(root, path):
    path = owned(root, path.relative_to(root).as_posix())
    return {"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size, "sha256": sha(path)}


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def download(context, kind, destination):
    """Hash the API archive before extracting only ordinary, contained files."""
    metadata = context["artifacts"][kind]
    destination.mkdir(parents=True, exist_ok=False)
    archive = destination.parent / (kind + ".zip")
    with archive.open("xb") as stream:
        subprocess.run(["gh", "api", f"repos/{REPOSITORY}/actions/artifacts/{metadata['id']}/zip"], stdout=stream, check=True)
    require(archive.stat().st_size == metadata["size_in_bytes"] and "sha256:" + sha(archive) == metadata["digest"],
            "Downloaded artifact archive digest or size differs")
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        limit = 2 * 1024 ** 3 if kind == "installer" else 100 * 1024 ** 2
        require(sum(row.file_size for row in entries) < limit, "Artifact exceeds its reviewed extraction bound")
        seen = set()
        for row in entries:
            name = row.filename.rstrip("/")
            consumer["safe_name"](name)
            require(name.casefold() not in seen and (row.external_attr >> 16) & 0o170000 != 0o120000,
                    "Duplicate or linked artifact entry")
            seen.add(name.casefold())
            target = owned(destination, name)
            if row.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(row) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
    archive.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("admit", "download", "prepare", "seal"))
    for name in ("lock", "context", "raw_evidence", "raw_installer", "evidence", "lifecycle"):
        parser.add_argument("--" + name.replace("_", "-"), type=Path)
    args = parser.parse_args()
    if args.mode == "admit":
        lock = read(args.lock)
        producer = validate_lock(lock, lock["version"])
        run = api(f"actions/runs/{producer['runId']}")
        jobs = api(f"actions/runs/{producer['runId']}/jobs?per_page=100")
        artifacts = {kind: api(f"actions/artifacts/{producer[kind + 'ArtifactId']}") for kind in ("installer", "evidence")}
        context = {"lock": lock, "producerRun": run, "producerJobs": jobs, "artifacts": artifacts,
                   "acceptance": {"runId": int(os.environ["GITHUB_RUN_ID"]), "headSha": os.environ["GITHUB_SHA"], "workflow": WORKFLOW}}
        validate_context(context, current=True)
        save(args.context, context)
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
            for key in ("installerArtifactId", "evidenceArtifactId"):
                stream.write(f"{key}={producer[key]}\n")
    elif args.mode == "download":
        context = validate_context(read(args.context), current=True)
        download(context, "evidence", args.raw_evidence)
        download(context, "installer", args.raw_installer)
    elif args.mode == "prepare":
        context = validate_context(read(args.context), current=True)
        root = args.evidence.absolute()
        root.mkdir(parents=True, exist_ok=False)
        files = {}
        for key, name in NAMES.items():
            source = unique(args.raw_evidence, name)
            target = root / "producer" / name
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(source, target)
            files[key] = pin(root, target)
        build = read(root / files["installerReceipt"]["path"])
        original = unique(args.raw_installer, "installer-build.json")
        require(sha(original) == files["installerReceipt"]["sha256"], "Installer and evidence artifact receipts differ")
        installer = unique(args.raw_installer, PureWindowsPath(build["installer"]).name)
        require(installer.stat().st_size == build["bytes"] and sha(installer) == build["sha256"], "Original installer bytes differ")
        target = root / "installer" / installer.name
        target.parent.mkdir()
        shutil.move(str(installer), target)
        context["producerFiles"] = files
        context["installer"] = pin(root, target)
        save(root / "recovery-admission.json", context)
    else:
        root = args.evidence.absolute()
        context = validate_context(read(root / "recovery-admission.json"), current=True)
        build = read(consumer["verify_file"](root, context["producerFiles"]["installerReceipt"]))
        life = read(args.lifecycle)
        validate_lifecycle(life, context["producerRun"]["id"], context["acceptance"]["runId"], build)
        for row in context["producerFiles"].values():
            consumer["verify_file"](root, row)
        target = root / "acceptance/installer-lifecycle.json"
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(args.lifecycle, target)
        save(root / "acceptance/provenance.json", {"schema": "luheng-recovery-provenance/v1", "context": context,
             "producerFiles": context["producerFiles"], "installer": context["installer"], "lifecycle": pin(root, target)})


if __name__ == "__main__":
    main()
