"""Exercise publisher guards without contacting GitHub or executing artifacts."""
import copy
import json
from pathlib import Path
import runpy
import re
import tempfile
import unittest
from unittest import mock

publisher = runpy.run_path(str(Path(__file__).with_name("publish-windows-preview.py")))


class PublisherTests(unittest.TestCase):
    def test_required_steps_match_current_native_workflow(self):
        workflow = publisher["ROOT"] / publisher["WORKFLOW"]
        names = set(re.findall(r"^\s+- name: (.+)$", workflow.read_text(encoding="utf-8"), re.M))
        self.assertFalse(set(publisher["REQUIRED"]) - names)

    def test_lock_and_producer_identity_are_exact(self):
        pins = self.pins()
        lock = {"schema": "luheng-preview-release/v2", "repository": publisher["REPOSITORY"],
                "publish": True, "producers": pins}
        # Unset release candidates cannot be enabled merely by adding a lock.
        unset = {side: {**pin, "runId": None, "headSha": None} for side, pin in pins.items()}
        with mock.patch.dict(publisher["validate_lock"].__globals__, {"PRODUCERS": unset}):
            with self.assertRaises(ValueError):
                publisher["validate_lock"](lock)
        with mock.patch.dict(publisher["validate_lock"].__globals__, {"PRODUCERS": pins}):
            publisher["validate_lock"](lock)
            for field, value in (("schema", "luheng-preview-release/v1"), ("recoveries", {}), ("publish", False)):
                with self.assertRaises(ValueError):
                    publisher["validate_lock"]({**lock, field: value})
            changed = copy.deepcopy(lock)
            changed["producers"]["to"]["runId"] += 1
            with self.assertRaises(ValueError):
                publisher["validate_lock"](changed)

    @staticmethod
    def pins():
        return {side: {**pin, "runId": number, "headSha": str(number) * 40}
                for number, (side, pin) in enumerate(publisher["PRODUCERS"].items(), 1)}

    def test_only_complete_successful_native_producers_qualify(self):
        pin = self.pins()["from"]
        run = {"id": pin["runId"], "head_sha": pin["headSha"], "status": "completed", "conclusion": "success", "run_attempt": 1,
               "repository": {"full_name": publisher["REPOSITORY"]}, "path": publisher["WORKFLOW"]}
        steps = [{"name": name, "conclusion": "success"} for name in publisher["REQUIRED"]]
        jobs = {"total_count": 1, "jobs": [{"name": "windows-x64", "run_id": run["id"],
                                          "status": "completed", "conclusion": "success", "steps": steps}]}
        bundle = {"producer": run, "producerJobs": jobs}
        publisher["validate_run"](bundle, pin)
        for field, value in (("head_sha", "a" * 40), ("conclusion", "failure"), ("status", "in_progress"), ("path", "other.yml")):
            with self.assertRaises(ValueError):
                publisher["validate_run"]({**bundle, "producer": {**run, field: value}}, pin)
        failed = copy.deepcopy(bundle)
        failed["producer"]["conclusion"] = failed["producerJobs"]["jobs"][0]["conclusion"] = "failure"
        for step in failed["producerJobs"]["jobs"][0]["steps"]:
            if step["name"] in ("Install launch and uninstall using a restricted Windows token", "Require all native acceptance stages before release"):
                step["conclusion"] = "failure"
        with self.assertRaises(ValueError):
            publisher["validate_run"](failed, pin)
        for name in publisher["REQUIRED"]:
            missing = copy.deepcopy(bundle)
            missing["producerJobs"]["jobs"][0]["steps"] = [row for row in steps if row["name"] != name]
            with self.assertRaises(ValueError):
                publisher["validate_run"](missing, pin)

    def test_evidence_basename_must_be_unique(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "receipt.json").write_text("{}", encoding="utf-8")
            self.assertEqual(publisher["unique_file"](root, "receipt.json"), root / "receipt.json")
            (root / "nested").mkdir()
            (root / "nested/receipt.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(ValueError):
                publisher["unique_file"](root, "receipt.json")

    def test_artifacts_belong_to_the_exact_successful_run(self):
        run = {"id": 1, "head_sha": "a" * 40}
        row = {"id": 2, "name": "luheng-windows-installer-unreleased", "expired": False,
               "workflow_run": {"id": 1, "head_sha": "a" * 40}, "size_in_bytes": 123,
               "digest": "sha256:" + "b" * 64}
        publisher["validate_artifacts"]({row["name"]: row}, run)
        for field, value in (("expired", True), ("id", 0), ("size_in_bytes", 0),
                             ("digest", "sha256:bad"), ("name", "different"),
                             ("workflow_run", {"id": 3, "head_sha": "a" * 40}),
                             ("workflow_run", {"id": 1, "head_sha": "c" * 40})):
            with self.assertRaises(ValueError):
                publisher["validate_artifacts"]({row["name"]: {**row, field: value}}, run)

    def test_existing_different_asset_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "Luheng.exe"
            path.write_bytes(b"MZ synthetic publisher test only")
            asset = {"name": path.name, "state": "uploaded", "size": path.stat().st_size,
                     "digest": "sha256:" + publisher["sha"](path)}
            self.assertEqual(publisher["verify_assets"]({"assets": [asset]}, [path]), [])
            for field, value in (("size", 1), ("digest", "sha256:" + "a" * 64), ("name", "Other.exe"), ("state", "starter")):
                with self.assertRaises(ValueError):
                    publisher["verify_assets"]({"assets": [{**asset, field: value}]}, [path])

    def test_draft_tag_lookup_uses_paginated_release_list(self):
        pin = self.pins()["from"]
        draft = {"tag_name": pin["tag"], "draft": True, "prerelease": True,
                 "target_commitish": pin["headSha"], "assets": []}
        gh = mock.Mock(return_value=json.dumps([[], [draft]]))
        with mock.patch.dict(publisher["inspect_release"].__globals__,
                             {"tag_matches": lambda *_: False, "api": lambda *a, **kw: None, "gh": gh}):
            self.assertEqual(publisher["inspect_release"](pin, []), (draft, []))
            gh.assert_called_with("api", f"repos/{publisher['REPOSITORY']}/releases?per_page=100", "--paginate", "--slurp")
            gh.return_value = json.dumps([[draft], [draft]])
            with self.assertRaises(ValueError):
                publisher["inspect_release"](pin, [])
            gh.return_value = json.dumps([[{**draft, "target_commitish": "a" * 40}]])
            with self.assertRaises(ValueError):
                publisher["inspect_release"](pin, [])
            gh.return_value = "[[]]"
            self.assertEqual(publisher["inspect_release"](pin, []), (None, []))

    def test_same_run_evidence_layout_and_installer_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "installer").mkdir()
            installer = root / "installer/Luheng.exe"
            installer.write_bytes(b"MZ synthetic producer-layout test")
            canonical = root / "evidence"
            (canonical / "producer").mkdir(parents=True)
            (canonical / "acceptance").mkdir()
            build = {"installer": r"D:\producer\Luheng.exe", "bytes": installer.stat().st_size,
                     "sha256": publisher["sha"](installer)}
            structure = {"files": [{"path": "LuhengOfficeAgent.exe", "sha256": "a" * 64},
                                   {"path": "resources/app.asar", "sha256": "b" * 64}]}
            for key, name in publisher["EVIDENCE_NAMES"].items():
                value = build if key == "installerReceipt" else structure if key == "structure" else {}
                (canonical / "producer" / name).write_text(json.dumps(value), encoding="utf-8")
            (root / "installer/installer-build.json").write_text(json.dumps(build), encoding="utf-8")
            bundle = {"producer": {"id": 1}}
            qualify = mock.Mock()
            with mock.patch.dict(publisher["QUALIFIER"], {"qualify": qualify}):
                entry, _, _ = publisher["admit"](root, self.pins()["from"], bundle)
                self.assertEqual(qualify.call_args.args[1], canonical)
                self.assertIs(qualify.call_args.args[2], bundle["producer"])
                self.assertEqual(entry["evidence"]["files"]["lifecycle"]["path"], "producer/installer-lifecycle.json")
                self.assertNotIn("recovery", entry["evidence"])
                self.assertEqual(entry["sha256"], build["sha256"])
                installer.write_bytes(b"MZ tampered installer")
                with self.assertRaises(ValueError):
                    publisher["admit"](root, self.pins()["from"], bundle)

    def test_second_release_conflict_prevents_any_mutation(self):
        api = mock.Mock(side_effect=[(None, []), ValueError("Conflicting B release")])
        gh = mock.Mock()
        with mock.patch.dict(publisher["publish"].__globals__, {"inspect_release": api, "gh": gh}):
            with self.assertRaises(ValueError):
                publisher["publish"]([{"pin": {}, "files": []}, {"pin": {}, "files": []}])
        gh.assert_not_called()

    def test_reused_full_evidence_qualification(self):
        publisher["QUALIFIER"]["self_test"]()


if __name__ == "__main__":
    unittest.main(verbosity=2)
