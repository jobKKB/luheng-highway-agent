# Qualified Windows preview publication

This lane downloads existing qualified native producer artifacts on an Ubuntu
runner. It never rebuilds or executes the Windows installer or artifact code.
All GitHub operations use `gh`.

The workflow only runs when `.github/release/windows-preview-release-lock.json`
changes on `codex/windows-release-completion`. Adding that file is the explicit
publication action. Do not add it until both separate recovery acceptance runs finish successfully.
The expected JSON is exactly `schema: luheng-preview-release/v1`,
`repository: jobKKB/luheng-highway-agent`, `publish: true`, and `producers` equal
to the `PRODUCERS` constant in `publish-windows-preview.py`. The additional
`recoveries` object must contain `from` and `to`, each with the reviewed `runId`,
40-character `headSha`, and exact evidence `artifactId`.

The publisher checks both producer run IDs, commits, workflow paths and every
required job step. An original failed run is accepted only when its exact failure
set is the native lifecycle step and final acceptance gate; all required earlier
build, archive, tool-contract, startup and NSIS steps must have passed. Its failed
status is preserved. Each separate recovery run must be successful, use the pinned
commit and recovery workflow, and supply the exact pinned evidence artifact.
It selects the unique exact-name installer and evidence artifacts and checks
their IDs, size and digest metadata again after `gh run download`. It locates each
required evidence basename exactly once, pins its actual relative path and bytes,
then reuses the online-update consumer's complete `qualify` verification. Recovered
evidence contains the unchanged original four producer files plus new lifecycle
and provenance files. The original build run IDs and hashes stay intact; the new
consumer run ID remains distinct. Producer artifact IDs, digests and sizes in the
recovery provenance must also match the live GitHub API.
Installer contents are only read for MZ, size, SHA-256 and SHA-512 checks.

Both existing release states are checked before changes. The publisher refuses
different tags, extra or different assets, and incomplete published releases.
New releases remain drafts until all assets for both releases are uploaded and
verified. It never uses `--clobber`, deletes assets or moves tags. Public releases
are prereleases and are not marked latest. A failed upload may leave a draft for
inspection; it does not weaken the checks on a rerun.

The small `luheng-preview-publication-metadata` artifact contains the actual
`pair-lock.json`, target `latest.yml`, `SHA256SUMS.txt`, and publication receipt.
The downloaded Windows artifacts remain on the disposable runner. Publish the
target feed and commit the pair lock to the independent online-update consumer
before claiming 0.7.0-to-0.7.1 update acceptance.

Run the non-network self-check with:

```powershell
uv run --no-project --python 3.12 python -I -S -B .github/release/selftest-publisher.py
```
