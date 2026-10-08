"""Synthetic fail-closed replay regressions; no native installation claims."""
import argparse
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_replay as replay

parser = argparse.ArgumentParser()
parser.add_argument("--consumer", type=Path, required=True)
args = parser.parse_args()
V = replay.load_consumer(args.consumer)
P, S = replay.read_contract(V, Path(__file__).with_name("replay-contract.json"), args.consumer / "contract.json")
NOW = datetime(2026, 10, 8, tzinfo=timezone.utc)


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value) + "\n", encoding="utf-8")


def fixtures(root):
    def run(pin, conclusion):
        return {"id": pin["runId"], "head_sha": pin["head"], "run_attempt": pin["runAttempt"],
                "path": pin["workflowPath"], "status": "completed", "conclusion": conclusion,
                "head_repository": {"full_name": P["repository"]}}
    write(root / "builder-run-api.json", run(P["builder"], "failure"))
    write(root / "source-run-api.json", run(S["build"], "success"))
    b = P["builder"]
    steps = [dict(p, status="completed", conclusion="success") for p in b["requiredSuccessfulSteps"]]
    steps.append(dict(b["failedLifecycleStep"], status="completed", conclusion="failure"))
    write(root / "builder-jobs-api.json", {"total_count": 1, "jobs": [{"id": b["jobId"], "name": b["jobName"],
        "run_id": b["runId"], "run_attempt": b["runAttempt"], "head_sha": b["head"], "status": "completed",
        "conclusion": "failure", "steps": steps}]})
    for name, pin, run in (("candidate", P["candidateArtifact"], b), ("builder-evidence", P["builderEvidenceArtifact"], b),
                           ("source-evidence", S["evidenceArtifact"], S["build"])):
        write(root / (name + "-artifact-api.json"), {"id": pin["id"], "name": pin["name"],
            "size_in_bytes": pin["bytes"], "digest": pin["digest"], "expired": False, "expires_at": "2026-10-22T00:00:00Z",
            "workflow_run": {"id": run["runId"], "head_sha": run["head"]}})


class ReplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        fixtures(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def api(self):
        return replay.verify_api(V, P, S, self.root, NOW)

    def change(self, file, transform):
        p = self.root / file
        value = V.read_json(p)
        transform(value)
        write(p, value)

    def test_failed_builder_admitted_only_for_successful_wrapping(self):
        result = self.api()
        self.assertTrue(result["wrapping_and_candidate_retention_passed"])
        self.assertFalse(result["builder_overall_qualified"])
        self.assertFalse(result["previous_lifecycle_accepted"])

    def test_changed_run_and_attempt_rejected(self):
        for field, value in (("head_sha", "0" * 40), ("run_attempt", 2), ("status", "in_progress"),
                             ("conclusion", "success"), ("path", "different.yml")):
            with self.subTest(field=field):
                fixtures(self.root)
                self.change("builder-run-api.json", lambda x: x.update({field: value}))
                with self.assertRaises(ValueError): self.api()

    def test_unqualified_source_rejected(self):
        self.change("source-run-api.json", lambda x: x.update(conclusion="failure"))
        with self.assertRaises(ValueError): self.api()

    def test_wrapping_or_retention_failure_rejected(self):
        for number in (13, 14):
            fixtures(self.root)
            self.change("builder-jobs-api.json", lambda x: next(s for s in x["jobs"][0]["steps"]
                if s["number"] == number).update(conclusion="failure"))
            with self.assertRaises(ValueError): self.api()

    def test_incomplete_or_wrong_job_rejected(self):
        self.change("builder-jobs-api.json", lambda x: x.update(total_count=2))
        with self.assertRaises(ValueError): self.api()
        fixtures(self.root)
        self.change("builder-jobs-api.json", lambda x: x["jobs"][0].update(id=1))
        with self.assertRaises(ValueError): self.api()

    def test_each_artifact_digest_and_size_and_expiry_rejected(self):
        for kind in ("candidate", "builder-evidence", "source-evidence"):
            for field, value in (("digest", "sha256:" + "0" * 64), ("size_in_bytes", 1),
                                 ("expired", True), ("expires_at", "2026-10-07T00:00:00Z")):
                with self.subTest(kind=kind, field=field):
                    fixtures(self.root)
                    self.change(kind + "-artifact-api.json", lambda x: x.update({field: value}))
                    with self.assertRaises(ValueError): self.api()

    def setup_candidate(self):
        p = copy.deepcopy(P)
        candidate = self.root / "candidate"
        candidate.mkdir()
        f = candidate / p["installer"]["path"]
        f.write_bytes(b"MZsynthetic-replay-test")
        p["installer"].update(bytes=f.stat().st_size, sha256=V.sha(f))
        builder = self.root / "builder"
        builder.mkdir()
        for row in p["builderEvidenceFiles"].values():
            path = builder / row["path"]
            path.write_bytes(b'{"synthetic":true}\n')
            row.update(bytes=path.stat().st_size, sha256=V.sha(path))
        build = {"installer": "D:\\original\\candidate.exe", "bytes": p["installer"]["bytes"],
                 "sha256": p["installer"]["sha256"], "payload": {"rebuilt": False}, "signed": False}
        output = self.root / "out"
        output.mkdir()
        return p, build, candidate, builder, output

    def test_relocation_changes_only_path_and_preserves_receipts(self):
        p, build, candidate, builder, out = self.setup_candidate()
        result = replay.relocate(V, p, build, candidate, builder, out)
        relocated = V.read_json(out / "installer-build.relocated.json")
        expected = copy.deepcopy(build)
        expected["installer"] = str((candidate / p["installer"]["path"]).resolve())
        self.assertEqual(relocated, expected)
        self.assertFalse(result["rebuilt"])
        self.assertFalse(result["lifecycle_accepted"])
        for row in p["builderEvidenceFiles"].values():
            self.assertEqual((out / "original-builder-receipts" / row["path"]).read_bytes(),
                             (builder / row["path"]).read_bytes())

    def test_candidate_mutation_rejected(self):
        p, build, candidate, builder, out = self.setup_candidate()
        (candidate / p["installer"]["path"]).write_bytes(b"MZtampered")
        with self.assertRaises(ValueError): replay.relocate(V, p, build, candidate, builder, out)

    def test_candidate_addition_rejected(self):
        p, build, candidate, builder, out = self.setup_candidate()
        (candidate / "extra.exe").write_bytes(b"MZextra")
        with self.assertRaises(ValueError): replay.relocate(V, p, build, candidate, builder, out)

    def test_receipt_mutation_rejected(self):
        p, build, candidate, builder, out = self.setup_candidate()
        (builder / "installer-build.json").write_text("{}")
        with self.assertRaises(ValueError): replay.relocate(V, p, build, candidate, builder, out)

    def test_incomplete_acceptance_rejected(self):
        write(self.root / "installer-lifecycle.json", {"native_windows": False})
        with self.assertRaises(ValueError): replay.verify_acceptance(V, P, S, self.root, "1")


unittest.main(argv=[sys.argv[0]], verbosity=2)
