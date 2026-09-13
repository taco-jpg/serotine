---
sip: 9
title: Force P2P mode
author: louisliu
status: Draft
created: 2026-09-12
---

# SIP-9: Force P2P mode

## Summary

Add an optional mode that prefers or requires direct peer-to-peer transport for a conversation instead of the retained relay path.

## Motivation

Serotine still contains a legacy direct WebRTC transport, while the current feature-rich conversation interface primarily uses the retained encrypted event relay for synchronization and delivery. Some users may prefer a direct path for specific conversations, especially when they want to avoid retained relay delivery and accept the tradeoffs that come with stricter peer-to-peer operation.

## Proposal

- Add a user-visible `Force P2P` conversation mode.
- When enabled, Serotine attempts direct peer-to-peer transport and clearly reports whether the direct path is actually established.
- In strict mode, if P2P cannot be established, Serotine should not silently fall back to the relay; sending should pause or fail with a clear explanation.
- A softer `Prefer P2P` mode may be considered separately, where fallback is allowed.
- Both peers should know when the conversation is currently direct versus relay-backed.
- Group-chat behavior can be deferred until the direct transport model for more than two participants is clear.

## Security & Privacy

P2P changes transport and metadata exposure, not the trust model of the endpoint. It does not by itself add forward secrecy, anonymity, or protection against a compromised client.

Direct peer-to-peer transport may expose network-address metadata between participants. The UI should not imply that direct transport is automatically more private in every threat model.

## Compatibility

Force P2P should not create a second incompatible message format. Where practical, the same encrypted message/event representation should travel over either transport.

Features that fundamentally depend on relay retention or multi-device catch-up may be unavailable or degraded in strict P2P mode; the UI should make that tradeoff explicit. Unsupported clients should continue to use ordinary relay-backed messaging rather than misrepresenting a direct connection.

## Alternatives

Use the retained relay exclusively. This preserves the current delivery and synchronization behavior but offers no strict direct-only option. Another alternative is `Prefer P2P`, which attempts a direct path while allowing relay fallback and therefore provides weaker transport guarantees but better availability.

## Open Questions

- Should `Force P2P` and `Prefer P2P` both exist?
- How should linked devices behave when a strict P2P conversation is active?
- Which relay-dependent features should be disabled or visibly degraded?
- What connection metadata should the UI expose to explain the active transport accurately?

## Implementation Notes

Reuse the existing encrypted message/event representation where possible and keep transport selection separate from message semantics. Verify strict no-fallback behavior, direct-path state reporting, reconnect behavior, and unsupported-client handling across real network conditions.
