Windows x64 preview baseline for the native Luheng desktop client.

This build adds the NSIS installer and an explicit-consent online updater using https://apps.luotuai.me/updates/windows/. Downloads are checked against their size, SHA-512, and SHA-256 before installation. Downgrades and downloads outside the configured release authority are rejected.

The installer preserves the admitted payload bytes and supports long Windows payload paths. Qualification covers the native window and backend, restricted-token installation, every installed payload file, normal shutdown, uninstall, and retained synthetic user data. All checks must pass in the same replacement native producer run, linked below when published. Earlier failed installer and recovery runs are diagnostic history and are not release candidates.

This preview is unsigned. It is a new Hermes-based product; migration of settings and sessions from the legacy Node prototype is not included. The baseline is retained for the real 0.7.0-to-0.7.1 online-update acceptance test.
