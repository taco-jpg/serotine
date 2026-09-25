# SIP-10 — installed apps implementation and release gates

## Status

The initial implementation provides a shared bundled renderer, Electron desktop shell, Capacitor Android/iOS projects, constrained relay/file/storage bridges, and development plus manual signed-artifact workflows. **SIP-10 is not yet a shipped four-platform release.** Signing accounts, real platform builds, install/update tests, physical-device messaging and storage checks, and distribution are release prerequisites.

| Target | Build configuration | Qualification status |
| --- | --- | --- |
| Android | Capacitor 8.5.2; SDK 36; minimum API 26 with Chromium/WebView 120+; debug APK / signed release APK | Physical-device support pending; minimum API is a build setting, not a tested support claim |
| iPhone / iPad | Capacitor 8.5.2; deployment target iOS 16.4; Xcode 26.6 CI; App Store-profile archive/export path | Simulator compile workflow provided; real-device/TestFlight validation pending |
| Windows | Electron 44.4.5; x64 NSIS EXE workflow | OS version and install/update support matrix pending physical testing |
| macOS | Electron 44.4.5; Apple silicon DMG workflow | OS version, Keychain, signing/notarization, and install/update validation pending |

Windows ARM64 and Intel Mac targets in the desktop builder are future qualification targets. Do not advertise them from configuration alone. No Linux package is promised.

### Validation performed for this change

The full unit suite passed **858 tests, with 0 failures and 1 browser-only skip**. The targeted native suites passed all 42 tests. The shared native renderer and Next.js production build completed, Capacitor platform synchronization completed, and TypeScript checking passed. Lint finished with 0 errors and 4 existing warnings. Workflow YAML parsing, helper syntax checks, release version/build guards, artifact checksum generation, and artifact allowlist/symlink checks passed.

Native runtime smoke tests could not complete in this environment: Electron exited before app startup because the container blocked its OS socket operation, and the Chromium download returned a broken archive. These are validation limits, not passing runtime checks. The Linux renderer CI job installs Chromium and runs `native:smoke` to exercise the bundled renderer with synthetic native boundaries. Hosted CI has not yet run; Windows/macOS installation, Android/iOS compilation and devices, release signatures, and updates remain unverified.

## Architecture and security boundaries

`native/web` bundles the existing messaging components at build time. `native/desktop` owns Electron privileged code; `native/mobile` owns Android and iOS platform projects. Server routes and Cloudflare D1 remain hosted. Native networking accepts only allowed relay operations against the configured HTTPS origin, with redirects constrained; message ownership and signature checks remain server-enforced. It is not a general native HTTP proxy. The browser's origin policy is not broadened.

The renderer has no filesystem or shell API. Electron uses sandboxing, context isolation, disabled Node integration, validated top-frame IPC, and external-browser navigation for untrusted links. Capacitor limits the bridge to its packaged origin. Attachment bodies and messages remain untrusted content. Picking a file or following a link does not send a message without the existing preview/confirmation flow.

The encrypted native snapshot is restored before the shared UI is mounted. Native persistence errors must remain visible; unavailable or corrupt protected data must not silently create a new identity. The snapshot includes identity, ordinary history, outbox, settings, and local blob records, with a 64 MiB encoded limit. Installed clients limit individual local files to 16 MiB, the file bank to 32 MiB, and native file exports to 64 MiB. These limits reserve some snapshot space for history; large histories can still reach the total cap. Recovery and low-storage failure need physical-device qualification.

| Platform | Local key and snapshot policy | Backup policy |
| --- | --- | --- |
| Android | AES-GCM snapshot, Android Keystore key, app-private no-backup storage | Android cloud backup and device-transfer exclusions are explicit; no automatic export of plaintext identity/history |
| iOS | AES-GCM snapshot, device-only Keychain key, app-private persistence | Snapshot excluded from OS backup; WebView storage is ephemeral; staging data is transient |
| Windows | AES-GCM snapshot, Electron OS-backed key protection, LocalAppData | Avoid roaming app data; custom enterprise/user backup software remains outside the app's control |
| macOS | AES-GCM snapshot, Electron Keychain-backed key protection, Application Support | App directory marked excluded from Time Machine; user-selected/manual copies remain possible |

These are implemented policies, not claims of hardware-bound identity keys or guaranteed recovery. Linked clients intentionally share an exportable identity key. A compromised endpoint can still expose it. There is no new forward-secrecy or linked-device revocation system.

