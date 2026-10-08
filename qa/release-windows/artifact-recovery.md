# Retained installer acceptance

The recovery workflow does not build an application, restamp a package, execute downloaded helpers, or change a producer conclusion. It accepts only the retained 0.7.0 and 0.7.1 producer identities hardcoded in `artifact-recovery.py`.

Commit one lock per version at `recovery-locks/qualified-<version>.json` after the producer completes. The lock is:

```json
{
  "schema": "luheng-artifact-recovery/v1",
  "repository": "jobKKB/luheng-highway-agent",
  "version": "0.7.0",
  "producer": {
    "runId": 37750546324,
    "headSha": "88283312b213d95f330964d1d8e4302052f2be8c",
    "installerArtifactId": 11541422993,
    "installerArtifactDigest": "sha256:<exact API digest>",
    "evidenceArtifactId": 11543060233,
    "evidenceArtifactDigest": "sha256:<exact API digest>"
  }
}
```

Placeholders are not accepted. Push helper changes separately with CI skipped, review them, then commit both complete locks to trigger the two independent Windows jobs. The producer must be completed; its only permitted failures are the original restricted-token lifecycle and final acceptance gate. Every source admission, build, package structure, archive, functional contract, native startup and NSIS packaging prerequisite must have succeeded.

Both ZIP downloads are checked against the locked GitHub archive SHA256 and byte count before safe extraction. The installer receipt in the installer artifact must exactly match the receipt in the original evidence artifact. Only the original installer is executed, using the committed corrected helpers on a disposable restricted-token Windows runner. The original four JSON files remain byte-for-byte unchanged, including their old absolute installer path and producer run IDs. The recovery contract resolves the actual relocated installer separately.

The new report has `scope: artifact-recovery`, the original `build_run_id`, and the actual new `consumer_run_id` and `acceptance_run_id`. Its contract binds `acceptance.runId` and `acceptance.headSha` to the live Actions environment. Install, complete installed-tree hashes, real window, contained backend health, graceful close, normal uninstall and data retention all remain mandatory.

Each successful job uploads `luheng-windows-recovery-evidence-<version>`. Locate its unique `provenance.json`; its grandparent is the canonical evidence root. Under that root:

- `producer/` contains the four unchanged source admission, structure, health and installer receipt JSON files.
- `acceptance/installer-lifecycle.json` contains the new lifecycle result.
- `acceptance/provenance.json` binds both execution identities, the original live artifact metadata and each evidence-file hash.

Diagnostics elsewhere in the artifact are not qualification inputs. Failed jobs still preserve their diagnostics but are never publishable. Publication and online upgrade locks independently pin the recovery run ID, head SHA and artifact ID. `verify-online-update.py:qualify` admits this branch only with a live API bundle containing `producer`, `producerJobs`, `producerArtifacts`, `acceptance` and `acceptanceArtifact`; the acceptance workflow must be completed and successful. An original failed producer is never described as successful.

The publisher release lock may add `recoveries.from` and `recoveries.to`, each containing `runId`, `headSha`, and `artifactId`. In the online pair, the original `evidence` identity and four producer-file pins remain separate from `evidence.recovery`, which names the new artifact and pins its lifecycle and provenance files.

Run `selftest-artifact-recovery.py`, `selftest-lifecycle.py`, and `verify-online-update.py self-test` with `uv run --no-project python -I -S -B`. The native retained-handle self-test and actual lifecycle acceptance must still run on Windows Actions. Passing local custody tests does not qualify an installer.
