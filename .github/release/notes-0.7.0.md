Windows x64 preview baseline for the native Luheng desktop client.

This build adds the NSIS installer and an explicit-consent online updater using https://apps.luotuai.me/updates/windows/. Downloads are checked against their size, SHA-512, and SHA-256 before installation. Downgrades and downloads outside the configured release authority are rejected.

The installer preserves the admitted payload bytes. Qualification covers the native window and backend, restricted-token installation, every installed payload file, normal shutdown, uninstall, and retained synthetic user data. Build and startup evidence is available in https://github.com/jobKKB/luheng-highway-agent/actions/runs/37750546324. A separate successful native acceptance run qualifies the unchanged installer and is linked below. The original producer conclusion is retained separately and is never relabeled as a successful run.

This preview is unsigned. It is a new Hermes-based product; migration of settings and sessions from the legacy Node prototype is not included. The baseline is retained for the real 0.7.0-to-0.7.1 online-update acceptance test.
