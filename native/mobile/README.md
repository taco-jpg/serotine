# Serotine mobile clients

These Android and iOS projects package the shared renderer from `../web/dist`.
They are a foreground-only beta implementation, pending native CI and physical-device acceptance.
The signed APK and TestFlight distributions are release gates, not files checked into this repository.

## Build

Install the repository dependencies and `npm ci --prefix native/mobile`. Build the renderer from the repository root with `SEROTINE_RELAY_ORIGIN=https://your-relay.example npm run native:build`, then run the mobile `sync` command with the same environment variable. A release renderer uses `npm run native:build -- --release`.

- Android: JDK 21, Android SDK 36, Gradle wrapper 8.14.3. Run `./gradlew assembleDebug` inside `android` for the development APK. Android API 26 is the native minimum; the shared interface requires a current Android System WebView (Chromium 120+). Unsupported origin-aware bridge implementations fail closed.
- iOS: macOS with Xcode 26 and iOS 16.4+ deployment target. Open `ios/App/App.xcodeproj`, use scheme `App`, and select a simulator/device. `Debug` uses `app.serotine.client.dev`; `Release` uses `app.serotine.client`. Supply signing/team settings outside the source tree.
- Android releases require `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, and an increasing `SEROTINE_BUILD_NUMBER`. Keep and recover the same signing key for updates; do not generate a new key per build. `assembleRelease` fails without those values.
- `sync` pins the generated Swift package to Capacitor 8.5.2. Never add `server.url`, `allowNavigation`, live-reload servers, or a remote code updater to release configuration.
- `npm test` compiles and executes the actual Java boundary policy without requiring Android, and checks relay configuration validation. Full builds and physical-device tests remain necessary.

The development and release bundle/application IDs remain separate; neither shares its native key or files with the browser or the other channel. The stable bundled origins are `https://localhost` on Android and `capacitor://localhost` on iOS. The native host rejects a mismatched renderer version, relay, or development/release channel.

## Storage and bridge

Identity, history, settings, retained files and outbox snapshots are AES-256-GCM encrypted in app-private persistent storage, atomically replaced, and excluded from Android cloud backup/device transfer and Apple backups. Android protects the key with Android Keystore; iOS uses a non-synchronizing Keychain item accessible after first unlock on this device only. This protects a local copy; deliberate password-encrypted export remains possible. Missing keys, corruption, or loss of previously initialized snapshots fail closed rather than silently creating a different identity. An iOS key surviving uninstall also requires recovery if its data is gone. Startup recovery offers an explicit local reset: type `DELETE LOCAL DATA`, then confirm in the native destructive-action dialog. The app clears its native key/snapshot and temporary website data; a separately saved encrypted backup can then be restored. Recovery never resets data automatically.

The prototype snapshot limit is 64 MiB, including base64 expansion. This is lower than the web client's file-bank quota. Storage errors leave the existing snapshot intact and block signed work until saving succeeds. The user must keep an encrypted backup before uninstalling, clearing data, or switching channels.

`SerotineNative` exposes only information, snapshot read/write, an allowlisted relay request, native backup picker/save, external HTTP(S) links, and lifecycle/Back events. There is no arbitrary path access, shell execution, remote UI, or generic Capacitor HTTP/cookie/WebView API. The actual calling frame must be the trusted main frame. Native relay requests use the fixed bundled HTTPS origin, no cookies, no redirects, bounded binary bodies, fixed Origin, and the existing signed protocol. Browser endpoint protections are unchanged.

Native save actions write only to an OS-selected destination; importing only reads the selected file, with backup validation and identity confirmation in the shared interface. iOS staging is private, protected, backup-excluded and removed after selection/cancel or next launch. Android writes directly to the selected document URI. No inbound share handler automatically sends content. Inbound share extensions and background push remain later milestones.

Camera and microphone prompts occur when media is requested; denial is recoverable. Background/closed-app notifications and uninterrupted calls are not implemented. The app displays this limitation.

## Acceptance still required

Before signing a beta, test first install, offline startup, same-address restore, wrong passwords, corrupted snapshots/backups, existing identity switch, process death, reboot, low disk, uninstall/reinstall, and signed install-over-update on real Android and iOS devices. Verify browser/mobile messaging, group/file exchange, backup round trips, resume expiry and outbox replay, interrupted calls/transfers, Android Back, safe areas/keyboard, text scaling, TalkBack/VoiceOver, permissions denied/cancelled, and hostile frame/link/file bridge probes. A generated project or Java unit test does not prove these device behaviors.

The icon is the existing repository AppLogo converted by `scripts/icons.cjs`, not a new brand. The generator uses the repository's Sharp dependency; generated platform assets are checked in.
