# Luheng Windows release source

This branch contains the reproducible release controller for the Hermes-based Luheng desktop application. The repository's older `main` branch contains the earlier Node prototype and is not the source of these Windows installers.

## Reconstruct the application

The upstream commit, complete file inventory, overlay and SHA-256 pins are maintained in `qa/hermes-native/`. The upstream license is retained. Start with a clean checkout of the exact `upstream_commit` from `source-identity.json`, then run:

```powershell
python -B qa/hermes-native/materialize-v2-source.py <controller-directory> <upstream-directory>
```

The command verifies every admitted file before creating the local source commit. It does not install or run the application. Source updates must update both the overlay manifest and the external identity; changing either alone fails admission.

## Windows acceptance

`.github/workflows/hermes-native-package-experiment.yml` runs on native Windows x64. It checks the release helpers and updater, prepares locked dependencies, builds the application, verifies the complete portable archive, exercises shipped CLI contracts, launches the native window and backend, packages the unchanged payload with NSIS, then installs, launches and uninstalls under a restricted medium-integrity token.

Unreleased artifacts are saved before functional acceptance so a failed verification does not discard the build. A saved artifact alone is not release approval. The final acceptance gate requires all functional stages to pass.

The separate online-update consumer in `qa/release-windows/verify-online-update.ps1` exercises two genuine installed versions through the application's own update bridge. The target installer is downloaded by the application from the fixed HTTPS feed. The consumer verifies confirmation, installation, automatic restart and retention of isolated settings, session data and a project file.

## Distribution

- Download site: <https://apps.luotuai.me>
- Update feed: <https://apps.luotuai.me/updates/windows/latest.yml>
- Installer assets: this repository's versioned GitHub Releases
- Cloudflare Pages project: `luheng-download`

`qa/release-windows/create-update-feed.py` derives the update URL, size, SHA-256 and SHA-512 from actual installer bytes. The feed permits only the fixed repository and a matching version tag. Upload the exact verified installer before publishing its feed, then complete online-update acceptance before promoting the website download.

These are unsigned preview installers. The application requires user confirmation before an update and does not install updates merely because the application exits. The earlier Node prototype uses a different data layout; this release process does not claim automatic migration of that prototype's data.
