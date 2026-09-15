# SIP Index

Serotine Improvement Proposals live in this directory.

Status review: **2026-09-14**, against application `main` at [801f09a](https://github.com/taco-jpg/serotine/commit/801f09a69f8761b35d31285b2f2089d6a01959c0).

| SIP | Title | Status | Implementation / remaining work |
| --- | --- | --- | --- |
| [SIP-1](SIP-1-public-communities-and-channels.md) | Public communities and channels | Final | Invitation communities, channels, moderation, ownership controls, and rich messaging merged in [#48](https://github.com/taco-jpg/serotine/pull/48), [#49](https://github.com/taco-jpg/serotine/pull/49), [#53](https://github.com/taco-jpg/serotine/pull/53), and [#54](https://github.com/taco-jpg/serotine/pull/54). Public discovery remains a later stage. |
| [SIP-2](SIP-2-expanded-and-custom-themes.md) | Expanded and custom themes | Final | Presets, custom editor, local saving, and data-only import/export merged in [#50](https://github.com/taco-jpg/serotine/pull/50), with refinements in [#52](https://github.com/taco-jpg/serotine/pull/52) and [#54](https://github.com/taco-jpg/serotine/pull/54). |
| [SIP-3](SIP-3-voice-and-video-calling.md) | Voice and video calling | Accepted | Direct calls, group calls, and community voice channels merged in [#58](https://github.com/taco-jpg/serotine/pull/58) and [#59](https://github.com/taco-jpg/serotine/pull/59). Working production TURN and physical-device calls across different networks still need verification before Final. |
| [SIP-4](SIP-4-favicon-and-unread-badge.md) | Favicon and unread badge | Draft | Dynamic tab favicon/unread badge is not implemented; in-app unread counts are separate. |
| [SIP-5](SIP-5-plugin-system.md) | Plugin system | Draft | Plugin loading, permissions, lifecycle, and extension API are not implemented. |
| [SIP-6](SIP-6-private-chat-plugin.md) | Private chat plugin | Draft | Built-in private chats exist ([#40](https://github.com/taco-jpg/serotine/pull/40)); migration into a compatible plugin still depends on SIP-5. |
| [SIP-7](SIP-7-ai-summary-plugin.md) | AI summary plugin | Draft | Summary workflow/provider integration and the SIP-5 plugin foundation are not implemented. |
| [SIP-8](SIP-8-share-selected-messages.md) | Share selected messages | Draft | Selected-message bundles and their preview/import flow are not implemented; existing file and access-key sharing do not fulfill this SIP. |
| [SIP-9](SIP-9-force-p2p-mode.md) | Force P2P mode | Draft | Direct-only messaging with persistent no-relay restrictions is not implemented. Existing direct connections do not provide that guarantee. |
| [SIP-10](SIP-10-android-and-ios-apps.md) | Android and iOS apps | Draft | Native app packages, signing, and distribution are not implemented in the application repository. |
| [SIP-11](SIP-11-custom-user-avatars.md) | Custom user avatars | Draft | Custom avatar upload, profile storage, and synchronization are not implemented. SIP-12 is a related draft, not an adopted replacement. |
| [SIP-12](SIP-12-custom-profiles-and-per-friend-sharing.md) | Custom profiles and per-friend sharing | Draft | Profile editor, GIF banners/pictures, and per-friend field permissions are not implemented. |
| [SIP-13](SIP-13-group-and-community-receipt-minimization.md) | Group and community receipt minimization | Draft | Stop durable per-recipient delivered/read receipts in multi-person text conversations while preserving sender-local send state. |
| [SIP-14](SIP-14-explicit-group-invitations-and-invalidation.md) | Explicit group invitations and terminal invalidation | Draft | Make private-group membership require explicit acceptance, keep pending invitees outside active membership, and invalidate invitations when the group is dissolved. |
| [SIP-15](SIP-15-server-side-conversation-lifecycle-purging.md) | Server-side conversation lifecycle purging | Draft | Purge retained relay/storage data when a DM relationship is removed or a group/community is terminally deleted, with minimal replay-prevention state. |
| [SIP-16](SIP-16-unified-product-design-and-motion.md) | Unified product design and motion | Draft | Unify landing and authenticated-app design language and add restrained, shared motion without replacing SIP-2 theming. |
| [SIP-17](SIP-17-stable-conversation-ordering-and-list-motion.md) | Stable conversation ordering and list motion | Draft | Stop local navigation from promoting a conversation to the top; reorder only for real activity and preserve spatial continuity. |
| [SIP-18](SIP-18-ephemeral-attachment-delivery.md) | Ephemeral attachment delivery | Draft | Treat server attachment storage as a temporary delivery buffer: purge verified DM attachments promptly, purge group attachments after required recipients receive them or expiry, and bound community retention. |

Use the [status definitions](../STATUS.md). Final applies to the documented implemented scope; later extensions stay separate. Accepted does not certify a production release, and Draft does not mean a feature has been approved or implemented. This review checks repository evidence, not the current live deployment.

When adding one, use a filename like:

`SIP-19-example-title.md`

The repository root contains the process, format, status definitions, and template.
