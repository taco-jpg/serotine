# SIP-9: Force P2P mode

- Status: Draft
- Type: Transport / Privacy

## Summary

Add an optional mode that prefers or requires direct peer-to-peer transport for a conversation instead of the retained relay path.

## Current context

Serotine still contains a legacy direct WebRTC transport, while the current feature-rich conversation interface primarily uses the retained encrypted event relay for synchronization and delivery.

## Proposal

- Add a user-visible `Force P2P` conversation mode.
- When enabled, Serotine attempts direct peer-to-peer transport and clearly reports whether the direct path is actually established.
- In strict mode, if P2P cannot be established, Serotine should not silently fall back to the relay; sending should pause or fail with a clear explanation.
- A softer `Prefer P2P` mode may be considered separately, where fallback is allowed.
- Both peers should know when the conversation is currently direct versus relay-backed.
- Group-chat behavior can be deferred until the direct transport model for more than two participants is clear.

## Compatibility

Force P2P should not create a second incompatible message format. Where practical, the same encrypted message/event representation should travel over either transport.

Features that fundamentally depend on relay retention or multi-device catch-up may be unavailable or degraded in strict P2P mode; the UI should make that tradeoff explicit.

## Security note

P2P changes transport and metadata exposure, not the trust model of the endpoint. It does not by itself add forward secrecy, anonymity, or protection against a compromised client.
