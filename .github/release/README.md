# Qualified Windows preview publication

This lane downloads existing qualified native producer artifacts on an Ubuntu
runner. It never rebuilds or executes the Windows installer or artifact code.
All GitHub operations use `gh`.

The workflow only runs when `.github/release/windows-preview-release-lock.json`
changes on `codex/windows-release-completion`. Adding that file is the explicit
publication action. Do not add it until both pinned native producer runs finish successfully.
The expected JSON is exactly `schema: luheng-preview-release/v2`,
`repository: jobKKB/luheng-highway-agent`, `publish: true`, and `producers` equal
to the `PRODUCERS` constant in `publish-windows-preview.py`. The baseline is the
reviewed successful run 37809587446 (0.7.2), commit
`4036b65ade36eaaff2be1fe60b7ac2b8eeb1eb3d`. The 0.7.3 target run and commit remain
unset until its complete producer passes. Unset pins reject all publication locks.
The existing publication lock is historical and cannot enable this new pair.
A recovery object is not accepted.

The publisher checks both producer run IDs, commits, workflow paths and every
required job step, including actual installation, normal exit, uninstall and the
final acceptance gate in that same run. Failed, partial and lifecycle-only
recovery runs cannot qualify. The preserved 0.7.2 baseline and new 0.7.3 target
include corrected NSIS long-path handling and synchronous verification, and keep
the current user's privilege level during restart instead of inheriting a
potentially elevated Explorer token. The new target adds dedicated Luheng artwork.
It selects the unique exact-name installer and evidence artifacts and checks
their IDs, size and digest metadata again after `gh run download`. It locates each
required evidence basename exactly once, pins its actual relative path and bytes,
then reuses the online-update consumer's complete `qualify` verification. Source
admission, full payload manifest, native health, installer receipt and lifecycle
report all belong to the same successful producer. Installer and evidence
artifacts must carry that producer's run ID and commit in the live GitHub API.
Historical recovery scripts remain diagnostic tools; they are not part of this
publication path and do not authorize the earlier failed installer bytes.
Installer contents are only read for MZ, size, SHA-256 and SHA-512 checks.

Both existing release states are checked before changes. The publisher refuses
different tags, extra or different assets, and incomplete published releases.
New releases remain drafts until all assets for both releases are uploaded and
verified. It never uses `--clobber`, deletes assets or moves tags. Public releases
are prereleases and are not marked latest. A failed upload may leave a draft for
inspection; it does not weaken the checks on a rerun.

Each pinned version needs its `notes-<version>.md` before publication. When the
Actions token cannot create a release at the admitted producer commit, create
the exact missing tag and empty draft prerelease with the already-authorized local
`gh` account before rerunning publication. Verify the tag's object SHA and draft's
target equal the producer's `headSha`. The publisher still validates all uploaded
assets before exposing the release; never move an existing tag or expand workflow
permissions to bypass these checks.

The small `luheng-preview-publication-metadata` artifact contains the actual
`pair-lock.json`, target `latest.yml`, `SHA256SUMS.txt`, and publication receipt.
The downloaded Windows artifacts remain on the disposable runner. Publish the
target feed and commit the pair lock to the independent online-update consumer
before claiming 0.7.2-to-0.7.3 update acceptance. Save the actual generated pair as
`qa/release-windows/update-pairs/qualified-0.7.2-to-0.7.3.json` only after publication
and deployment of its target feed. Preserve earlier pair files and release assets.

Run the non-network self-check with:

```powershell
uv run --no-project --python 3.12 python -I -S -B .github/release/selftest-publisher.py
```
