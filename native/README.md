# Serotine installed clients

SIP-10 now has bundled mobile and desktop client source, native storage/transport adapters, and build workflows. Development packages are built in CI, while public production binaries still require the protected signing setup and platform qualification described below. The signed release workflow can attach Windows, macOS, Android, and iOS artifacts to a versioned GitHub prerelease and finalize it only after all four platform binaries are present.

The renderer reuses the existing React messaging UI. Its JavaScript, CSS, fonts, and static assets ship inside the app, so opening the app does not require downloading executable code from the website. The hosted Cloudflare relay remains separate. Packaging does not start a Next.js server on the device.

## Build locally

Use Node 22.13 or later (CI pins 22.23.2), install the repository dependencies with `npm ci`, and set `SEROTINE_RELAY_ORIGIN` to your deployed HTTPS relay origin. This is a public build setting, not a secret. Use a bare origin with no path, credentials, or query string; mobile targets require the standard HTTPS port. Native authenticated requests retain the relay's signed ownership checks; the browser CORS policy is unchanged.

```sh
export SEROTINE_RELAY_ORIGIN=https://serotine.peni667.org
npm ci
npm run native:build
node native/scripts/verify-versions.cjs
```

This is the same server used by the Serotine website. Development CI uses it by default; set the repository variable `SEROTINE_RELAY_ORIGIN` to use a different deployment. Local builds still require an explicit origin. The first build is a development build; `npm run native:build -- --release` creates the production renderer and must use a production endpoint. The app keeps its own local identity and history; import a backup to transfer them from the browser.

### Windows / macOS

Run on the target operating system:

```sh
npm --prefix native/desktop ci
npm --prefix native/desktop test
npm --prefix native/desktop start
# Windows x64 development installer:
npm --prefix native/desktop run package:dev -- --win --x64
# macOS Apple silicon development disk image:
npm --prefix native/desktop run package:dev -- --mac --arm64
```

Outputs are in `native/desktop/dist`. Development packages do not carry a publisher certificate; do not present them as official signed releases. The build configuration also exposes other architectures for future qualification, but this implementation does not claim tested Windows ARM64 or Intel Mac support. Linux is not a SIP-10 distribution target.

### Android / iOS

```sh
npm --prefix native/mobile ci
npm --prefix native/mobile test
npm --prefix native/mobile run sync
# Open the appropriate platform project:
npm --prefix native/mobile run android
npm --prefix native/mobile run ios
```

Android requires Java 21, Android SDK 36, and build tools 36.0.0. The app targets Android API 26 or newer and checks for Chromium/WebView 120 or newer at startup; these are compatibility requirements, pending physical-device qualification. The checked-in Gradle wrapper uses 8.14.3 and Android Gradle Plugin 8.13.0. From `native/mobile/android`, `bash gradlew --no-daemon assembleDebug` builds a debug-certificate APK in `app/build/outputs/apk/debug`. On Windows, use `gradlew.bat`.

iOS requires macOS and Xcode 26 or newer, with an iOS 16.4 deployment target matching the renderer. The project is `native/mobile/ios/App/App.xcodeproj`, scheme `App`, using the pinned Capacitor Swift package. CI selects Xcode 26.6 on the `macos-26` image and compiles the Debug configuration for iOS Simulator with signing disabled. This is a compile check, not an installable iPhone download.

See the [release and qualification guide](../docs/SIP-10-apps.md) before preparing a signed build. Native package versions must match the root `package.json`; production Android/iOS builds also need an increasing build number.

## Data and operation

- Development identity: `app.serotine.client.dev`; production identity: `app.serotine.client`. Their app data is separate. Keep these IDs and the bundled origin stable between updates.
- Browser storage is separate from installed-app storage. Create an identity or restore an existing password-encrypted full backup. A validated restore retains the public address and existing identity-switch confirmation rules.
- Encrypted native snapshots persist local identity, history, queued work, settings, and local blobs. This prototype has a **64 MiB encoded snapshot limit**, a **16 MiB per-file limit**, and a **32 MiB file-bank budget**; the browser's larger file-bank allowance does not apply. An attachment-heavy backup may exceed the native snapshot capacity.
- Full transfer backups still exclude Backpack contents, drafts, private messages/access keys, and remote file bytes. A locally persisted snapshot is distinct from an exported transfer backup. Copy files separately when moving to another device.
- Mobile synchronization is foreground only. No APNs/FCM delivery, force-stop delivery, share-in extension, or background calling is implemented. Desktop needs a running process and an available network; it has no tray service or launch-at-login feature. Closing the window prompts to quit; confirming Quit stops calls, transfers, and synchronization.
- Use the visible official-download link for updates. There is no automatic executable updater or remote UI replacement. Export an encrypted backup before updating, uninstalling, or removing app data.

App builds share existing message and backup formats. Calling permission plumbing and shared calling UI are present, but native calling has not been qualified across devices/networks; the current native signaling path uses the existing signed HTTP polling compatibility path. Native screen sharing is not supported. Do not describe these development builds as calling-ready.

## Workflows

`native-build.yml` runs native unit and bundled-renderer browser smoke tests on Linux, builds development Windows x64, macOS arm64, and Android packages, and compiles the iOS Simulator target. It uploads only selected packages, SHA-256 checksums, and nonsecret provenance metadata. Android development packages use Android's debug certificate; Windows/macOS development packages have no publisher signature.

`native-release.yml` runs only by manual dispatch on `main` with `NATIVE_RELEASE_ENABLED=true`, and all signing jobs reference the `native-release` environment. Configure environment reviewers and branch protection before enabling it. It verifies versions, builds a production renderer, requires signing credentials, verifies signatures, uploads reviewable Actions artifacts, and then attaches the selected signed package plus a fresh SHA-256 checksum to `v<version>` on GitHub Releases. The version stays a prerelease while platforms are being collected. Set the workflow's `finalize` input only on the last platform; finalization fails unless Windows x64, macOS arm64, Android, and iOS assets are all present. It still never sends a build to TestFlight/Play or deploys the backend.

The build workflows have not been executed on hosted Windows/macOS/Android runners as part of this change. Passing source tests cannot establish successful installation, OS updates, or device behavior.
