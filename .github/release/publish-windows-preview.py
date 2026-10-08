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
    "from": {"runId": 37750546324, "headSha": "88283312b213d95f330964d1d8e4302052f2be8c", "version": "0.7.0", "tag": "v0.7.0-beta.1"},
    "to": {"runId": 37751086133, "headSha": "0b886722f2861ec551bb6c8c7aae24f0d260e6c1", "version": "0.7.1", "tag": "v0.7.1-beta.1"},
}
QUALIFIER = runpy.run_path(str(ROOT / "qa/release-windows/verify-online-update.py"))
RECOVERY = runpy.run_path(str(ROOT / "qa/release-windows/artifact-recovery.py"))
CREATE_FEED = runpy.run_path(str(ROOT / "qa/release-windows/create-update-feed.py"))["create_feed"]
require, read, sha, owned = (QUALIFIER[key] for key in ("require", "read", "sha", "owned"))
EVIDENCE_NAMES = {"sourceAdmission": "source-admission.json", "structure": "windows-unpacked-structure.json",
                  "health": "native-startup.json", "installerReceipt": "installer-build.json"}


def gh(*args):
    return subprocess.check_output(["gh", *map(str, args)], text=True).strip()


def api(path, optional=False):
    result = subprocess.run(["gh", "api", f"repos/{REPOSITORY}/{path}"], capture_output=True, text=True)
    if optional and result.returncode and "(HTTP 404)" in result.stderr:
        return None
    require(result.returncode == 0, "GitHub API failed: " + result.stderr)
    return json.loads(result.stdout)


def validate_lock(lock):
    require(set(lock) == {"schema", "repository", "publish", "producers", "recoveries"} and
            lock["schema"] == "luheng-preview-release/v1" and lock["repository"] == REPOSITORY and
            lock["publish"] is True and lock["producers"] == PRODUCERS and set(lock["recoveries"]) == set(PRODUCERS),
            "Release lock differs from the reviewed producer/recovery pair")
    for side, pin in lock["recoveries"].items():
        require(set(pin) == {"runId", "headSha", "artifactId"} and
                type(pin["runId"]) is int and pin["runId"] > 0 and type(pin["artifactId"]) is int and pin["artifactId"] > 0 and
                re.fullmatch(r"[a-f0-9]{40}", pin["headSha"]) and pin["runId"] != PRODUCERS[side]["runId"],
                "Recovery must identify a separate reviewed run and artifact")


def validate_run(bundle, pin, recovery):
    RECOVERY["validate_producer"](bundle["producer"], bundle["producerJobs"], pin)
    RECOVERY["validate_acceptance"](bundle["acceptance"], recovery)


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


def admit(root, pin, run, recovery):
    provenance = unique_file(root / "evidence", "provenance.json")
    require(provenance.parent.name == "acceptance", "Unexpected recovery provenance layout")
    evidence = provenance.parent.parent
    paths = {key: unique_file(evidence, name) for key, name in EVIDENCE_NAMES.items()}
    build, structure = read(paths["installerReceipt"]), read(paths["structure"])
    require(sha(unique_file(root / "installer", "installer-build.json")) == sha(paths["installerReceipt"]),
            "Original installer and recovered evidence receipts differ")
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
    recovered_paths = {"lifecycle": owned(evidence, "acceptance/installer-lifecycle.json"), "provenance": provenance}
    entry["evidence"]["recovery"] = {**recovery, "artifact": "luheng-windows-recovery-evidence-" + pin["version"],
        "files": {key: {"path": path.relative_to(evidence).as_posix(), "bytes": path.stat().st_size, "sha256": sha(path)}
                  for key, path in recovered_paths.items()}}
    QUALIFIER["qualify"](entry, evidence, run)
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
                   "producerJobs": api(f"actions/runs/{pin['runId']}/jobs?per_page=100"),
                   "acceptance": api(f"actions/runs/{lock['recoveries'][side]['runId']}")} for side, pin in PRODUCERS.items()}
    for side, pin in PRODUCERS.items():
        validate_run(runs[side], pin, lock["recoveries"][side])
    pair = {"schema": "luheng-online-update/v1", "repository": REPOSITORY, "feed": QUALIFIER["FEED"]}
    plans, receipt = [], {}
    for side, pin in PRODUCERS.items():
        root = args.output / side
        root.mkdir()
        before = artifacts(pin["runId"])
        recovery = lock["recoveries"][side]
        recovery_name = "luheng-windows-recovery-evidence-" + pin["version"]
        recovered = artifacts(recovery["runId"], [recovery_name])
        RECOVERY["validate_artifact"](recovered[recovery_name], runs[side]["acceptance"], recovery["artifactId"], recovery_name)
        gh("run", "download", pin["runId"], "--repo", REPOSITORY, "--name", "luheng-windows-installer-unreleased", "--dir", root / "installer")
        gh("run", "download", recovery["runId"], "--repo", REPOSITORY, "--name", recovery_name, "--dir", root / "evidence")
        require(before == artifacts(pin["runId"]), "Artifact identity changed during download")
        require(recovered == artifacts(recovery["runId"], [recovery_name]), "Recovery artifact changed during download")
        current = {"producer": api(f"actions/runs/{pin['runId']}"),
                   "producerJobs": api(f"actions/runs/{pin['runId']}/jobs?per_page=100"),
                   "acceptance": api(f"actions/runs/{recovery['runId']}")}
        validate_run(current, pin, recovery)
        require(all(current[kind]["run_attempt"] == runs[side][kind]["run_attempt"] for kind in ("producer", "acceptance")),
                "Producer or acceptance was rerun during download")
        current["producerArtifacts"] = {"installer": before["luheng-windows-installer-unreleased"],
                                        "evidence": before["luheng-windows-release-evidence"]}
        current["acceptanceArtifact"] = recovered[recovery_name]
        pair[side], feed, files = admit(root, pin, current, recovery)
        receipt[side] = {"run": pin, "producerConclusion": current["producer"]["conclusion"], "artifacts": before,
                         "recovery": recovery, "recoveryArtifact": recovered[recovery_name]}
        notes = root / "release-notes.md"
        notes.write_text(Path(__file__).with_name(f"notes-{pin['version']}.md").read_text(encoding="utf-8") +
                         f"\nOriginal producer conclusion: {current['producer']['conclusion']}. Independent native installation acceptance: https://github.com/{REPOSITORY}/actions/runs/{recovery['runId']}.\n", encoding="utf-8")
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
