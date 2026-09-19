---
sip: 9
title: Force P2P mode
author: louisliu
status: Accepted
created: 2026-09-12
updated: 2026-09-19
---

# SIP-9: Force P2P mode

## Implementation status — 2026-09-19

Implemented in [PR #67](https://github.com/taco-jpg/serotine/pull/67); awaiting merge and deployment validation. Force P2P supports accepted one-to-one contacts who both enable it and keep Serotine open. Sending requires an authenticated direct connection; conversation payloads never fall back to the message relay, attachment storage, or TURN. Signed setup records expire after 60 seconds; STUN and setup metadata remain permitted. Direct files have a 2 MiB cap, bounded chunks, progress, cancellation, integrity checks, and authenticated acknowledgement. Routing restrictions survive retries, mode changes, and backup restore. Direct-only history stays excluded from AI summaries. Local unit/browser checks cover routing and failure behavior; physical devices on different networks must still demonstrate actual P2P connectivity before rollout.

## Summary

Add **Force P2P** as an explicit messaging delivery choice alongside the existing relay-backed default. In this mode, two people exchange encrypted messages and small files directly while both have Serotine open and connected. Conversation content never enters the message relay, attachment storage, or TURN. If a direct connection cannot be established, sending stays unavailable; Serotine never silently falls back to a relay.

Start with basic one-to-one messaging. Smaller file limits and fewer relay-dependent features are acceptable tradeoffs for reducing server traffic and storage.

## Motivation

Sending conversation content through servers uses bandwidth and storage even when both people are online and could communicate directly. This proposal restores the direct-communication approach described in the supplied discussion about Serotine's earlier design, while giving users an explicit choice about delivery guarantees.

The goal is **no server-relayed message or file payloads for these conversations**. It is not a promise of zero total server cost: app hosting, connection setup, presence, and STUN may still involve services. A separate setup without Serotine-hosted signaling is a possible later extension.

## Proposal

### Delivery mode and connection agreement

- Offer **Force P2P** as an explicit conversation choice. Preserve the existing modes and default.
- Explain before activation: **“Both people must have Serotine open and connected. Messages and files travel directly. Offline delivery is unavailable, and the other person may learn your network address.”**
- Both clients must support and agree to direct-only delivery before content is exchanged. Neither client can override the other's relay-only privacy preference.
- Advertised presence is a hint. Sending requires an authenticated, working direct connection.
- Show **Connecting directly**, **Connected directly**, **Peer unavailable**, or **Direct connection failed**, with a readable reason where known. Do not show “Connected directly” merely because a peer is online.
- If either client lacks support or the peers disagree about routing, explain the incompatibility and keep sending disabled. An explicit change to another mode is a separate user decision.

### No relay fallback

While Force P2P is active:

- Messages, attachments, thumbnails, reactions, receipts, edits, deletion events, and any other conversation payload supported in this mode travel only over the direct connection.
- Do not enqueue these payloads for the retained event relay, upload them to server attachment storage, or send them through TURN.
- Automatic retry, reconnect, history synchronization, backups, and other devices must not later upload content created under the direct-only policy.
- Connection failure pauses or fails delivery. Do not offer a misleading success state or automatically retry through a relay.
- Changing modes cannot automatically release pending direct-only messages or files to a relay. Keep their routing restriction; the sender must explicitly choose to resend any such item under a different mode.

Tiny, short-lived, authenticated connection-setup messages may pass through a signaling service. They contain negotiation data, not chat text, file content, or a disguised offline mailbox. TURN relays WebRTC traffic and is excluded even though its payload is encrypted. Signaling, STUN, and TURN serve different purposes; allowing setup assistance does not authorize payload relay. See the [WebRTC peer-connection guide](https://webrtc.org/getting-started/peer-connections).

### Online-only delivery and interruptions

| Situation | Expected behavior |
| --- | --- |
| Both clients are open and a direct connection succeeds | Allow direct text and supported file transfers. |
| Recipient is offline, suspended, or unreachable | Keep the composition as a local unsent draft; no server queue or offline delivery. |
| Both appear online but their networks block a direct path | Show a direct-connection failure and keep the content unsent. |
| Connection drops before receipt is acknowledged | Show delivery as unconfirmed; retry directly with the same message ID and suppress duplicates. |
| File transfer is interrupted | Mark it incomplete and allow a direct retry when both peers reconnect. |
| A peer returns later | Establish a fresh direct connection; local drafts require a send action. There is no relay mailbox to collect. |

The sender must also be connected when delivery happens. Previously received local history remains readable offline. A suspended browser is not guaranteed to remain reachable. A message is “delivered” only after the recipient's authenticated acknowledgement; a file is complete only after receipt and integrity verification.

### Basic feature set and smaller limits

The first version supports accepted one-to-one contacts, encrypted text, and small file/image attachments. Group chats, communities, live multi-device catch-up, offline push delivery, and voice/video changes are outside this version. Unsupported features should be visibly unavailable in this mode.

Use a separate, lower per-file limit for Force P2P, displayed before selection and enforced before transfer and on receipt. The first implementation sets this cap to 2 MiB; cross-network physical-device validation remains a separate release check. Limit concurrent transfers and bound memory buffers, with progress and cancellation controls. A file above the cap stays local and gets a clear explanation; it is never uploaded automatically.

A smaller cap is a product limit for resource use and reliability, not a WebRTC requirement. Direct transfers can be fast or slow depending on both connections and devices; smaller caps alone do not ensure speed.

### Later option without hosted signaling

Explore manual, authenticated connection-info exchange, such as a copyable invitation or QR-assisted flow, so a basic session can start without Serotine's signaling service. This is separate follow-up work: exchanging offers, answers, and candidates, preserving identity authentication, and reconnecting require more design.

That option must disclose any remaining STUN or other service dependency. Removing signaling or STUN does not guarantee that two arbitrary networks can connect; see the [WebRTC TURN guidance](https://webrtc.org/getting-started/turn-server). It also does not eliminate the cost of serving the application.

## Security & Privacy

Keep Serotine's existing contact identity checks and application encryption. Authenticate negotiation data and bind it to the intended peers, session, and direct-only policy, so an intermediary cannot silently substitute an endpoint or change the route.

Direct connections can expose network addresses to the other participant. P2P does not itself add anonymity, forward secrecy, or protection against compromised endpoints. Signaling/STUN operators may still see connection metadata. Setup records should expire promptly and logs should omit negotiation payloads and addresses.

Force P2P controls delivery, not message expiry. It does not erase history already stored on a relay before activation or make a conversation self-destructing. Any compatible private-chat settings continue to apply.

## Compatibility

Reuse existing encrypted event formats where practical, with explicit capability negotiation and persistent routing metadata. Older clients may continue ordinary conversations, but cannot participate in Force P2P or receive its content through an automatic fallback.

Apply the policy in shared transport and synchronization code, not only in the composer. Switching an existing conversation requires a clear boundary: show any earlier relay submissions as earlier traffic, quiesce outgoing work, and establish agreement before new direct-only sends. A second device cannot silently override that agreement.

Local backups may preserve eligible received history according to existing retention rules, but must preserve direct-only restrictions on restore. Restoring a backup must never replay that history into the relay. Local history viewing is not live synchronization.

## Alternatives

**Prefer P2P:** Attempt direct transport and allow relay fallback. This may improve availability and reduce traffic, but is a separate proposal because it cannot provide Force P2P's no-fallback guarantee.

**Relay-only:** Keep current retained delivery and catch-up behavior for users who need it.

**Manual setup from the first release:** Avoid hosted signaling immediately, at the cost of a harder setup and recovery flow. Defer this until the basic direct-only mode is usable.

## Open Questions

- What smaller file cap, transfer concurrency, and reconnect timeout work reliably on supported phones and browsers?
- Which optional message features can reuse the direct transport without introducing relay dependencies?
- How should a later version support multiple devices or groups while preserving each participant's routing choice?
- What manual pairing flow would make the later signaling-independent option practical?

## Implementation Notes

WebRTC has no built-in `iceTransportPolicy: "direct-only"`; the standard policies are `all` and `relay`. Configure both clients without TURN servers, reject relay candidates in both initial session descriptions and later candidate updates, and verify the selected candidate pair before sending content and after route changes. If the client cannot establish that the path meets the policy, sending remains blocked. See the [W3C WebRTC specification](https://www.w3.org/TR/webrtc/).

Use chunked file transfer with backpressure instead of treating an entire file as one data-channel message. Chunk size must respect the negotiated data-channel message limit; that limit differs from the product's total file-size cap.

Before implementation is accepted, verify:

- Successful direct text and file delivery between real devices on different networks.
- Offline peers, suspended tabs, blocked direct paths, and unsupported clients produce clear states and no payload relay.
- TURN configuration, relay candidates, connection restarts, and mid-transfer drops cannot bypass the policy.
- No message, attachment, or derived event reaches relay storage during send, retry, reload, mode changes, backup restore, or second-device use.
- Duplicate retries, acknowledgements, file integrity, cancellation, and advertised limits behave correctly.
- A local or same-network test is not presented as proof of universal direct connectivity.

Measure the reduction in relay payload bytes and storage separately from remaining signaling traffic. The feature is implemented on the branch linked above and remains **Accepted** pending merge and deployment validation. Keep the real-device, distinct-network acceptance check separate from local browser results.
