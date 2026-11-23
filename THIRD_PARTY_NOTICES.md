# Third-party components

TetherSpark is a desktop controller for existing networking tools. It is not a new Android VPN or packet relay implementation.

- [Gnirehtet v2.5.1](https://github.com/Genymobile/gnirehtet/tree/v2.5.1), Copyright Genymobile, Apache License 2.0. Setup includes the upstream license next to its executable and APK. Upstream reports limited maintenance; evaluate the engine before a public production release.
- [Android SDK Platform Tools](https://developer.android.com/tools/releases/platform-tools), Google and Android Open Source Project contributors. The extracted tools include `NOTICE.txt`. Review the [Android SDK terms](https://developer.android.com/studio/terms) for your intended use and distribution. The download link tracks Google's current version.
- Electron is MIT licensed and includes Chromium and other components with their own licenses. Packaged builds retain Electron's license and Chromium notices.
- Development packages and their dependency licenses remain in `node_modules` and the lockfile.
- Inter and JetBrains Mono are bundled locally from the official Google Fonts repository under the SIL Open Font License. Their license files are in `src/ui/fonts/`.

`tools/downloads.json` records download sources and SHA-256 digests for the local tool copies. These hashes are records of the received archives, not independent upstream signature verification.
