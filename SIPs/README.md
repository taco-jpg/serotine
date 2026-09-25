# SIP Index

Serotine Improvement Proposals live in this directory.

Status review: **2026-09-19**, against merged application `main` at [9a1473d](https://github.com/taco-jpg/serotine/commit/9a1473d6038a13e5099d94173488e74f2a744314). The implementation of [SIPs 8, 9, and 11–18](https://github.com/taco-jpg/serotine/pull/67) is awaiting merge and deployment validation. These proposals remain Accepted.

| SIP | Title | Status | Implementation / remaining work |
| --- | --- | --- | --- |
| [SIP-1](SIP-1-public-communities-and-channels.md) | Public communities and channels | Final | Invitation communities, channels, moderation, ownership controls, and rich messaging merged in [#48](https://github.com/taco-jpg/serotine/pull/48), [#49](https://github.com/taco-jpg/serotine/pull/49), [#53](https://github.com/taco-jpg/serotine/pull/53), and [#54](https://github.com/taco-jpg/serotine/pull/54). Public discovery remains a later stage. |
| [SIP-2](SIP-2-expanded-and-custom-themes.md) | Expanded and custom themes | Final | Presets, custom editor, local saving, and data-only import/export merged in [#50](https://github.com/taco-jpg/serotine/pull/50), with refinements in [#52](https://github.com/taco-jpg/serotine/pull/52) and [#54](https://github.com/taco-jpg/serotine/pull/54). |
| [SIP-3](SIP-3-voice-and-video-calling.md) | Voice and video calling | Accepted | Direct calls, group calls, and community voice channels merged in [#58](https://github.com/taco-jpg/serotine/pull/58) and [#59](https://github.com/taco-jpg/serotine/pull/59). Working production TURN and physical-device calls across different networks still need verification before Final. |
| [SIP-4](SIP-4-favicon-and-unread-badge.md) | Favicon and unread badge | Draft | Dynamic tab favicon/unread badge is not implemented; in-app unread counts are separate. |
| [SIP-5](SIP-5-plugin-system.md) | Plugin system | Final | The first-party plugin foundation was merged in [PR #66](https://github.com/taco-jpg/serotine/pull/66). |
| [SIP-6](SIP-6-private-chat-plugin.md) | Private chat plugin | Final | The Private Chat plugin migration was merged in [PR #66](https://github.com/taco-jpg/serotine/pull/66). |
| [SIP-7](SIP-7-ai-summary-plugin.md) | AI summary plugin | Accepted | Consented preview/summary workflow and Workers AI adapter merged in [#66](https://github.com/taco-jpg/serotine/pull/66). AI remains disabled by default; a live provider request still needs deployment verification. |
| [SIP-8](SIP-8-share-selected-messages.md) | Share selected messages | Accepted | Implemented: previewed selected-message copies, at most 20 messages/8,000 fallback characters; attachment metadata only. |
| [SIP-9](SIP-9-force-p2p-mode.md) | Force P2P mode | Accepted | Implemented: authenticated direct-only text and files up to 2 MiB, with no relay/TURN fallback. Physical-device cross-network connectivity remains unverified. |
| [SIP-10](SIP-10-android-and-ios-apps.md) | Android, iOS, Windows, and macOS apps | Accepted | Initial bundled mobile/desktop implementation in [draft PR #69](https://github.com/taco-jpg/serotine/pull/69): native persistence, constrained transport, backup dialogs and build/signing workflows. Platform builds, physical-device qualification, signing and distribution remain pending; not a released app. |
| [SIP-11](SIP-11-custom-user-avatars.md) | Custom user avatars | Accepted | Implemented: bounded static/GIF avatars, local processing, still fallback, and SIP-12 per-friend visibility. |
| [SIP-12](SIP-12-custom-profiles-and-per-friend-sharing.md) | Custom profiles and per-friend sharing | Accepted | Implemented: six private-by-default profile fields, per-friend grants, revocation, and six-day permissions requiring explicit renewal. |
| [SIP-13](SIP-13-group-and-community-receipt-minimization.md) | Group and community receipt minimization | Accepted | Implemented: no new group/community social receipts; local submission/unread state remains, and DM receipts are unchanged. |
| [SIP-14](SIP-14-explicit-group-invitations-and-invalidation.md) | Explicit group invitations and terminal invalidation | Accepted | Implemented: signed acceptance, seven-day pending invites, revoke/decline, consent-preserving legacy migration, and terminal dissolution. |
| [SIP-15](SIP-15-server-side-conversation-lifecycle-purging.md) | Server-side conversation lifecycle purging | Accepted | Implemented: authenticated retention scopes, terminal submission fences, and retryable relay/file cleanup. Deployed cleanup still needs verification. |
| [SIP-16](SIP-16-unified-product-design-and-motion.md) | Unified product design and motion | Accepted | Implemented: shared semantic design/motion tokens, theme continuity, and reduced-motion support across landing/app surfaces. |
| [SIP-17](SIP-17-stable-conversation-ordering-and-list-motion.md) | Stable conversation ordering and list motion | Accepted | Implemented: message/creation-based ordering, stable ties, separate route restoration, and keyed row motion. |
| [SIP-18](SIP-18-ephemeral-attachment-delivery.md) | Ephemeral attachment delivery | Accepted | Implemented: verified durable-receipt cleanup; seven-day DM/group and 30-day community file expiry. No guaranteed redownload after local cache loss. |

The implementation summaries for SIPs 8, 9, and 11–18 describe the implementation PR above, not merged or deployed behavior. Local unit tests, synthetic browser scenarios, and local workerd/D1/R2 checks exercise protocol, UI, and storage behavior. They do not certify live Workers AI, production cleanup execution, or P2P/calling between physical devices on different networks. See the [implementation and deployment guide](https://github.com/taco-jpg/serotine/blob/feat/sip-8-18/docs/SIP-8-18.md).

Use the [status definitions](../STATUS.md). Final applies to the documented implemented scope; later extensions stay separate. Accepted does not certify a production release, and Draft does not mean a feature has been approved or implemented. This review checks repository evidence, not the current live deployment.

When adding one, use a filename like:

`SIP-19-example-title.md`

The repository root contains the process, format, status definitions, and template.
