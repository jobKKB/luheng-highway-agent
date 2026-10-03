#!/usr/bin/env python3
"""Publish only the reviewed 0.5.2 bytes. No artifact code is ever executed.

The main-branch workflow and this lock are the trust root, not artifact claims.
Only stdlib is used. No credentials are persisted or passed to redirects.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPO = "jobKKB/luheng-highway-agent"
REPO_ID = 1400818714
VERSION = "0.5.2"
TAG = "v0.5.2"
BUILD_SHA = "31faf64ab44c4830a4599c74945fdc44268a5eff"
RUN_ID = 37132189651
LOCK_SHA256 = "7e6e6f80691bbf9e8fa6ac7df3c429a2227c3d766640735107ded8d34a0e2ad7"
EXE_NAME = "Luheng-Office-Agent-0.5.2-windows-x64.exe"
EXE_BYTES = 244046095
EXE_SHA256 = "45510cbe8f3af129687d8ace267a5184ac64d4d273f63948996d1554a70acfe3"
UI_REPORT = "_temp/luheng-ui-stability-proof/ui-stability-results.json"
API = "https://api.github.com/repos/" + REPO
UA = "luheng-verified-release-publisher/0.5.2"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_lock(path):
    raw = Path(path).read_bytes()
    require(hashlib.sha256(raw).hexdigest() == LOCK_SHA256, "Trusted release lock changed")
    lock = json.loads(raw)
    for key, expected in {"schema": 1, "repository": REPO, "repository_id": REPO_ID,
                          "version": VERSION, "tag": TAG, "build_commit": BUILD_SHA,
                          "build_run_id": RUN_ID}.items():
        require(lock.get(key) == expected, "Unexpected release lock " + key)
    require(set(lock["artifacts"]) == {"installer", "native", "ui"}, "Unexpected artifact scope")
    require(lock["artifacts"]["installer"]["members"] == {
        EXE_NAME: {"bytes": EXE_BYTES, "sha256": EXE_SHA256}}, "Unexpected installer lock")
    return lock


def verify_zip(path, spec, wanted=(), output=None):
    require(Path(path).stat().st_size == spec["zip_bytes"], "ZIP size mismatch")
    require(digest_file(path) == spec["zip_sha256"], "ZIP SHA256 mismatch")
    reports = {}
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        require(len(names) == len(set(names)), "Duplicate ZIP members")
        require(set(names) == set(spec["members"]), "ZIP member whitelist mismatch")
        for i in infos:
            p = PurePosixPath(i.filename)
            require(not p.is_absolute() and all(s not in {"", ".", ".."} for s in p.parts)
                    and "\\" not in i.filename and "\x00" not in i.filename,
                    "Unsafe ZIP member path")
            mode = i.external_attr >> 16
            require(not stat.S_ISLNK(mode) and not i.is_dir() and not (i.flag_bits & 1),
                    "Unsupported ZIP member type")
            member = spec["members"][i.filename]
            require(i.file_size == member["bytes"], "ZIP member size mismatch")
            h, total, chunks = hashlib.sha256(), 0, []
            out = open(output, "xb") if output and i.filename == EXE_NAME else None
            try:
                with z.open(i) as f:
                    for chunk in iter(lambda: f.read(1024 * 1024), b""):
                        total += len(chunk)
                        require(total <= member["bytes"], "ZIP member exceeded size cap")
                        h.update(chunk)
                        if out:
                            out.write(chunk)
                        if i.filename in wanted:
                            require(total <= 2 * 1024 * 1024, "JSON report too large")
                            chunks.append(chunk)
            finally:
                if out:
                    out.close()
            require(total == member["bytes"] and h.hexdigest() == member["sha256"],
                    "ZIP member SHA256 mismatch")
            if i.filename in wanted:
                reports[i.filename] = json.loads(b"".join(chunks))
    require(set(reports) == set(wanted), "Required report missing")
    return reports


def verify_reports(native, ui):
    smoke = native["native-smoke.json"]
    require(smoke.get("status") == "native-windows-smoke-passed" and
            smoke.get("commit") == BUILD_SHA and smoke.get("version") == VERSION and
            smoke.get("runnerOS") == "Windows" and smoke.get("error") is None and
            smoke.get("cleanupError") is None, "Native smoke acceptance failed")
    require(smoke.get("installer") == {"name": EXE_NAME, "bytes": EXE_BYTES,
                                     "sha256": EXE_SHA256}, "Native EXE binding failed")
    stages = smoke.get("stages", {})
    require(stages.get("install") == "passed" and stages.get("bundledRuntime") == "passed"
            and stages.get("desktopWindow", {}).get("plainLaunch") is True
            and stages.get("normalDesktopClose", "").startswith("passed")
            and stages.get("uninstall", "").startswith("passed")
            and "all win-unpacked files size/SHA256 matched" in stages.get("installerPayloadBinding", ""),
            "Native install/runtime/window/uninstall stages failed")
    runtime = native["runtime.json"]
    require(runtime.get("status") == "native-runtime-passed" and
            runtime.get("version") == VERSION and runtime.get("platform") == "win32"
            and runtime.get("arch") == "x64" and runtime.get("health", {}).get("ok") is True,
            "Bundled runtime acceptance failed")
    require(native["installed-payload.json"].get("status") == "installed-payload-bound"
            and native["installed-payload.json"].get("filesChecked", 0) > 0,
            "Installed payload acceptance failed")
    static = native["static-preflight.json"]
    require(static.get("status") == "static-preflight-passed" and
            static.get("version") == VERSION and
            static.get("installer", {}).get("sha256") == EXE_SHA256,
            "Static installer binding failed")
    proof = ui[UI_REPORT]
    require(proof.get("status") == "passed" and proof.get("platform") == "win32" and
            proof.get("commit") == BUILD_SHA and proof.get("expectedVersion") == VERSION and
            proof.get("fakeClock") is False and proof.get("idleElapsedMs", 0) >= 60000 and
            proof.get("errors") == [] and proof.get("cleanupErrors") == [],
            "Real 60-second Windows UI acceptance failed")
    samples = proof.get("idleSamples", [])
    require(len(samples) >= 6 and all(s.get("mutations") == 0 and s.get("rootRemovals") == 0
            and all(s.get(k) is True for k in ("main", "form", "home", "prompt", "roots", "thread",
                                              "value", "selection", "scroll", "focus", "range"))
            for s in samples), "Idle draft/focus/selection/scroll acceptance failed")
    require(proof.get("counters", {}).get("taskPosts") == 1 and
            proof.get("heartbeatsObserved", 0) > 1 and
            proof.get("taskStatusesObserved") == ["queued", "running", "completed"] and
            proof.get("lastFacts", {}).get("range") is True,
            "Live task/output acceptance failed")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api_accept(path, binary):
    # Artifact ZIP endpoints redirect with GitHub's normal API media type.
    # Only the Release asset endpoint negotiates octet-stream content.
    return "application/octet-stream" if binary and path.startswith("/releases/assets/") else "application/vnd.github+json"


def anonymous_url_allowed(url):
    u = urllib.parse.urlsplit(url)
    host = (u.hostname or "").lower()
    return (u.scheme == "https" and u.username is None and u.password is None
            and u.port in (None, 443) and
            (host in {"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
             or host.endswith(".actions.githubusercontent.com")
             or (host.endswith(".blob.core.windows.net") and host.startswith("productionresultssa"))))


class Client:
    def __init__(self, token):
        require(bool(token), "Job token missing")
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def api(self, path, method="GET", payload=None, missing_ok=False, binary=False):
        require((path == "" or path.startswith("/")) and not path.startswith("//"), "Invalid API path")
        url = API + path
        headers = {"Authorization": "Bearer " + self.token, "User-Agent": UA,
                   "Accept": api_accept(path, binary),
                   "X-GitHub-Api-Version": "2022-11-28"}
        data = None if payload is None else json.dumps(payload).encode("utf-8")
        if data is not None:
            headers["Content-Type"] = "application/json"
        try:
            with self.opener.open(urllib.request.Request(url, data=data, headers=headers, method=method),
                                  timeout=90) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
                require(len(raw) <= 4 * 1024 * 1024, "API response too large")
                return raw if binary else json.loads(raw)
        except urllib.error.HTTPError as e:
            if e.code == 404 and missing_ok:
                return None
            if binary and e.code == 302:
                location = e.headers.get("Location", "")
                require(anonymous_url_allowed(location), "Unsafe storage redirect")
                return location
            # Never log request headers, response bodies or signed redirect URLs.
            raise RuntimeError("GitHub API " + method + " " + path.split("?")[0] + " failed with HTTP " + str(e.code)) from None

    def download(self, url, path, size, sha256):
        require(anonymous_url_allowed(url), "Unsafe anonymous download URL")
        for _ in range(5):
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            try:
                response = self.opener.open(req, timeout=120)
                break
            except urllib.error.HTTPError as e:
                if e.code not in (301, 302, 303, 307, 308):
                    raise RuntimeError("Anonymous download failed with HTTP " + str(e.code)) from None
                url = urllib.parse.urljoin(url, e.headers.get("Location", ""))
                require(anonymous_url_allowed(url), "Unsafe anonymous redirect")
        else:
            raise RuntimeError("Too many download redirects")
        h, total = hashlib.sha256(), 0
        with response, open(path, "xb") as f:
            for chunk in iter(lambda: response.read(1024 * 1024), b""):
                total += len(chunk)
                require(total <= size, "Download exceeded size cap")
                h.update(chunk)
                f.write(chunk)
        require(total == size and h.hexdigest() == sha256, "Downloaded bytes failed size/SHA256")

    def artifact(self, spec, path):
        location = self.api("/actions/artifacts/" + str(spec["id"]) + "/zip", binary=True)
        require(isinstance(location, str), "Artifact download did not redirect")
        self.download(location, path, spec["zip_bytes"], spec["zip_sha256"])

    def upload(self, release_id, name, path, content_type):
        require(type(release_id) is int and name in {EXE_NAME, "SHA256SUMS"}, "Unexpected upload target")
        url = "https://uploads.github.com/repos/" + REPO + "/releases/" + str(release_id)
        url += "/assets?name=" + urllib.parse.quote(name, safe="")
        headers = {"Authorization": "Bearer " + self.token, "User-Agent": UA,
                   "Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "Content-Type": content_type, "Content-Length": str(Path(path).stat().st_size)}
        # Bytes are read only after the entire locked ZIP and reports have passed.
        with open(path, "rb") as f:
            req = urllib.request.Request(url, data=f, headers=headers, method="POST")
            try:
                with self.opener.open(req, timeout=300) as response:
                    return json.loads(response.read(1024 * 1024))
            except urllib.error.HTTPError as e:
                raise RuntimeError("Release upload failed with HTTP " + str(e.code)) from None


def verify_run(run, lock):
    for k, v in {"id": RUN_ID, "head_sha": BUILD_SHA, "head_branch": "main", "event": "push",
                 "status": "completed", "conclusion": "success", "run_attempt": 1,
                 "workflow_id": lock["build_workflow_id"], "path": lock["build_workflow_path"]}.items():
        require(run.get(k) == v, "Build run metadata mismatch: " + k)
    require(run.get("repository", {}).get("id") == REPO_ID and
            run.get("head_repository", {}).get("id") == REPO_ID and
            run.get("pull_requests") == [], "Build came from an unexpected repository/PR")


def verify_artifact_metadata(metadata, spec):
    for k, v in {"id": spec["id"], "name": spec["name"], "size_in_bytes": spec["zip_bytes"],
                 "digest": "sha256:" + spec["zip_sha256"], "expired": False}.items():
        require(metadata.get(k) == v, "Artifact metadata mismatch: " + k)
    expected = {"id": RUN_ID, "repository_id": REPO_ID, "head_repository_id": REPO_ID,
                "head_branch": "main", "head_sha": BUILD_SHA}
    require(metadata.get("workflow_run") == expected, "Artifact workflow binding mismatch")


def verify_tag(ref):
    if ref is not None:
        require(ref.get("ref") == "refs/tags/" + TAG and
                ref.get("object", {}).get("type") == "commit" and
                ref.get("object", {}).get("sha") == BUILD_SHA,
                "Existing tag differs from locked build; never overwrite")


def release_assets(release, expected):
    require(release.get("tag_name") == TAG and release.get("prerelease") is True,
            "Existing release metadata differs")
    require(release.get("target_commitish") == BUILD_SHA,
            "Existing release target differs from locked build")
    assets = release.get("assets", [])
    names = [a.get("name") for a in assets]
    require(len(names) == len(set(names)) and set(names).issubset(expected), "Unexpected release asset set")
    for a in assets:
        e = expected[a["name"]]
        require(a.get("state") == "uploaded" and a.get("size") == e["bytes"] and
                a.get("digest") == "sha256:" + e["sha256"],
                "Existing same-name asset differs; never overwrite")
    if not release.get("draft"):
        require(set(names) == set(expected), "Published release is incomplete; refuse to modify")
    return {a["name"]: a for a in assets}


def verify_local(lock, paths, work):
    exe = work / EXE_NAME
    verify_zip(paths["installer"], lock["artifacts"]["installer"], output=exe)
    native = verify_zip(paths["native"], lock["artifacts"]["native"],
                        wanted=tuple(lock["artifacts"]["native"]["members"]))
    ui = verify_zip(paths["ui"], lock["artifacts"]["ui"], wanted=(UI_REPORT,))
    verify_reports(native, ui)
    sums = work / "SHA256SUMS"
    sums.write_bytes((EXE_SHA256 + "  " + EXE_NAME + "\n").encode("ascii"))
    print("Locked installer and all native/UI evidence passed")
    return exe, sums


def publish(lock, client, work):
    repo = client.api("")
    require(repo.get("id") == REPO_ID and repo.get("full_name") == REPO and
            repo.get("private") is False and repo.get("default_branch") == "main",
            "Repository identity/public/default-branch mismatch")
    sha = os.environ.get("GITHUB_SHA", "")
    require(re.fullmatch(r"[0-9a-f]{40}", sha), "Invalid publisher commit")
    main = client.api("/branches/main")
    require(main.get("commit", {}).get("sha") == sha, "Publisher commit is no longer current main")
    compare = client.api("/compare/" + BUILD_SHA + "..." + sha)
    require(compare.get("status") in {"ahead", "identical"} and
            compare.get("merge_base_commit", {}).get("sha") == BUILD_SHA,
            "Build commit is not an ancestor of trusted main")
    # Respect GitHub's workflow-change restriction on target_commitish.
    for f in compare.get("files", []):
        if f.get("filename", "").startswith(".github/workflows/"):
            require(f.get("status") == "added", "Build differs from main in an existing workflow")
    client_run = client.api("/actions/runs/" + str(RUN_ID))
    verify_run(client_run, lock)
    metadata = client.api("/actions/runs/" + str(RUN_ID) + "/artifacts?per_page=100")
    by_id = {a["id"]: a for a in metadata["artifacts"]}
    paths = {}
    for key, spec in lock["artifacts"].items():
        require(spec["id"] in by_id, "Locked artifact missing from successful run")
        verify_artifact_metadata(by_id[spec["id"]], spec)
        paths[key] = work / (key + ".zip")
        client.artifact(spec, paths[key])
    exe, sums = verify_local(lock, paths, work)
    expected = {EXE_NAME: {"bytes": EXE_BYTES, "sha256": EXE_SHA256},
                "SHA256SUMS": {"bytes": sums.stat().st_size, "sha256": digest_file(sums)}}
    ref = client.api("/git/ref/tags/" + TAG, missing_ok=True)
    verify_tag(ref)
    releases = []
    page = 1
    while True:
        batch = client.api("/releases?per_page=100&page=" + str(page))
        releases += [r for r in batch if r.get("tag_name") == TAG]
        if len(batch) < 100:
            break
        page += 1
    require(len(releases) <= 1, "Duplicate release tags")
    release = releases[0] if releases else None
    if release is not None:
        require(ref is not None or release.get("draft") is True, "Published release tag missing")
        existing = release_assets(release, expected)
    else:
        # First mutation occurs only after every artifact byte and report passes.
        release = client.api("/releases", "POST", {
            "tag_name": TAG, "target_commitish": BUILD_SHA, "name": lock["release_name"],
            "body": lock["release_notes"], "draft": True, "prerelease": True,
            "make_latest": "false", "generate_release_notes": False})
        existing = release_assets(release, expected)
    for name, path, content_type in [(EXE_NAME, exe, "application/vnd.microsoft.portable-executable"),
                                     ("SHA256SUMS", sums, "text/plain")]:
        if name not in existing:
            client.upload(release["id"], name, path, content_type)
    release = client.api("/releases/" + str(release["id"]))
    existing = release_assets(release, expected)
    require(set(existing) == set(expected), "Missing reviewed assets")
    for name, a in existing.items():
        # Draft assets require authenticated API lookup; token never follows redirect.
        location = client.api("/releases/assets/" + str(a["id"]), binary=True)
        e = expected[name]
        destination = work / ("remote-" + name)
        if isinstance(location, bytes):
            require(len(location) == e["bytes"] and hashlib.sha256(location).hexdigest() == e["sha256"],
                    "Small asset verification failed")
            destination.write_bytes(location)
        else:
            client.download(location, destination, e["bytes"], e["sha256"])
    if release.get("draft"):
        # Recheck lock target before the single publication transition.
        verify_tag(client.api("/git/ref/tags/" + TAG, missing_ok=True))
        release = client.api("/releases/" + str(release["id"]), "PATCH",
                             {"draft": False, "prerelease": True, "make_latest": "false"})
    require(release.get("draft") is False and release.get("prerelease") is True, "Release is not public prerelease")
    ref = client.api("/git/ref/tags/" + TAG)
    verify_tag(ref)
    # Final anonymous full downloads prove that no GitHub login is needed.
    for name, e in expected.items():
        url = "https://github.com/" + REPO + "/releases/download/" + TAG + "/" + name
        client.download(url, work / ("public-" + name), e["bytes"], e["sha256"])
    print("PUBLIC_PRERELEASE_VERIFIED https://github.com/" + REPO + "/releases/tag/" + TAG)
    print("TAG_TARGET " + BUILD_SHA)
    print("ANONYMOUS_EXE_SIZE " + str(EXE_BYTES))
    print("ANONYMOUS_EXE_SHA256 " + EXE_SHA256)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lock", default=str(Path(__file__).with_name("release-lock.json")))
    parser.add_argument("--verify-local", nargs=3, metavar=("INSTALLER_ZIP", "NATIVE_ZIP", "UI_ZIP"))
    args = parser.parse_args()
    lock = read_lock(args.lock)
    with tempfile.TemporaryDirectory(prefix="luheng-reviewed-release-") as temp:
        work = Path(temp)
        if args.verify_local:
            verify_local(lock, dict(zip(("installer", "native", "ui"), args.verify_local)), work)
            return
        require(os.environ.get("GITHUB_REPOSITORY") == REPO and
                os.environ.get("GITHUB_REPOSITORY_ID") == str(REPO_ID) and
                os.environ.get("GITHUB_REF") == "refs/heads/main" and
                os.environ.get("GITHUB_EVENT_NAME") in {"push", "workflow_dispatch"},
                "Only trusted main push/manual runs may publish")
        publish(lock, Client(os.environ.get("GH_TOKEN", "")), work)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Release stopped: " + str(e), file=sys.stderr)
        sys.exit(1)
