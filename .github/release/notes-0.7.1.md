Windows x64 preview of the native Luheng desktop client with an NSIS installer and explicit-consent online updates.

The client checks https://apps.luotuai.me/updates/windows/, verifies the complete download's size, SHA-512, and SHA-256, and uses the standard NSIS update flow. The installer keeps the exact admitted payload, then restarts the client through its normal finish action.

The installer supports long Windows payload paths. Qualification covers the native window and backend, restricted-token installation, every installed payload file, normal shutdown, uninstall, and retained synthetic user data. All checks must pass in the same replacement native producer run, linked below when published. Earlier failed installer and recovery runs are diagnostic history and are not release candidates.

This preview is unsigned. Migration of settings and sessions from the legacy Node prototype is not included. The website's release metadata records online-update acceptance separately, after the real 0.7.0-to-0.7.1 journey passes.