If startup cannot open the protected store, the recovery screen preserves it and offers retry by reopening the app. Deliberate local erasure requires typing `DELETE LOCAL DATA` and confirming a native system dialog; only then can a clean start restore an existing encrypted backup. Erasure is permanent, and backup exclusions still apply. This recovery route also addresses an orphaned iOS Keychain entry after uninstall; no missing/corrupt store is silently reset.

## Identity transfer, updates, and background behavior

Use the existing password-encrypted full backup for browser ↔ installed-app transfer. Browser history does not appear automatically. Restore validates the password/schema/identity before import and preserves confirmation and archival behavior when switching identities. Full backups exclude drafts, Backpack file contents, private messages/access keys, and remote file bytes; remote descriptors do not extend relay retention. Linked clients share identity keys and cannot be individually revoked.

Development and production app IDs are `app.serotine.client.dev` and `app.serotine.client`; do not change production IDs or the installed origin after users create data. Ordinary updates must preserve app data and use the same signing identity. Do not install development packages over a production identity. A release build number must exceed the previous distributed Android/iOS build. Maintain the previous value in the protected release environment before the next distribution.

Mobile networking is supported only while the app is active. Push notifications, share-in extensions, background calls, background file transfers, tray/menu-bar persistence, and launch-at-login are later work. Native screen sharing is disabled. Shared voice/video UI and native permissions are implementation groundwork; no cross-device calling support is claimed until qualified. Native signaling currently uses signed HTTP polling compatibility, so the SIP-3 WSS calling target remains a follow-up.

On desktop, closing the window prompts to quit; confirmed Quit goes offline. Minimize leaves the process running, subject to OS suspension and networking. Native startup/resume hooks request synchronization; process-kill, sleep/wake, and duplicate-event behavior still require platform tests. The official-download link is the update mechanism. There is no unreviewed remote code loader or automatic updater.

Before uninstalling or erasing data, export and verify an encrypted backup. Android/iOS uninstall or clearing app storage can permanently remove local data; a Keychain entry alone is not a backup. The Windows installer is configured to preserve app data on uninstall. Moving the macOS `.app` to Trash does not remove its Application Support data. Desktop **Erase local app data…** confirms removal and quit. Deleting local data does not revoke linked devices or remove remote copies.

## Release setup

The [native build guide](../native/README.md) gives local commands. All release operations here prepare artifacts for review; uploading to stores or publishing download links is a separate action.

1. Confirm ownership of the production bundle/application IDs, Android release key, Windows signing account/certificate, Apple Developer membership, and App Store Connect app record. Keep recoverable backups of signing material outside the repository.
2. Configure the GitHub environment `native-release` with required reviewers, restricted `main` deployments, and no fork access. The YAML references an environment; it cannot itself install required-reviewer rules.
3. Set repository variable `NATIVE_RELEASE_ENABLED=true` only when this environment is protected. Set environment variables `SEROTINE_RELAY_ORIGIN` to the production HTTPS origin and `NATIVE_LAST_RELEASE_BUILD_NUMBER` to the last distributed build number (`0` before the first distribution).
4. Match the root, desktop, and mobile package versions. Manually dispatch **Prepare signed native release artifacts** on `main`, choose one platform, and supply that version and a strictly greater build number. The native build rejects unsuitable production endpoints. The version guard checks configuration consistency, not App Store/Play historical records; release owners must maintain the previous build value accurately.
5. Install and qualify the signed output before any public distribution. Preserve `ARTIFACTS.json`, `SHA256SUMS`, commit ID, toolchain versions, signature identity, test results, and release notes. Update the recorded last-distributed build number after distribution. Use one version/build number consistently for the same cross-platform release when appropriate.

### Protected credentials

| Platform | Environment secrets | Notes |
| --- | --- | --- |
| Windows | `WINDOWS_CSC_LINK`, `WINDOWS_CSC_KEY_PASSWORD` | Electron-builder-compatible signing certificate input; a hardware/cloud-backed signing provider may require a separately reviewed signing integration |
| macOS | `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Developer ID Application identity plus notarization credentials; builder requires signing, hardening, and notarization |
| Android | `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Stable existing signing key; workflow decodes only to runner temporary storage and removes it after Gradle exits |
| iOS | `IOS_DISTRIBUTION_CERT_BASE64`, `IOS_CERT_PASSWORD`, `IOS_PROVISION_PROFILE_BASE64`, `APPLE_TEAM_ID` | Apple Distribution certificate and nonexpired App Store profile for `app.serotine.client`; ephemeral keychain/profile are removed on exit |

