"""Exercise publisher guards without contacting GitHub or executing artifacts."""
import copy
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest import mock

publisher = runpy.run_path(str(Path(__file__).with_name("publish-windows-preview.py")))


class PublisherTests(unittest.TestCase):
    def test_lock_and_producer_identity_are_exact(self):
        lock = {"schema": "luheng-preview-release/v1", "repository": publisher["REPOSITORY"],
                "publish": True, "producers": copy.deepcopy(publisher["PRODUCERS"]),
                "recoveries": {side: {"runId": 123, "headSha": "a" * 40, "artifactId": index}
                               for index, side in enumerate(("from", "to"), 1)}}
        publisher["validate_lock"](lock)
        for change in ({"runId": publisher["PRODUCERS"]["from"]["runId"]}, {"headSha": "bad"}, {"artifactId": -1}):
            changed = copy.deepcopy(lock)
            changed["recoveries"]["from"].update(change)
            with self.assertRaises(ValueError):
                publisher["validate_lock"](changed)
        lock["producers"]["to"]["runId"] += 1
        with self.assertRaises(ValueError):
            publisher["validate_lock"](lock)
        pin = publisher["PRODUCERS"]["from"]
        run = {"id": pin["runId"], "head_sha": pin["headSha"], "status": "completed", "conclusion": "success",
               "repository": {"full_name": publisher["REPOSITORY"]}, "path": ".github/workflows/hermes-native-package-experiment.yml"}
        acceptance_pin = {"runId": 123, "headSha": "a" * 40, "artifactId": 1}
        acceptance = {**run, "id": acceptance_pin["runId"], "head_sha": acceptance_pin["headSha"],
                      "path": publisher["RECOVERY"]["WORKFLOW"]}
        steps = [{"name": name, "conclusion": "success"} for name in publisher["RECOVERY"]["REQUIRED"]]
        jobs = {"total_count": 1, "jobs": [{"name": "windows-x64", "run_id": run["id"],
                                          "status": "completed", "conclusion": "success", "steps": steps}]}
        bundle = {"producer": run, "producerJobs": jobs, "acceptance": acceptance}
        publisher["validate_run"](bundle, pin, acceptance_pin)
        for field, value in (("head_sha", "a" * 40), ("conclusion", "failure"), ("status", "in_progress"), ("path", "other.yml")):
            with self.assertRaises(ValueError):
                publisher["validate_run"]({**bundle, "producer": {**run, field: value}}, pin, acceptance_pin)
        failed = copy.deepcopy(bundle)
        failed["producer"]["conclusion"] = failed["producerJobs"]["jobs"][0]["conclusion"] = "failure"
        failed["producerJobs"]["jobs"][0]["steps"] += [{"name": name, "conclusion": "failure"} for name in publisher["RECOVERY"]["FAILURES"]]
        publisher["validate_run"](failed, pin, acceptance_pin)
        for kind, field, value in (("acceptance", "conclusion", "failure"), ("acceptance", "path", "another.yml")):
            changed = copy.deepcopy(failed)
            changed[kind][field] = value
            with self.assertRaises(ValueError):
                publisher["validate_run"](changed, pin, acceptance_pin)
        failed["producerJobs"]["jobs"][0]["steps"][0]["conclusion"] = "failure"
        with self.assertRaises(ValueError):
            publisher["validate_run"](failed, pin, acceptance_pin)

    def test_evidence_basename_must_be_unique(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "receipt.json").write_text("{}", encoding="utf-8")
            self.assertEqual(publisher["unique_file"](root, "receipt.json"), root / "receipt.json")
            (root / "nested").mkdir()
            (root / "nested/receipt.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(ValueError):
                publisher["unique_file"](root, "receipt.json")

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

    def test_canonical_recovery_layout_and_installer_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "installer").mkdir()
            installer = root / "installer/Luheng.exe"
            installer.write_bytes(b"MZ synthetic recovery-layout test")
            canonical = root / "evidence/recovery-evidence"
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
            for name in ("provenance.json", "installer-lifecycle.json"):
                (canonical / "acceptance" / name).write_text("{}", encoding="utf-8")
            (root / "evidence/diagnostics").mkdir()
            (root / "evidence/diagnostics/installer-lifecycle.json").write_text("{}", encoding="utf-8")
            recovery = {"runId": 123, "headSha": "c" * 40, "artifactId": 456}
            bundle = {"producerArtifacts": {}, "acceptanceArtifact": {}}
            qualify = mock.Mock()
            with mock.patch.dict(publisher["QUALIFIER"], {"qualify": qualify}):
                entry, _, _ = publisher["admit"](root, publisher["PRODUCERS"]["from"], bundle, recovery)
                self.assertEqual(qualify.call_args.args[1], canonical)
                self.assertIs(qualify.call_args.args[2], bundle)
                self.assertEqual(entry["evidence"]["recovery"]["files"]["lifecycle"]["path"], "acceptance/installer-lifecycle.json")
                self.assertEqual(entry["sha256"], build["sha256"])
                installer.write_bytes(b"MZ tampered installer")
                with self.assertRaises(ValueError):
                    publisher["admit"](root, publisher["PRODUCERS"]["from"], bundle, recovery)

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
