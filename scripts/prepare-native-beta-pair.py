"""Verify official artifact member bytes and resolve the two live preview Releases.

This executes no application or installer. The subsequent disposable Windows
test uses its exact prepared references through the real client updater.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import urllib.request

REPOSITORY = "jobKKB/luheng-highway-agent"
REPOSITORY_ID = 1400818714
OWNER_ID = 137971851


def require(value, message):
    if not value:
        raise ValueError(message)


def unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"), object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid JSON number")))


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def verify_directory(directory, members):
    original = Path(directory)
    require(not original.is_symlink(), "Artifact directory link forbidden")
    root = original.resolve(strict=True)
    require(root.is_dir(), "Owned artifact directory required")
    actual = {}
    for path in root.rglob("*"):
        require(not path.is_symlink() and not (getattr(path.lstat(), "st_file_attributes", 0) & 1024),
                "Artifact links/reparse points are forbidden")
        if path.is_file():
            actual[path.relative_to(root).as_posix()] = path
    require(set(actual) == set(members), "Artifact member inventory mismatch")
    for name, expected in members.items():
        require(actual[name].stat().st_size == expected["bytes"], "Artifact member size mismatch")
        require(digest(actual[name]) == expected["sha256"], "Artifact member digest mismatch")
    return actual


def verified_build(lock_path, directory, version):
    lock = load(lock_path)
    require(lock["schema"] == 1 and lock["repository"] == REPOSITORY and
            lock["repository_id"] == REPOSITORY_ID, "Wrong fixed repository")
    require(lock["version"] == version and lock["tag"] == "v" + version, "Wrong beta version")
    require(re.fullmatch(r"[a-f0-9]{40}", lock["build_commit"]), "Invalid source commit")
    require(lock["source_binding"]["commit"] == lock["build_commit"] and
            lock["source_binding"]["all_remote_git_blobs_matched"] is True,
            "Reviewed exact source binding required")
    base = Path(directory)
    installer = verify_directory(base / "installer", lock["artifacts"]["installer"]["members"])
    native = verify_directory(base / "native", lock["artifacts"]["native"]["members"])
    name = "Luheng-Office-Agent-" + version + "-windows-x64.exe"
    require(set(installer) == {name}, "Only the exact original installer is allowed")
    smoke, payload = load(native["native-smoke.json"]), load(native["installed-payload.json"])
    require(smoke["status"] == "native-windows-smoke-passed" and not smoke.get("cleanupError") and
            smoke["version"] == version and smoke["commit"] == lock["build_commit"],
            "Exact passing native CI proof required")
    expected = lock["artifacts"]["installer"]["members"][name]
    require(smoke["installer"] == {"name": name, **expected}, "Native installer binding mismatch")
    require(payload["status"] == "installed-payload-bound", "Installed payload proof required")
    runtime = load(native["runtime.json"])
    require(runtime["status"] == "native-runtime-passed" and runtime["version"] == version,
            "Actual bundled runtime proof required")
    result = {
        "version": version, "tag": "v" + version, "commit": lock["build_commit"],
        "tree": lock["source_binding"]["tree"], "draft": False, "prerelease": True,
        "assetName": name, "bytes": expected["bytes"], "sha256": expected["sha256"],
        "installedExeSha256": payload["files"]["Luheng Office Agent.exe"]["sha256"],
        "installedAsarSha256": payload["files"]["resources/app.asar"]["sha256"],
        "nativeProofPassed": True,
        "proof": {"payloadFile": str(native["installed-payload.json"]),
                  "payloadSha256": digest(native["installed-payload.json"]),
                  "nativeFile": str(native["native-smoke.json"]),
                  "nativeSha256": digest(native["native-smoke.json"])},
    }
    return result, str(installer[name])


def public_api(path):
    url = "https://api.github.com/repos/" + REPOSITORY + path
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json",
                                                  "User-Agent": "Luheng-owned-beta-pair-acceptance"})
    with urllib.request.urlopen(request, timeout=30) as response:
        require(response.status == 200 and response.url == url, "Unexpected GitHub API response")
        raw = response.read(2 * 1024 * 1024 + 1)
    require(len(raw) <= 2 * 1024 * 1024, "Oversized GitHub metadata")
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Invalid JSON number")))


def resolve_release(build):
    tag = public_api("/git/ref/tags/" + build["tag"])
    for _ in range(2):
        if tag["object"]["type"] != "tag":
            break
        tag = public_api("/git/tags/" + tag["object"]["sha"])
    require(tag["object"] == {"sha": build["commit"], "type": "commit",
                             "url": "https://api.github.com/repos/" + REPOSITORY +
                                    "/git/commits/" + build["commit"]}, "Release tag/source mismatch")
    release = public_api("/releases/tags/" + build["tag"])
    require(release["tag_name"] == build["tag"] and release["draft"] is False and
            release["prerelease"] is True, "Exact public preview Release required")
    assets = [item for item in release["assets"] if item["name"] == build["assetName"]]
    require(len(assets) == 1, "Exact single installer asset required")
    asset = assets[0]
    require(asset["size"] == build["bytes"] and asset["digest"] == "sha256:" + build["sha256"] and
            asset["browser_download_url"] == "https://github.com/" + REPOSITORY +
            "/releases/download/" + build["tag"] + "/" + build["assetName"], "Release asset/source mismatch")
    build.update(releaseId=release["id"], assetId=asset["id"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--beta1-lock", required=True)
    parser.add_argument("--beta2-lock", required=True)
    parser.add_argument("--downloads", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    require(os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true" and
            os.environ.get("RUNNER_OS") == "Windows" and
            os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted", "Disposable Windows CI only")
    output = Path(args.output).resolve()
    require(not output.exists(), "Refusing stale pair lock")
    repo = public_api("")
    require(repo["id"] == REPOSITORY_ID and repo["full_name"] == REPOSITORY and
            repo["private"] is False and repo["owner"]["id"] == OWNER_ID and
            repo["owner"]["login"] == "jobKKB", "Wrong live repository identity")
    first, _ = verified_build(args.beta1_lock, Path(args.downloads) / "beta1", "0.6.0-beta.1")
    second, _ = verified_build(args.beta2_lock, Path(args.downloads) / "beta2", "0.6.0-beta.2")
    resolve_release(first)
    resolve_release(second)
    pair = {"schema": 1, "repository": {"id": REPOSITORY_ID, "fullName": REPOSITORY,
            "ownerId": OWNER_ID, "ownerLogin": "jobKKB"}, "from": first, "to": second}
    output.write_text(json.dumps(pair, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "exact-native-beta-pair-prepared", "installerExecuted": False,
                      "upgradePassed": False, "from": first["version"], "to": second["version"],
                      "pairSha256": digest(output)}))


if __name__ == "__main__":
    main()
