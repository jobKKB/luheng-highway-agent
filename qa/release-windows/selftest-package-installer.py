"""Exercise packaging admission without dependencies, builds, or installation."""
import argparse
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("package_installer", Path(__file__).with_name("package-installer.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        source = root / "source"
        (source / "apps/desktop/release/win-unpacked").mkdir(parents=True)
        self.args = argparse.Namespace(source=source, output=root / "installer", run_id="123")
        for name, value in {
            "prepared": {"schema": 1, "request": {"source": str(source), "target": "win32-x64",
                         "variant": "bundled", "commit": "a" * 40, "version": "0.7.0"}},
            "structure": {"source_commit": "a" * 40, "base_version": "0.7.0"},
            "health": {},
        }.items():
            path = root / (name + ".json")
            path.write_text(json.dumps(value), encoding="utf-8")
            setattr(self.args, name, path)
        self.args.archive = root / "portable.7z"
        self.args.archive.write_bytes(b"7z\xbc\xaf\x27\x1c" + b"fixture")

    def test_valid_paths(self):
        source, output, _ = module.validate_inputs(self.args)
        self.assertEqual(source, self.args.source.resolve())
        self.assertEqual(output, self.args.output.resolve())

    def test_reject_output_inside_source(self):
        self.args.output = self.args.source / "installer"
        with self.assertRaisesRegex(ValueError, "separate"):
            module.validate_inputs(self.args)

    def test_reject_stale_output(self):
        self.args.output.mkdir()
        with self.assertRaisesRegex(ValueError, "fresh"):
            module.validate_inputs(self.args)

    def test_reject_foreign_manifest(self):
        self.args.structure.write_text(json.dumps({"source_commit": "b" * 40, "base_version": "0.7.0"}))
        with self.assertRaisesRegex(ValueError, "identity differ"):
            module.validate_inputs(self.args)

    def test_reject_fake_archive(self):
        self.args.archive.write_bytes(b"this is not an archive")
        with self.assertRaisesRegex(ValueError, "not a 7z"):
            module.validate_inputs(self.args)

    def test_reject_placeholder_run(self):
        self.args.run_id = "FILL_RUN_ID"
        with self.assertRaisesRegex(ValueError, "actual positive"):
            module.validate_inputs(self.args)


if __name__ == "__main__":
    unittest.main()
