"""Publish the two fixed, qualified Windows producer artifacts without executing them."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path, PureWindowsPath
import re
import runpy
import subprocess

ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "jobKKB/luheng-highway-agent"
PRODUCERS = {
    "from": {"runId": None, "headSha": None, "version": "0.7.0", "tag": "v0.7.0-beta.1"},
    "to": {"runId": None, "headSha": None, "version": "0.7.1", "tag": "v0.7.1-beta.1"},
}
# New native producer runs must replace these unset pins after the long-path fix.
# Previous failed installers are diagnostic inputs, never publication candidates.
WORKFLOW = ".github/workflows/hermes-native-package-experiment.yml"
REQUIRED = (
    "Checkout approved source-only controller", "Checkout immutable official source",
    "Select managed Python for official preparation", "Check installer helpers and release scripts before preparing payload",
    "Reconstruct and admit the exact current source-only candidate", "Run narrow real Windows Vitest before full payload preparation",
    "Prepare locked native Windows inputs", "Run canonical native launcher regression and real packaging Vitest",
    "Build only from the admitted official prepared inputs", "Bind the unpacked structure and hashes to the source admission",
    "Compress pristine package before any launch and verify every extracted file", "Preserve pristine portable before functional acceptance",
    "Exercise shipped CLI terminal files and disabled scheduler without package writes",
    "Exercise a plain native window and contained backend health", "Package the unchanged admitted payload as a Windows installer",
    "Preserve installer bytes before installation acceptance", "Install launch and uninstall using a restricted Windows token",
    "Preserve source build regression tool and native startup diagnostics", "Require all native acceptance stages before release",
)
QUALIFIER = runpy.run_path(str(ROOT / "qa/release-windows/verify-online-update.py"))
CREATE_FEED = runpy.run_path(str(ROOT / "qa/release-windows/create-update-feed.py"))["create_feed"]
require, read, sha, owned = (QUALIFIER[key] for key in ("require", "read", "sha", "owned"))
EVIDENCE_NAMES = {"sourceAdmission": "source-admission.json", "structure": "windows-unpacked-structure.json",
                  "health": "native-startup.json", "installerReceipt": "installer-build.json", "lifecycle": "installer-lifecycle.json"}


def gh(*args):
    return subprocess.check_output(["gh", *map(str, args)], text=True).strip()


def api(path, optional=False):
    result = subprocess.run(["gh", "api", f"repos/{REPOSITORY}/{path}"], capture_output=True, text=True)
    if optional and result.returncode and "(HTTP 404)" in result.stderr:
        return None
    require(result.returncode == 0, "GitHub API failed: " + result.stderr)
    return json.loads(result.stdout)


def validate_lock(lock):
    for pin in PRODUCERS.values():
        require(type(pin["runId"]) is int and pin["runId"] > 0 and isinstance(pin["headSha"], str) and
                re.fullmatch(r"[a-f0-9]{40}", pin["headSha"]), "New successful native producer identities are not pinned")
    require(PRODUCERS["from"]["runId"] != PRODUCERS["to"]["runId"], "Separate real version producers required")
    require(set(lock) == {"schema", "repository", "publish", "producers"} and
            lock["schema"] == "luheng-preview-release/v2" and lock["repository"] == REPOSITORY and
            lock["publish"] is True and lock["producers"] == PRODUCERS,
            "Release lock differs from the reviewed complete native producer pair")


def validate_run(bundle, pin):
    run, jobs = bundle["producer"], bundle["producerJobs"]
    require(run["id"] == pin["runId"] and run["head_sha"] == pin["headSha"] and
            run["status"] == "completed" and run["conclusion"] == "success" and
            run["repository"]["full_name"] == REPOSITORY and run["path"] == WORKFLOW and
            type(run["run_attempt"]) is int and run["run_attempt"] > 0, "Complete successful native producer required")
    require(jobs.get("total_count") == 1 and len(jobs["jobs"]) == 1, "Unexpected native producer jobs")
    job = jobs["jobs"][0]
    require(job["name"] == "windows-x64" and job["run_id"] == run["id"] and job["status"] == "completed" and
            job["conclusion"] == "success", "Native producer job failed or differs")
    steps = {row["name"]: row for row in job["steps"]}
    require(len(steps) == len(job["steps"]), "Duplicate native producer steps")
    for name in REQUIRED:
        require(steps.get(name, {}).get("conclusion") == "success", "Native producer prerequisite failed: " + name)
    require(all(row["conclusion"] in ("success", "skipped") for row in steps.values()), "Native producer has an unsuccessful step")


def validate_artifacts(rows, run):
    for name, row in rows.items():
        require(row["name"] == name and type(row["id"]) is int and row["id"] > 0 and row["expired"] is False and
                row["workflow_run"]["id"] == run["id"] and row["workflow_run"]["head_sha"] == run["head_sha"] and
                type(row["size_in_bytes"]) is int and row["size_in_bytes"] > 0 and
                re.fullmatch(r"sha256:[a-f0-9]{64}", row["digest"]), "Artifact does not belong to the admitted native producer")


def artifacts(run_id, names=("luheng-windows-installer-unreleased", "luheng-windows-release-evidence")):
    pages = json.loads(gh("api", f"repos/{REPOSITORY}/actions/runs/{run_id}/artifacts?per_page=100", "--paginate", "--slurp"))
    rows = [row for page in pages for row in page["artifacts"]]
    result = {}
    for name in names:
        matches = [row for row in rows if row["name"] == name]
        require(len(matches) == 1 and matches[0]["expired"] is False, "Missing, duplicate or expired producer artifact: " + name)
        result[name] = matches[0]
    return result


def unique_file(root, basename):
    paths = list(root.rglob(basename))
    require(len(paths) == 1, "Expected exactly one artifact file: " + basename)
    path = owned(root, paths[0].relative_to(root).as_posix())
    require(path.is_file(), "Artifact entry is not a regular file")
    return path


def admit(root, pin, run):
    evidence = root / "evidence"
    paths = {key: unique_file(evidence, name) for key, name in EVIDENCE_NAMES.items()}
    build, structure = read(paths["installerReceipt"]), read(paths["structure"])
    require(sha(unique_file(root / "installer", "installer-build.json")) == sha(paths["installerReceipt"]),
            "Installer and same-run evidence receipts differ")
    installer = unique_file(root / "installer", PureWindowsPath(build["installer"]).name)
    feed, sums = CREATE_FEED(installer, pin["version"], pin["tag"])
    file = feed["files"][0]
    require(file["size"] == build["bytes"] and file["sha256"] == build["sha256"], "Actual installer bytes differ from producer receipt")
    inventory = {row["path"]: row for row in structure["files"]}
    entry = {"version": pin["version"], "url": file["url"], "bytes": file["size"], "sha256": file["sha256"],
             "exeSha256": inventory["LuhengOfficeAgent.exe"]["sha256"], "asarSha256": inventory["resources/app.asar"]["sha256"],
             "evidence": {"runId": pin["runId"], "headSha": pin["headSha"], "artifact": "luheng-windows-release-evidence",
                          "files": {key: {"path": path.relative_to(evidence).as_posix(), "bytes": path.stat().st_size,
                                          "sha256": sha(path)} for key, path in paths.items()}}}
    QUALIFIER["qualify"](entry, evidence, run["producer"])
    checksum = root / "SHA256SUMS.txt"
    checksum.write_text(sums, encoding="utf-8")
    return entry, feed, [installer, checksum]


def tag_matches(tag, head):
    ref = api("git/ref/tags/" + tag, optional=True)
    if ref is None:
        return False
    obj = ref["object"]
    for _ in range(5):
        if obj["type"] != "tag":
            break
        obj = api("git/tags/" + obj["sha"])["object"]
    require(obj["type"] == "commit" and obj["sha"] == head, "Existing release tag points to a different commit")
    return True


def verify_assets(release, files):
    expected = {path.name: path for path in files}
    seen = set()
    for asset in release["assets"]:
        require(asset["name"] in expected and asset["name"] not in seen, "Unexpected or duplicate existing release asset")
        path = expected[asset["name"]]
        require(asset["state"] == "uploaded" and asset["size"] == path.stat().st_size,
                "Existing release asset is incomplete or has different bytes")
        actual = asset.get("digest")
        if actual is None:
            # Older assets may lack API digests; compare their bytes on the CI runner.
            downloaded = path.parent / ("remote-" + path.name)
            with downloaded.open("xb") as stream:
                subprocess.run(["gh", "api", f"repos/{REPOSITORY}/releases/assets/{asset['id']}",
                                "-H", "Accept: application/octet-stream"], stdout=stream, check=True)
            actual = "sha256:" + sha(downloaded)
            downloaded.unlink()
        require(actual == "sha256:" + sha(path), "Existing release asset digest differs; refusing replacement")
        seen.add(asset["name"])
    return [path for name, path in expected.items() if name not in seen]


def inspect_release(pin, files):
    tagged = tag_matches(pin["tag"], pin["headSha"])
    release = api("releases/tags/" + pin["tag"], optional=True)
    if release is None:
        return None, files
    require(release["prerelease"] is True and (tagged or (release["draft"] and release["target_commitish"] == pin["headSha"])),
            "Existing release has different target or release status")
    missing = verify_assets(release, files)
    require(release["draft"] or not missing, "Published release is incomplete; refusing to change it")
    return release, missing


def publish(plans):
    # Both releases and every existing asset are admitted before either release changes.
    for plan in plans:
        plan["release"], plan["missing"] = inspect_release(plan["pin"], plan["files"])
    for plan in plans:
        pin = plan["pin"]
        if plan["release"] is None:
            gh("release", "create", pin["tag"], "--repo", REPOSITORY, "--target", pin["headSha"],
               "--draft", "--prerelease", "--latest=false", "--title", f"Luheng Windows {pin['version']} Preview",
               "--notes-file", plan["notes"])
        if plan["missing"]:
            gh("release", "upload", pin["tag"], *plan["missing"], "--repo", REPOSITORY)
        release, missing = inspect_release(pin, plan["files"])
        require(release is not None and not missing, "Release upload did not verify")
    for plan in plans:
        pin = plan["pin"]
        release, _ = inspect_release(pin, plan["files"])
        if release["draft"]:
            gh("release", "edit", pin["tag"], "--repo", REPOSITORY, "--draft=false", "--prerelease", "--latest=false")
        release, missing = inspect_release(pin, plan["files"])
        require(not release["draft"] and not missing and tag_matches(pin["tag"], pin["headSha"]), "Public prerelease verification failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    lock = read(args.lock)
    validate_lock(lock)
    if args.publish:
        require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_REPOSITORY") == REPOSITORY and
                os.environ.get("GITHUB_REF") == "refs/heads/codex/windows-release-completion", "Publishing requires the approved Actions branch")
    require(not args.output.exists(), "Publisher output must be fresh")
    args.output.mkdir(parents=True)
    runs = {side: {"producer": api(f"actions/runs/{pin['runId']}"),
                   "producerJobs": api(f"actions/runs/{pin['runId']}/jobs?per_page=100")} for side, pin in PRODUCERS.items()}
    for side, pin in PRODUCERS.items():
        validate_run(runs[side], pin)
    pair = {"schema": "luheng-online-update/v1", "repository": REPOSITORY, "feed": QUALIFIER["FEED"]}
    plans, receipt = [], {}
    for side, pin in PRODUCERS.items():
        root = args.output / side
        root.mkdir()
        before = artifacts(pin["runId"])
        validate_artifacts(before, runs[side]["producer"])
        gh("run", "download", pin["runId"], "--repo", REPOSITORY, "--name", "luheng-windows-installer-unreleased", "--dir", root / "installer")
        gh("run", "download", pin["runId"], "--repo", REPOSITORY, "--name", "luheng-windows-release-evidence", "--dir", root / "evidence")
        require(before == artifacts(pin["runId"]), "Artifact identity changed during download")
        current = {"producer": api(f"actions/runs/{pin['runId']}"),
                   "producerJobs": api(f"actions/runs/{pin['runId']}/jobs?per_page=100")}
        validate_run(current, pin)
        require(current["producer"]["run_attempt"] == runs[side]["producer"]["run_attempt"], "Producer was rerun during download")
        pair[side], feed, files = admit(root, pin, current)
        receipt[side] = {"run": pin, "producerConclusion": current["producer"]["conclusion"], "artifacts": before}
        notes = root / "release-notes.md"
        notes.write_text(Path(__file__).with_name(f"notes-{pin['version']}.md").read_text(encoding="utf-8") +
                         f"\nComplete successful native build and installation acceptance: https://github.com/{REPOSITORY}/actions/runs/{pin['runId']}.\n", encoding="utf-8")
        plans.append({"pin": pin, "files": files, "notes": notes})
        if side == "to":
            (args.output / "latest.yml").write_text(json.dumps(feed, indent=2) + "\n", encoding="utf-8")
            (args.output / "SHA256SUMS.txt").write_bytes(files[1].read_bytes())
    QUALIFIER["validate"](pair)
    if args.publish:
        publish(plans)
    receipt["published"] = args.publish
    for name, data in (("pair-lock.json", pair), ("publication-receipt.json", receipt)):
        (args.output / name).write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
