Windows x64 preview of the native Luheng desktop client with an NSIS installer and explicit-consent online updates.

This release fixes post-update startup: the per-user installer launches the installed executable directly with its own user and privilege level. It no longer delegates startup to Explorer, which can unexpectedly run the client with administrator privileges when the desktop shell is elevated.

The client checks https://apps.luotuai.me/updates/windows/ and verifies the complete download's size, SHA-512, and SHA-256. Native qualification covers installation, every installed payload file, the window and backend, normal shutdown, uninstall, and retained synthetic user data under a restricted Windows token.

This preview is unsigned. Migration of settings and sessions from the legacy Node prototype is not included. The website records online-update acceptance separately after the real 0.7.0-to-0.7.2 journey passes. Previously published assets remain unchanged.