Never put certificates, keystores, provisioning profiles, passwords, developer account tokens, or real user backups in source control or artifacts. Release artifacts are allowlisted installer/IPA files plus checksums and nonsecret metadata; build directories and signing files are not uploaded. Avoid debug logging for signing jobs. CI has read-only repository permissions and no publish token.

For local Android release preparation, set `ANDROID_KEYSTORE_PATH` to the secure local keystore plus the four signing/build environment settings documented above and run `assembleRelease` after building/syncing a production renderer. Desktop uses `package:release`, `CSC_LINK`, and `CSC_KEY_PASSWORD`; macOS additionally needs notarization credentials. The CI maps platform-specific secret names to the desktop script's generic names. Do not use `package:dev` for an official app ID.

The iOS helper creates a signed archive and exports an IPA using an App Store provisioning profile. It does not upload anything. After successful qualification, submit through App Store Connect/Transporter for TestFlight processing and any external-beta review. A downloadable IPA is not the general iPhone installation route. App Store acceptance is not established by a successful build; minimum-functionality and privacy requirements still apply.

### Release verification and installation

The workflow verifies Authenticode on Windows installers, APK signatures with Android's `apksigner`, macOS app code signatures and stapled notarization tickets, and the archived iOS app signature. These checks are designed gates; this change has not exercised them with real distribution credentials.

For each first supported OS/architecture, test a clean install followed by an install-over-update signed by the same publisher. Compare the package checksum with the official release's checksum before testing. Windows installs through the EXE; macOS through the DMG with the app copied into Applications; Android through the signed APK with the system package installer. Confirm the expected publisher/signing identity and version. Publish only combinations that pass, with explicit minimum OS versions and architectures. Signing does not guarantee that Windows reputation warnings disappear.

## Required qualification record

Every item below remains pending on physical target devices unless a release record explicitly links a successful run. Unit tests, source review, simulator compilation, and web browser tests do not satisfy this record.

- Clean install and offline launch; create/restore same address; wrong-password and corrupt backup rejection; existing-identity switch and archive recovery; export/import round trip across browser, Android, iPhone, Windows, and Mac.
- Durable identity/history/settings/outbox/file records across process kill, reboot, storage pressure, permission/keychain denial, interrupted writes, signed updates, and uninstall/data removal. A failure must preserve recoverable saved data rather than replace the identity.
- Direct/group/community messaging, attachments, delivery/retry/read states, retained-event catch-up, duplicate rejection, relay retirement, old-client compatibility, expiry-before-display, and deleted-history replay protection.
- Keyboard, Android Back, safe areas, rotation/tablets, on-screen keyboard, large text, TalkBack/VoiceOver, focus navigation, file-open/save cancellation, drag-and-drop, QR scanning, and microphone/camera denial.
- Real desktop ↔ browser and desktop ↔ desktop voice/video calls across separate networks with configured STUN/TURN before calling is advertised. Real mobile calls require equivalent validation and explicit foreground limitations.
- Untrusted links, redirects, frames, messages, attachments, plugin content, and malformed bridge inputs cannot acquire privileged access. No accidental transmission from open/share/pick actions.
- Signed package contents contain no private data, credentials, localhost/test endpoints, or development identity. Android signing identity and Apple/Windows publisher identity survive updates. macOS notarization works on a clean machine.

Pending product milestones include privacy-preserving push registration/rotation, notification eligibility while suspended, native share-in preview/Send, platform background behavior, a tested support matrix, and store/distribution review. These are tracked separately from initial shell implementation.

## Primary references

- [Capacitor 8 environment requirements](https://capacitorjs.com/docs/getting-started/environment-setup) and [8.0 upgrade requirements](https://capacitorjs.com/docs/updating/8-0).
- [Android application signing and update-key requirements](https://developer.android.com/studio/publish/app-signing).
- [Electron signing](https://www.electronjs.org/docs/latest/tutorial/code-signing), [electron-builder signing configuration](https://www.electron.build/docs/features/code-signing/), and [macOS notarization](https://www.electron.build/docs/features/code-signing/notarization/).
- [Apple TestFlight](https://developer.apple.com/testflight/) and [App Store Connect build upload](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/).
- [GitHub macOS 26 runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-26-Readme.md).
