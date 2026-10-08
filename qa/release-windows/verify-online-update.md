# Real Windows online-update consumer

The `windows-online-update-acceptance.yml` consumes a committed
`qa/release-windows/update-pairs/*.json`. It never builds, publishes, edits an ASAR,
changes product versions, replaces the update feed, or downloads the target installer.
The baseline must be a real `0.7.0` product with the shipped updater, published under
`v0.7.0-beta.1`. The target must be a real `0.7.1` product published under
`v0.7.1-beta.1`. Both producer runs must already have passed restricted-token install,
launch, full-tree verification, close, uninstall, and data-retention acceptance.
Adding or updating `qualified-0.7.0-to-0.7.1.json` on
`codex/windows-release-completion` triggers the consumer; manual dispatch supports
subsequent retries with a committed pair path. A lock must only be committed after
both producer runs pass and the real target feed is published.

## Pair lock

Root fields:

- `schema`: `luheng-online-update/v1`
- `repository`: `jobKKB/luheng-highway-agent`
- `feed`: `https://apps.luotuai.me/updates/windows/`
- `from`, `to`: the two entries below

Each entry contains `version`, `url`, `bytes`, `sha256`, `exeSha256`, and `asarSha256`.
The first hash belongs to the exact published installer; the other two belong to
`LuhengOfficeAgent.exe` and `resources/app.asar` in that installer's qualified payload.
URLs are restricted to the exact repository and corresponding beta tag. All values
come from completed producer evidence; placeholders are never accepted as evidence.

Each entry also has `evidence`:

- `runId`: positive numeric producer run ID
- `headSha`: exact 40-character producer controller commit
- `artifact`: `luheng-windows-release-evidence`
- `files`: `sourceAdmission`, `structure`, `health`, `installerReceipt`, `lifecycle`

Every file value is `{ "path": "artifact-relative/path.json", "bytes": 123,
"sha256": "actual-file-sha256" }`. Paths must match the downloaded artifact's actual
directory layout. These point to source-admission, windows-unpacked-structure,
native-startup, installer-build, and installer-lifecycle receipts respectively.
The consumer checks cross-file identity and actual file hashes, not merely the
producer's success label. The lock contains no credentials.

## Execution and evidence

The consumer runs only on a disposable `github-hosted` Windows x64 runner at medium
integrity under the same runner user. It refuses pre-existing default product data
directories and uses the normal `%LOCALAPPDATA%/luheng-agent` and
`%APPDATA%/luheng-agent-desktop` locations. This matters because NSIS's normal Finish
action can restart through Explorer without inheriting temporary process environment
overrides. The test never changes a user machine or overwrites an existing profile.

The updater cache must be absent before baseline installation. NSIS then creates
its normal `installer.exe` cache, which must match the admitted baseline size and
SHA256 exactly and contain no other files or pending target download.

After installing exact baseline bytes, the real renderer bridge creates a setting
and imports an explicitly synthetic session fixture. Before creating it, Playwright
clicks the real "I'll choose a provider later" first-run button (or its Chinese
translation). No onboarding state is written directly. This ordinary preference
must survive so the automatically restarted target exposes its session sidebar.
An external project file is
also retained. The product checks the real HTTPS feed; native UI Automation confirms
the preview consent dialog. Only a running installer with the exact qualified target
SHA256 and size may receive Next, Install, or Finish clicks. No target installer is
launched by the consumer.

The automatically restarted target must have its exact executable and ASAR, a normal
visible window, the same user and medium token, and a new process ID. Its existing
window must expose the exact unique fixture title; UI Automation invokes or selects
that real row only through a supported pattern inside that process's window. This
ordinary `session.resume` action opens the shared launch-profile database; merely
starting the HTTP backend only opens a short-lived read handle and is insufficient.
Its existing
`backend-ownership.json` must associate that process with a backend that Windows
Restart Manager reports as holding the original `state.db`. Only then is that target
closed normally and reopened for renderer-based checks of the actual setting,
session, message, project-file hash, backend version, and no-further-update result.
Both installed trees must match every qualified file hash and exact membership,
apart from the one legitimate NSIS uninstaller. No forced cleanup can pass.

`online-update.json` includes the admitted `pair`, individual stage booleans, native
UI actions, automatic-profile evidence, tokens, and an error. Success requires
`status: online-update-verified`, `error: null`, `forcedCleanup: false`, and all of
`baselineInstalled`, `baselineTreeVerified`, `productConsentConfirmed`,
`installerWizardCompleted`, `targetAutomaticallyRelaunched`,
`targetFixtureOpened`, `targetAutomaticProfileVerified`, `targetTreeVerified`, `targetDataVerified`, and
`automaticUpdateVerified` to be true. Separate renderer and tree receipts, progress
events, and screenshots are uploaded with the restricted-token wrapper receipt.

## Local checks

`node verify-online-update.mjs --self-test` checks authority, exact versions, path
boundaries, and product-stage order. `uv run --no-project python -I -S -B
verify-online-update.py self-test` checks actual small evidence files and rejects
tampered hashes, failed runs, changed source identity, changed installer custody,
and forced cleanup. PowerShell parsing and C# compilation require no app installation.
These checks do not claim the native online-update journey passed. Only the successful
Windows consumer run with the real published A/B pair establishes that result.
