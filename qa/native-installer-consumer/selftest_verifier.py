"""Synthetic stdlib verifier checks. These are not native Windows receipts."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
from verify_consumer import contract, safe_name, verify_archive_listing, verify_tree, verify_downloads


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-consumer-synthetic-")
        self.root = Path(self.temp.name) / "payload"
        self.root.mkdir()
        (self.root / "resources").mkdir()
        data = {"LuhengOfficeAgent.exe": b"synthetic payload", "resources/app.asar": b"synthetic asar"}
        for name, value in data.items():
            (self.root / name).write_bytes(value)
        self.manifest = {"source_commit": "1" * 40, "source_tree_sha256": "2" * 64,
                         "files": [{"path": name, "bytes": len(value), "sha256": hashlib.sha256(value).hexdigest()}
                                   for name, value in data.items()]}

    def tearDown(self):
        self.temp.cleanup()

    def test_every_file_and_exact_membership(self):
        self.assertTrue(verify_tree(self.root, self.manifest)["exact_membership"])
        (self.root / "unexpected").write_bytes(b"extra")
        with self.assertRaises(ValueError):
            verify_tree(self.root, self.manifest)

    def test_changed_same_length_is_rejected(self):
        (self.root / "resources/app.asar").write_bytes(b"X" * len(b"synthetic asar"))
        with self.assertRaises(ValueError):
            verify_tree(self.root, self.manifest)

    def test_duplicate_and_case_alias_rows_are_rejected(self):
        for name in ("resources/app.asar", "RESOURCES/APP.ASAR"):
            manifest = copy.deepcopy(self.manifest)
            row = copy.deepcopy(manifest["files"][-1])
            row["path"] = name
            manifest["files"].append(row)
            with self.assertRaises(ValueError):
                verify_tree(self.root, manifest)

    def test_generated_uninstaller_is_separate(self):
        (self.root / "Uninstall Synthetic.exe").write_bytes(b"MZsynthetic")
        (self.root / "resources/package-type").write_bytes(b"nsis")
        result = verify_tree(self.root, self.manifest, "Uninstall Synthetic.exe")
        self.assertEqual(result["payload_files"], 2)
        self.assertEqual(len(result["generated_installer_files"]), 2)
        self.assertEqual(result["generated_installer_files"][1], {
            "path": "resources/package-type", "bytes": 4, "sha256": hashlib.sha256(b"nsis").hexdigest()})
        self.assertFalse(result["rebuilt"])

    def test_nsis_marker_is_required_and_exact(self):
        uninstaller = "Uninstall Synthetic.exe"
        (self.root / uninstaller).write_bytes(b"MZsynthetic")
        with self.assertRaisesRegex(ValueError, "membership"):
            verify_tree(self.root, self.manifest, uninstaller)
        marker = self.root / "resources/package-type"
        for value in (b"NSIS", b"evil", b"nsis\n", b"nsis-web", b"\xef\xbb\xbfnsis"):
            marker.write_bytes(value)
            with self.assertRaisesRegex(ValueError, "Pinned file differs"):
                verify_tree(self.root, self.manifest, uninstaller)
        marker.write_bytes(b"nsis")
        with self.assertRaisesRegex(ValueError, "membership"):
            verify_tree(self.root, self.manifest)
        (self.root / "resources/another-marker").write_bytes(b"nsis")
        with self.assertRaisesRegex(ValueError, "membership"):
            verify_tree(self.root, self.manifest, uninstaller)

    def test_nsis_marker_links_and_payload_shadowing_are_rejected(self):
        uninstaller = "Uninstall Synthetic.exe"
        (self.root / uninstaller).write_bytes(b"MZsynthetic")
        target = Path(self.temp.name) / "external-marker"
        target.write_bytes(b"nsis")
        marker = self.root / "resources/package-type"
        marker.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "link/junction"):
            verify_tree(self.root, self.manifest, uninstaller)
        marker.unlink()
        marker.write_bytes(b"nsis")
        manifest = copy.deepcopy(self.manifest)
        manifest["files"].append({"path": "resources/package-type", "bytes": 4,
                                  "sha256": hashlib.sha256(b"nsis").hexdigest()})
        with self.assertRaisesRegex(ValueError, "cannot replace"):
            verify_tree(self.root, manifest, uninstaller)

    def test_links_are_rejected(self):
        (self.root / "linked").symlink_to(self.root / "resources/app.asar")
        with self.assertRaises(ValueError):
            verify_tree(self.root, self.manifest)

    def test_unsafe_windows_names(self):
        for name in ("../escape", "/absolute", "a\\b", "a:b", "a/NUL.txt", "a/file.", "a/file ", "a//b", "a/./b"):
            with self.assertRaises(ValueError, msg=name):
                safe_name(name)

    def test_archive_paths_before_extraction(self):
        records = ["Path = Luheng-Windows-x64\nSize = 0\nAttributes = D\n"]
        for row in self.manifest["files"]:
            records.append("Path = Luheng-Windows-x64/" + row["path"] + "\nSize = " + str(row["bytes"]) + "\nAttributes = A\nEncrypted = -\n")
        listing = Path(self.temp.name) / "listing.txt"
        listing.write_text("\n".join(records))
        self.assertTrue(verify_archive_listing(listing, self.manifest)["archive_paths_admitted_before_extraction"])
        listing.write_text(listing.read_text().replace("Luheng-Windows-x64/resources/app.asar", "../escape"))
        with self.assertRaises(ValueError):
            verify_archive_listing(listing, self.manifest)

    def filled_synthetic_contract(self):
        # Synthetic unit-test values only. These never qualify a real producer.
        value = json.loads(Path(__file__).with_name("contract.template.json").read_text())
        value["qualified"] = True
        value["build"]["runId"] = 1
        value["build"]["head"] = "1" * 40
        value["source"]["commit"] = "1" * 40
        value["source"]["treeSha256"] = "d37c08c19b1e57ce4829682c4f84ec5fc89bf1fd3c5fc56e0e2b7153f462b4cb"
        value["minimumScratchBytes"] = 20 * 1024**3
        for number, key in enumerate(("portableArtifact", "evidenceArtifact"), 1):
            value[key].update(id=number, bytes=1, digest="sha256:" + "2" * 64)
        for row in [value["archive"], *value["evidenceFiles"].values()]:
            row.update(bytes=1, sha256="3" * 64)
        return value

    def test_corrected_source_contract_rejects_superseded_pin(self):
        value = self.filled_synthetic_contract()
        path = Path(self.temp.name) / "synthetic-contract.json"
        path.write_text(json.dumps(value))
        self.assertEqual(contract(path)["source"]["treeSha256"], value["source"]["treeSha256"])
        value["source"]["treeSha256"] = "d6970eb089f02208462f9fc37af92a3037c4898aa194d38df7abf51216f785af"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "source identity"):
            contract(path)

    def test_downloads_bind_corrected_source_and_pinned_bytes(self):
        value = self.filled_synthetic_contract()
        portable = Path(self.temp.name) / "portable"
        evidence = Path(self.temp.name) / "evidence"
        portable.mkdir(); evidence.mkdir()
        archive = portable / value["archive"]["path"]
        archive.write_bytes(b"synthetic archive only")
        value["archive"].update(bytes=archive.stat().st_size, sha256=hashlib.sha256(archive.read_bytes()).hexdigest())
        (portable / "SHA256SUMS").write_text(value["archive"]["sha256"] + "  " + archive.name + "\n")
        source = value["source"]
        identity = {"source_commit": source["commit"], "source_tree_sha256": source["treeSha256"], "source_count": source["count"]}
        structure = {**self.manifest, **identity, "schema": 2, "target": "win32-x64",
                     "artifact_kind": "official-prepared-unpacked-Windows-x64-build-only",
                     "desktop_and_embedded_cli_stamp_match": True, "production_update_enabled": False,
                     "base_version": source["baseVersion"]}
        health = {"native_windows": True, "architecture": "X64", "plain_launch": True,
                  "contained_backend_health": True, "normal_window_close": True, "forced_cleanup": False,
                  "error": None, "health_version": source["baseVersion"], "build_run_id": 1}
        receipt = {**identity, "archive": archive.name, "sha256": value["archive"]["sha256"],
                   "bytes": value["archive"]["bytes"], "compression_before_any_launch": True,
                   "seven_zip_roundtrip_every_file_sha256_verified": True, "all_hidden_files_included": True}
        documents = {"sourceAdmission": identity, "structure": structure, "health": health,
                     "portableReceipt": receipt, "nativeRegressionLog": "synthetic test only"}
        for key, document in documents.items():
            row = value["evidenceFiles"][key]
            path = evidence / row["path"]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(document))
            row.update(bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        contract_path = Path(self.temp.name) / "synthetic-contract.json"
        contract_path.write_text(json.dumps(value))
        pins = contract(contract_path)
        self.assertTrue(verify_downloads(pins, portable, evidence)["download_admission_passed"])
        # Even freshly re-pinned evidence cannot replace the reviewed source identity.
        structure["source_tree_sha256"] = "4" * 64
        row = pins["evidenceFiles"]["structure"]
        path = evidence / row["path"]
        path.write_text(json.dumps(structure))
        with self.assertRaisesRegex(ValueError, "Pinned file differs"):
            verify_downloads(pins, portable, evidence)
        row.update(bytes=path.stat().st_size, sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        with self.assertRaisesRegex(ValueError, "source identity differs"):
            verify_downloads(pins, portable, evidence)

    def test_unfilled_contract_cannot_run(self):
        with self.assertRaises(ValueError):
            contract(Path(__file__).with_name("contract.template.json"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
