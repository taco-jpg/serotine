---
sip: 10
title: Android and iOS apps
author: sodium-qed
status: Draft
created: 2026-09-13
---

# SIP-10: Android and iOS apps

## Summary

Make Serotine available as an installable Android app and an iPhone/iPad app, sharing the existing messaging experience and identities. Provide a signed Android APK, with TestFlight followed by an App Store release as the proposed Apple distribution route. This SIP describes a proposed direction; it does not implement the apps or commit to a release date.

## Motivation

Opening Serotine in a mobile browser adds friction around finding the app, transferring an identity, choosing files, and returning to a conversation. Installed apps would give Serotine a home-screen presence and access to platform features while retaining compatibility with people using the website.

An app package alone does not solve background delivery, identity migration, or mobile usability. Those behaviors should be designed explicitly so users know what installing the app actually provides.

## Proposal

### Installation and updates

| Platform | Initial distribution | Later distribution |
| --- | --- | --- |
| Android | Signed release APK from official Serotine GitHub Releases, with version, supported Android versions, checksum, and installation instructions | Google Play distribution using an Android App Bundle if pursued; retain an official APK route |
| iPhone and iPad | Signed iOS/iPadOS builds distributed through TestFlight | App Store release after review |

An IPA is the Apple app archive counterpart to an APK, but publishing an IPA download is not the general iPhone installation plan. Use Apple's signing and provisioning process for development builds and TestFlight for beta users. Apple's [TestFlight guide](https://developer.apple.com/testflight/) describes tester installation and external beta review; its [build-upload guide](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/) describes submission through App Store Connect.

Choose stable Android application and Apple bundle identifiers before the beta. Keep the bundled WebView origin stable across releases, or explicitly migrate stored state before changing it. Plan compatible signing certificates across direct APK and any later Play distribution so switching channels does not require uninstalling. An ordinary update should preserve the identity, conversations, file bank, and settings. Android release updates need a compatible signing identity and increasing version codes; protect the release key and document recovery rather than generating a new key each build. See [Android app signing](https://developer.android.com/studio/publish/app-signing).

Show the installed version and link to the official update channel. Direct APK updates go through Android's installer; Apple updates use TestFlight or the App Store. Do not replace bundled application code through an unreviewed remote update mechanism in the first version. Explain that uninstalling or clearing app data can remove local data, and provide encrypted export before the user chooses either.

### Shared mobile experience

Keep the compact conversation layout, dark/light/system appearance, contacts, private groups, message controls, media, GIFs, and existing encrypted messaging. Support narrow phones and the additional space on tablets without requiring hover. Back navigation, safe areas, keyboard resizing, text scaling, TalkBack, and VoiceOver should work naturally.

Use system file/photo pickers for attachments, native save/share actions for exports, and camera access for contact QR scanning. Request camera or microphone permission only when the corresponding action needs it. A cancelled or denied permission leaves chat usable.

Support sharing text, links, and files into Serotine from another app. Always show the destination conversation and a preview, then require an explicit Send; opening a share intent or extension must never transmit content by itself. Incoming contact links and QR scans likewise show a confirmation. Platform-specific share extensions may follow the first installable beta if necessary.

### Existing identities and desktop transfer

At first launch, offer **Create identity** and **Restore / link existing identity**. Browser storage and installed-app storage are separate: do not imply that an existing browser address or chat history will appear automatically.

Use the existing password-encrypted full backup to transfer an identity from desktop, Android, iPhone, or a browser. Import through a system file picker, validate the backup before changing the active identity, and preserve the existing confirmation/archive behavior when the app already has a different identity. A successful import retains the same public address, so contacts can continue messaging it.

Preserve existing backup exclusions, private-message rules, identity retirement, and linked-device limitations. The current file bank and drafts are not in backups; explain that these do not transfer unless a later backup-format change explicitly adds support. Import is not a new device-revocation system: linked clients still share an identity key. These behaviors are documented in the [application README](https://github.com/taco-jpg/serotine/blob/main/README.md).

Read previously stored history without a connection. Clearly distinguish offline, waiting to retry, relay accepted, delivered, and read states. Resume retained-event synchronization when the app becomes active or reconnects, without duplicating messages or losing pending sends. Do not promise recovery beyond the relay's retention window without a newer backup.

### Notifications and background behavior

The first beta may synchronize only while active, provided that limitation is visible. Treat closed-app notifications as a separate implementation milestone within this SIP: wrapping the website does not make its polling run indefinitely in the background.

Evaluate Android push delivery and Apple Push Notification service with authenticated device registration, token rotation/removal, and identity-switch cleanup. Notification permission is optional. Keep plaintext messages, contact names, private keys, and backup passwords out of provider payloads; prefer an opaque wake-up or generic activity signal. Any provider will still learn some device and timing metadata.

Default lock-screen alerts to generic wording. Preserve mute, block, archive, mention-only, message-request, and private-chat rules. If the client cannot safely determine whether an event is eligible for an alert while suspended, suppress the alert until it can, or revise the push design before claiming those rules are supported. Tapping an alert must resolve it against the current local identity.

Push is a hint to synchronize, not proof of delivery. Battery restrictions, suspension, force-stop, and permission denial need explicit testing; never promise uninterrupted background networking. Background voice/video calls remain coordinated with [SIP-3](SIP-3-voice-and-video-calling.md), not automatically enabled by installing the app.

## Security & Privacy

Store irreplaceable identity and history in native persistent storage rather than relying solely on WebView localStorage or IndexedDB; Capacitor documents [WebView storage eviction risks](https://capacitorjs.com/docs/guides/storage). Use app-private persistent storage and evaluate Android Keystore / Apple Keychain protection for the local encryption key that protects stored identity material. This must remain compatible with deliberate password-encrypted export; do not claim the shared identity key is hardware-bound or non-exportable.

Explicitly define OS cloud-backup and device-transfer exclusions for keys, plaintext messages, private content, and temporary shared files. Do not silently introduce an unencrypted backup path. Clean up decrypted preview/export staging files when no longer needed. Keep secrets and message contents out of logs and crash reports.

Limit any native bridge to the packaged trusted UI and narrowly defined actions. Open untrusted external pages outside that bridge. Validate incoming links and files, preserve attachment limits and integrity checks, and continue to reject untrusted HTML or scripts in messages.

Packaging does not add forward secrecy or change Serotine's endpoint trust model. Preserve existing encryption, ownership proofs, replay checks, and retirement enforcement. App signing protects the update chain; it does not make a compromised device or malicious application release safe.

## Compatibility

Android, iOS, and browser clients should exchange the same message/event and backup formats. Keep platform code behind small transport, storage, file, and lifecycle interfaces instead of creating a separate mobile protocol.

Retain compatibility with the web client and detect unsupported features. App releases can lag behind website deployments, so relay changes need a supported-client-version policy and a clear update prompt that does not strand locally stored data.

Other draft SIPs are not prerequisites for shipping the basic mobile clients. Native capabilities should not automatically be exposed to the proposed [plugin system](SIP-5-plugin-system.md).

## Alternatives

A progressive web app could provide installation-like convenience with less platform maintenance, but would not fulfill the requested APK and Apple app distribution. A full Kotlin/Swift rewrite gives deeper native control but duplicates substantial interface work. A wrapper that only loads the live website is another option, but gives less control over offline startup and executable updates.

## Open Questions

- Who owns the Android signing key, Apple Developer Program membership, distribution accounts, and ongoing release maintenance?
- Which Android/iOS versions, devices, and accessibility settings are supported at launch?
- Is Capacitor suitable after a prototype, or is another native shell needed?
- Which storage implementation preserves current backup behavior and survives app upgrades safely?
- Which push service and metadata tradeoffs are acceptable, and must background notifications ship before a public release?
- Should inbound sharing arrive in the initial beta on both platforms, or in the next milestone?

## Implementation Notes

Start by evaluating a bundled [Capacitor](https://capacitorjs.com/docs) client that reuses React components and TypeScript messaging logic, with separate Android and iOS projects. Keep the Next.js/OpenNext server and Cloudflare D1 relay hosted. The current server-enabled application cannot simply be copied into an APK or IPA as a running backend.

The [relay client](https://github.com/taco-jpg/serotine/blob/main/lib/relay-client.ts) uses same-origin requests, and the [relay route](https://github.com/taco-jpg/serotine/blob/main/app/api/relay/route.ts) validates request origin. A bundled client has a different origin. Prototype a constrained native HTTP adapter to an explicitly configured HTTPS relay, or a narrowly scoped mobile-origin policy, while retaining the browser endpoint's protections and all signed authentication. Do not globally relax CORS or remove ownership checks to make the wrapper work.

Plan Android SDK/Gradle builds and macOS/Xcode builds, with pinned toolchains, distinct development/release identifiers, and signing credentials outside the repository and artifacts. Before App Store submission, review the complete app against current Apple requirements; [minimum functionality](https://developer.apple.com/app-store/review/guidelines/#minimum-functionality) includes more than simply repackaging a website. Native sharing, reliable local history, and platform navigation are proposed product features, not a guarantee of approval.

Suggested milestones:

1. Prove packaged startup, authenticated relay access, storage persistence, and backup round trips on one real Android device and one real iPhone.
2. Ship signed Android and TestFlight betas with core messaging, mobile media controls, explicit background limitations, and an upgrade path.
3. Add and test inbound sharing and privacy-preserving notifications, then decide readiness for wider distribution.

Before accepting an implementation, verify:

- New install, same-address restore, wrong-password/corrupt-backup failure, existing-identity switch, process death, reboot, low-storage failure, and update all preserve the intended data or fail recoverably without silently replacing the identity.
- Browser, Android, and iOS clients exchange direct/group messages, attachments, and backups; private content stays excluded, expiry is applied before display on resume, and deleted history does not reappear.
- Offline/reconnect, duplicate events, interrupted uploads, relay retirement, and unsupported client versions behave correctly.
- Android Back, iPhone/iPad safe areas, on-screen keyboards, large text, screen readers, QR scanning, file pickers, and cancelled permissions work on physical devices.
- Share payloads require destination confirmation and Send; untrusted pages cannot invoke privileged native actions.
- Any claimed background alerts respect muted/blocked/private conversations and are tested under suspension, force-stop, token changes, identity changes, and disabled notifications.
- Release signatures and install-over-update behavior are checked, and builds contain no signing credentials, private user data, or development endpoints.
