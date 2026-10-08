# Installer-only long-path consumer integration

Local-only proposal. No public repository write, workflow run, installer build, installation, or application rebuild has been performed by this integration task. Native qualification remains pending. The standalone tiny native gate must pass before publishing/running this full consumer; the full consumer repeats the same tiny fixture using its own freshly prepared tools before wrapping the real payload.

## Deployment layout and trigger isolation

- Workflow destination: `.github/workflows/native-installer-longpath-consumer.yml`
- Consumer destination: `qa/native-installer-longpath-consumer/`
- Append the exact line from `gitattributes.fragment` to the existing repository-root `.gitattributes`; do not replace other rules. This keeps the new contract bytes unchanged under Windows checkout
- Use the explicit file list in `deployment-manifest.json`; local review files are not deployment inputs
- The new workflow watches its own filename and only `qa/native-installer-longpath-consumer/**` on `probe/hermes-native-package-current-20261006`
- This layout does not match the existing `native-installer-preflight.yml` or old full-consumer path filters. Do not overwrite `qa/native-installer-consumer/prepare_and_package.py`, because the old workflow does not supply its new mandatory arguments
- The existing full-consumer concurrency group is preserved, so two full-wrapper variants cannot race on the same ref
- Publishing these inputs is a separate decision and can trigger the new workflow; no publication is implied by the local validation

## Provenance and untouched bytes

The original qualified contract is copied byte-for-byte from the previous consumer. Producer 37748002770 / head 90424705b9ca9f8537ffee15635b914ce52d0183, portable artifact 11539186382, archive SHA256 2664bba15d3de34f0f7ebc6984efc52d848098df29740b7353c72e48df39952b remain unchanged. The payload source commit is 5c04cb5491d047ad7546e5d74895e75d3e28e658 and the source tree is d37c08c19b1e57ce4829682c4f84ec5fc89bf1fd3c5fc56e0e2b7153f462b4cb / 17,260 files.

The workflow reconstructs and admits that exact source-only baseline from the immutable producer controller, then separately applies the six-file installer-helper/test overlay. The current helper source tree is 6932107c572037f56880caf4cf7c32985f760fd044a45f76e387c59e72b96ea4 / 17,262 files. The original producer evidence is never rewritten to describe the helper source. `installer-build.json` records both helper-baseline and separate helper admissions alongside the original payload/custody and fresh packaging identity. The wrapper checks its actual Git head against the admitted helper commit before preparation.

All five overlaid runtime helpers affect prepared `packagingIdentity`. Local mutation checks demonstrate that changes to each one invalidate previously prepared inputs. The sixth admitted file is the source-only prepared-prepackaged.test.mjs adaptation, bound by the complete helper tree. It adds synthetic supplier shape and missing/non-PE negative tests through strict validate-only. The helper manifest contains none of the standalone native fixture files. Fixture source, synthetic payload, and notices are kept in the consumer/disposable fixture work; none enter the qualified application payload.

## Gate ordering

1. Parse/native-selftest existing lifecycle/process helpers and fixture PowerShell; run synthetic Python checks
2. Admit exact successful producer run and artifact IDs, sizes, digests, available scratch budget
3. Download exact evidence/archive, admit every archive path before expansion, verify all pristine payload files
4. Reconstruct the exact baseline and separately apply/admit the installer-only helper overlay
5. Select verified original tool executables read-only; perform fresh lock-pinned dependency/native/packaging-tool preparation
6. Run the small actual native NSIS fixture with the fresh prepared tools, resolved PowerShell executable, fixture directory, and lifecycle-helper directory
7. Require actual install, complete hashes/membership, long paths, junction refusal without deletion, normal uninstall, retained sentinels, unchanged LongPathsEnabled, and empty normally completed owned process jobs
8. Preserve exact supplier notices; run fresh native probe and existing real helper Vitest suite
9. Admit original prepackaged custody, strict validate-only, then strict native NSIS with publish never
10. Require complete original payload before/after equality; retain the exact built candidate before lifecycle
11. Run the full installed native lifecycle, complete inventory admission, window/backend/normal-close, ordinary uninstall, and synthetic userdata retention; only success uploads the accepted installer

`GITHUB_ACTIONS` and `RUNNER_TEMP` survive the minimal child environment. Tokens and unrelated inherited environment do not. PowerShell resolves before PATH sanitization; no execution-policy bypass or OS/security setting changes were added.

The existing payload verifier and lifecycle remain byte-identical to the supplied consumer: every original file is mandatory. The only admitted generated additions are the stock uninstaller and `resources/package-type` whose bytes must be exactly `b'nsis'`. No missing-file exception, payload deletion, manual uninstall replacement, or guard weakening is introduced.

## Exact evidence upload patterns

The always-upload artifact contains:

- `${{ github.workspace }}/source-admission.json`
- `${{ github.workspace }}/helper-source-admission.json`
- `${{ runner.temp }}/luheng-nsis-longpath/evidence/**`
- `${{ runner.temp }}/luheng-nsis-longpath/fresh-helper-work/fixture/fixture-build.log`
- `${{ runner.temp }}/luheng-nsis-longpath/fresh-helper-work/fixture/fixture-build.json`
- `${{ runner.temp }}/luheng-nsis-longpath/fresh-helper-work/fixture/fixture-result.json`

Only those three small fixture outputs are uploaded. Its copied toolsets, synthetic project, output EXE and temporary install tree are outside `evidence/**` and are not selected. The evidence root includes fresh preparation logs/receipts, payload custody, before/after inventories, fixture invocation log, actual supplier notices/attribution, and full lifecycle observations/results.

Candidate and accepted installer upload patterns both remain `source/apps/desktop/release/nsis-prepackaged-test/Luheng-Unsigned-Manual-Test-*-x64.exe`; their artifact names are distinct from the old consumer. Supplier notices are preserved separately in evidence and must accompany any eventual private distribution.

## Verification limits

Python tests, JavaScript syntax, helper identity mutation checks, YAML/path/order checks, exact original pin comparisons, and baseline-manifest plus overlay reconstruction are local checks only. PowerShell parsing, C# compilation, actual NSIS compilation, Windows install/uninstall and the full consumer have not run in this Linux workspace. None of those native outcomes is inferred from synthetic passes. Standard-user installation, physical IME, offline and provider interaction acceptance remain outside this lane.
