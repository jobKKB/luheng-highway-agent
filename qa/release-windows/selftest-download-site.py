"""Check release rendering and reject incomplete or mismatched native receipts."""
import copy
import json
from pathlib import Path
import runpy
import tempfile
import unittest

site = runpy.run_path(str(Path(__file__).with_name("generate-download-site.py")))


class DownloadSiteTests(unittest.TestCase):
    def test_metadata_and_acceptance_are_bound_to_installer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            installer = root / "Luheng-0.7.2-x64.exe"
            installer.write_bytes(b"MZ synthetic generator test only")
            feed, sums = site["create_feed"](installer, "0.7.2", "v0.7.2-beta.1")
            entry = feed["files"][0]
            report = {key: True for key in site["LIFECYCLE_STAGES"]}
            report.update(schema=1, coverage="restricted-token-same-user", architecture="X64", forced_cleanup=False,
                          error=None, immutable_payload_rebuilt=False, installer_sha256=entry["sha256"], health_version="0.7.2")
            lifecycle = root / "lifecycle.json"
            lifecycle.write_text(json.dumps(report), encoding="utf-8")
            output = root / "site"
            metadata = site["generate"](installer, "0.7.2", "v0.7.2-beta.1", lifecycle, output)
            self.assertFalse(metadata["onlineUpdateVerified"])
            self.assertEqual(metadata["sizeBytes"], installer.stat().st_size)
            self.assertEqual(metadata["sha256"], site["digest"](installer))
            self.assertEqual(json.loads((output / "updates/windows/latest.yml").read_text()), feed)
            self.assertEqual((output / "SHA256SUMS.txt").read_text(), sums)
            html = (output / "index.html").read_text(encoding="utf-8")
            for old in ("0.5.1", "ca6b08b01335de50", "244,044,118", "cloudflareinsights", "__LUHENG_"):
                self.assertNotIn(old, html)
            self.assertIn(entry["url"], html)
            self.assertIn(entry["sha256"], html)
            self.assertIn('href="https://github.com/jobKKB/luheng-highway-agent/tree/v0.7.2-beta.1"', html)
            self.assertNotIn('href="https://github.com/jobKKB/luheng-highway-agent"', html)
            self.assertIn("has not been accepted", html)
            self.assertIn("Cache-Control: no-store", (output / "_headers").read_text())
            with self.assertRaises(ValueError):
                site["generate"](installer, "0.7.2", "v0.7.2-beta.1", lifecycle, output)
            for key in site["LIFECYCLE_STAGES"]:
                changed = {**report, key: False}
                with self.assertRaises(ValueError):
                    site["validate_lifecycle"](changed, entry, "0.7.2")
            with self.assertRaises(ValueError):
                site["validate_lifecycle"]({**report, "installer_sha256": "a" * 64}, entry, "0.7.2")
            pair = {"schema": "luheng-online-update/v1", "repository": "jobKKB/luheng-highway-agent",
                    "from": {"version": "0.7.0", "bytes": 5, "sha256": "a" * 64, "exeSha256": "b" * 64, "asarSha256": "c" * 64},
                    "to": {"version": "0.7.2", "bytes": entry["size"], "sha256": entry["sha256"],
                           "url": entry["url"], "exeSha256": "d" * 64, "asarSha256": "e" * 64}}
            upgrade = {key: True for key in site["UPGRADE_STAGES"]}
            upgrade.update(schema=1, status="online-update-verified", forcedCleanup=False, error=None, pair=pair)
            upgrade_path = root / "upgrade.json"
            upgrade_path.write_text(json.dumps(upgrade), encoding="utf-8")
            verified = site["generate"](installer, "0.7.2", "v0.7.2-beta.1", lifecycle, root / "verified", upgrade_path)
            self.assertTrue(verified["onlineUpdateVerified"])
            self.assertFalse(verified["legacyPrototypeMigrationVerified"])
            self.assertEqual(verified["version"], "0.7.2")
            stale = copy.deepcopy(upgrade)
            stale["pair"]["to"]["version"] = "0.7.1"
            with self.assertRaises(ValueError):
                site["validate_upgrade"](stale, entry, "0.7.2")
            self.assertIn("confirmed download", (root / "verified/index.html").read_text(encoding="utf-8"))
            for key in site["UPGRADE_STAGES"]:
                with self.assertRaises(ValueError):
                    site["validate_upgrade"]({**upgrade, key: False}, entry, "0.7.2")
            for key, value in (("sha256", "f" * 64), ("bytes", entry["size"] + 1), ("url", "https://example.com/other.exe")):
                changed = copy.deepcopy(upgrade)
                changed["pair"]["to"][key] = value
                with self.assertRaises(ValueError):
                    site["validate_upgrade"](changed, entry, "0.7.2")


if __name__ == "__main__":
    unittest.main(verbosity=2)
