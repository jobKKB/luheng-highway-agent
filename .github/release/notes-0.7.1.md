Windows x64 preview of the native Luheng desktop client with an NSIS installer and explicit-consent online updates.

The client checks https://apps.luotuai.me/updates/windows/, verifies the complete download's size, SHA-512, and SHA-256, and uses the standard NSIS update flow. The installer keeps the exact admitted payload, then restarts the client through its normal finish action.

Qualification covers the native window and backend, restricted-token installation, every installed payload file, normal shutdown, uninstall, and retained synthetic user data. Build and startup evidence: https://github.com/jobKKB/luheng-highway-agent/actions/runs/37751086133. A separate successful native acceptance run qualifies the unchanged installer and is linked below. The original producer conclusion is retained separately and is never relabeled as a successful run.

This preview is unsigned. Migration of settings and sessions from the legacy Node prototype is not included. The website's release metadata records online-update acceptance separately, after the real 0.7.0-to-0.7.1 journey passes.
