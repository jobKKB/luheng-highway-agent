"""Offline fail-closed tests. No API calls, credentials or artifact execution."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import warnings
import zipfile

spec = importlib.util.spec_from_file_location("publisher", Path(__file__).with_name("publish_verified_release.py"))
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.lock = p.read_lock(Path(__file__).with_name("release-lock.json"))

    def rejects(self, call):
        with self.assertRaises(RuntimeError):
            call()

    def archive(self, directory, entries):
        path = Path(directory) / "fixture.zip"
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with zipfile.ZipFile(path, "w") as z:
                for name, value in entries:
                    z.writestr(name, value)
        members = {name: {"bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
                   for name, value in entries}
        return path, {"zip_bytes": path.stat().st_size, "zip_sha256": p.digest_file(path), "members": members}

    def test_lock_is_fixed_to_reviewed_release(self):
        self.assertEqual(self.lock["tag"], "v0.5.2")
        self.assertEqual(self.lock["build_commit"], p.BUILD_SHA)
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "lock.json"
            path.write_text(json.dumps({**self.lock, "tag": "v0.6.0"}))
            self.rejects(lambda: p.read_lock(path))

    def test_safe_zip_and_every_member_digest(self):
        with tempfile.TemporaryDirectory() as t:
            path, lock = self.archive(t, [("report.json", b'{"ok":true}')])
            self.assertEqual(p.verify_zip(path, lock, wanted=("report.json",)), {"report.json": {"ok": True}})
            lock["members"]["report.json"]["sha256"] = "0" * 64
            self.rejects(lambda: p.verify_zip(path, lock))

    def test_zip_size_and_digest_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            path, lock = self.archive(t, [("a", b"ok")])
            wrong = copy.deepcopy(lock)
            wrong["zip_bytes"] += 1
            self.rejects(lambda: p.verify_zip(path, wrong))
            wrong = copy.deepcopy(lock)
            wrong["zip_sha256"] = "f" * 64
            self.rejects(lambda: p.verify_zip(path, wrong))

    def test_duplicate_and_unexpected_members_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            path, lock = self.archive(t, [("a", b"ok"), ("a", b"ok")])
            self.rejects(lambda: p.verify_zip(path, lock))
            path, lock = self.archive(t, [("a", b"ok"), ("evil.py", b"raise Exception()")])
            del lock["members"]["evil.py"]
            self.rejects(lambda: p.verify_zip(path, lock))

    def test_traversal_absolute_and_backslash_rejected(self):
        for name in ("../evil", "/tmp/evil", "a/../../evil", "a\\evil"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as t:
                path, lock = self.archive(t, [(name, b"ok")])
                self.rejects(lambda: p.verify_zip(path, lock))

    def test_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            path = Path(t) / "fixture.zip"
            i = zipfile.ZipInfo("evil")
            i.create_system = 3
            i.external_attr = (0o120777 << 16)
            with zipfile.ZipFile(path, "w") as z:
                z.writestr(i, b"target")
            lock = {"zip_bytes": path.stat().st_size, "zip_sha256": p.digest_file(path),
                    "members": {"evil": {"bytes": 6, "sha256": hashlib.sha256(b"target").hexdigest()}}}
            self.rejects(lambda: p.verify_zip(path, lock))

    def test_member_size_rejected(self):
        with tempfile.TemporaryDirectory() as t:
            path, lock = self.archive(t, [("a", b"ok")])
            lock["members"]["a"]["bytes"] += 1
            self.rejects(lambda: p.verify_zip(path, lock))

    def valid_run(self):
        return {"id": p.RUN_ID, "head_sha": p.BUILD_SHA, "head_branch": "main", "event": "push",
                "status": "completed", "conclusion": "success", "run_attempt": 1,
                "workflow_id": self.lock["build_workflow_id"], "path": self.lock["build_workflow_path"],
                "repository": {"id": p.REPO_ID}, "head_repository": {"id": p.REPO_ID}, "pull_requests": []}

    def test_only_successful_exact_main_build_accepted(self):
        run = self.valid_run()
        p.verify_run(run, self.lock)
        for k, v in (("head_sha", "0" * 40), ("head_branch", "feature"), ("event", "pull_request"),
                     ("conclusion", "failure"), ("status", "in_progress"), ("run_attempt", 2),
                     ("pull_requests", [{"number": 1}]), ("head_repository", {"id": 0})):
            self.rejects(lambda k=k, v=v: p.verify_run({**run, k: v}, self.lock))

    def test_artifact_id_digest_expiry_and_build_binding(self):
        s = self.lock["artifacts"]["installer"]
        metadata = {"id": s["id"], "name": s["name"], "size_in_bytes": s["zip_bytes"],
                    "digest": "sha256:" + s["zip_sha256"], "expired": False,
                    "workflow_run": {"id": p.RUN_ID, "repository_id": p.REPO_ID,
                    "head_repository_id": p.REPO_ID, "head_branch": "main", "head_sha": p.BUILD_SHA}}
        p.verify_artifact_metadata(metadata, s)
        for k, v in (("id", 0), ("name", "wrong"), ("digest", "sha256:" + "0" * 64),
                     ("expired", True), ("workflow_run", {"id": 0})):
            self.rejects(lambda k=k, v=v: p.verify_artifact_metadata({**metadata, k: v}, s))

    def test_existing_tag_cannot_be_retargeted(self):
        p.verify_tag(None)
        ref = {"ref": "refs/tags/" + p.TAG, "object": {"type": "commit", "sha": p.BUILD_SHA}}
        p.verify_tag(ref)
        self.rejects(lambda: p.verify_tag({**ref, "object": {"type": "commit", "sha": "0" * 40}}))
        self.rejects(lambda: p.verify_tag({**ref, "object": {"type": "tag", "sha": p.BUILD_SHA}}))

    def test_existing_assets_are_idempotent_and_never_overwritten(self):
        expected = {"SHA256SUMS": {"bytes": 100, "sha256": "a" * 64}}
        asset = {"name": "SHA256SUMS", "size": 100, "digest": "sha256:" + "a" * 64, "state": "uploaded"}
        release = {"tag_name": p.TAG, "prerelease": True, "target_commitish": p.BUILD_SHA,
                   "draft": False, "assets": [asset]}
        self.assertEqual(p.release_assets(release, expected), {"SHA256SUMS": asset})
        self.rejects(lambda: p.release_assets({**release, "assets": [{**asset, "digest": "sha256:" + "b" * 64}]}, expected))
        self.rejects(lambda: p.release_assets({**release, "assets": []}, expected))
        self.rejects(lambda: p.release_assets({**release, "assets": [asset, asset]}, expected))
        self.rejects(lambda: p.release_assets({**release, "target_commitish": "main"}, expected))
        self.rejects(lambda: p.release_assets({**release, "prerelease": False}, expected))

    def test_redirects_are_https_allowlisted_without_auth(self):
        for url in ("https://github.com/x", "https://release-assets.githubusercontent.com/x",
                    "https://productionresultssa0.blob.core.windows.net/x"):
            self.assertTrue(p.anonymous_url_allowed(url))
        for url in ("http://github.com/x", "https://github.com.evil.test/x", "https://evil.test/x",
                    "https://token@github.com/x", "https://github.com:8080/x", "file:///tmp/x"):
            self.assertFalse(p.anonymous_url_allowed(url))
        self.assertIsNone(p.NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.test"))

    def valid_reports(self):
        native = {"native-smoke.json": {"status": "native-windows-smoke-passed", "commit": p.BUILD_SHA,
            "version": p.VERSION, "runnerOS": "Windows", "error": None, "cleanupError": None,
            "installer": {"name": p.EXE_NAME, "bytes": p.EXE_BYTES, "sha256": p.EXE_SHA256},
            "stages": {"install": "passed", "bundledRuntime": "passed", "desktopWindow": {"plainLaunch": True},
            "normalDesktopClose": "passed", "uninstall": "passed",
            "installerPayloadBinding": "all win-unpacked files size/SHA256 matched"}},
            "runtime.json": {"status": "native-runtime-passed", "version": p.VERSION, "platform": "win32",
                "arch": "x64", "health": {"ok": True}},
            "installed-payload.json": {"status": "installed-payload-bound", "filesChecked": 1},
            "static-preflight.json": {"status": "static-preflight-passed", "version": p.VERSION,
                "installer": {"sha256": p.EXE_SHA256}}}
        sample = dict.fromkeys(("main", "form", "home", "prompt", "roots", "thread", "value", "selection",
                               "scroll", "focus", "range"), True)
        sample.update({"mutations": 0, "rootRemovals": 0})
        ui = {p.UI_REPORT: {"status": "passed", "platform": "win32", "commit": p.BUILD_SHA,
            "expectedVersion": p.VERSION, "fakeClock": False, "idleElapsedMs": 60000,
            "errors": [], "cleanupErrors": [], "idleSamples": [sample] * 6, "counters": {"taskPosts": 1},
            "heartbeatsObserved": 43, "taskStatusesObserved": ["queued", "running", "completed"],
            "lastFacts": {"range": True}}}
        return native, ui

    def test_acceptance_requires_real_idle_clean_native_and_exe_binding(self):
        native, ui = self.valid_reports()
        p.verify_reports(native, ui)
        for key, value in (("fakeClock", True), ("idleElapsedMs", 59999), ("errors", ["error"]),
                           ("commit", "0" * 40), ("cleanupErrors", ["error"])):
            wrong = copy.deepcopy(ui)
            wrong[p.UI_REPORT][key] = value
            self.rejects(lambda wrong=wrong: p.verify_reports(native, wrong))
        wrong = copy.deepcopy(ui)
        wrong[p.UI_REPORT]["idleSamples"][0]["mutations"] = 1
        self.rejects(lambda: p.verify_reports(native, wrong))
        wrong = copy.deepcopy(native)
        wrong["native-smoke.json"]["installer"]["sha256"] = "0" * 64
        self.rejects(lambda: p.verify_reports(wrong, ui))
        wrong = copy.deepcopy(native)
        wrong["native-smoke.json"]["error"] = "failed"
        self.rejects(lambda: p.verify_reports(wrong, ui))


if __name__ == "__main__":
    unittest.main()
