---
sip: 6
title: Private chat plugin
author: louisliu
status: Final
created: 2026-09-12
updated: 2026-09-19
---

# SIP-6: Private chat plugin

## Implementation status — 2026-09-19

The Private Chat plugin migration was merged in [PR #66](https://github.com/taco-jpg/serotine/pull/66). Both peers explicitly enable the plugin and complete a fresh signed capability exchange before new private sends. Existing expiry/destruction handling continues after disable. Timers are 5 minutes, 1 hour, or 24 hours, measured from sending. See the [usage and privacy guide](https://github.com/taco-jpg/serotine/blob/main/docs/SIP-5-7-plugins.md).

## Summary

Move the idea of Lark-style private or self-destructing chat into the plugin system rather than making it a permanently special core conversation type. This proposal depends on SIP-5.

## Motivation

Private chat is useful, but it is optional behavior with stronger semantics than ordinary messaging. Treating it as a plugin keeps the base messenger simpler and gives Serotine room to evolve the feature without hard-coding one private-chat model forever.

## Proposal

- Implement Private Chat as a first-party Serotine plugin.
- Both participants must have a compatible version installed before shared private-chat semantics activate.
- If only one participant has the plugin, that participant may see local controls, but the peer must not be shown fake or unsupported private-chat behavior.
- The plugin may support expiration, local disappearance, reduced history retention, and explicit warnings about what cannot actually be recalled.
- Private-chat messages should still use Serotine's normal authenticated and encrypted transport underneath unless a future SIP specifies otherwise.
- Entering private mode should be explicit to both sides and visibly distinct from an ordinary chat.

## Security & Privacy

The UI must not promise impossible guarantees. Expiration cannot erase screenshots, copied plaintext, downloaded files, compromised devices, or messages already captured by another participant.

Any destructive behavior should be narrowly defined: what disappears, from which device, and at what time. Plugin negotiation must not weaken the underlying authenticated and encrypted transport.

## Compatibility

Serotine already has private-chat functionality in main. A future implementation may migrate that behavior behind the plugin interface rather than deleting it outright. Compatibility with existing private-chat messages should be preserved where practical.

Clients without a compatible plugin must continue to handle ordinary conversation history safely and must not falsely present private-chat guarantees.

## Alternatives

Keep private chat as a permanently special core conversation type. This avoids plugin negotiation but makes the behavior harder to evolve independently. Another alternative is local-only message hiding, which is simpler but does not provide shared expiration semantics.

## Open Questions

- Which private-chat behaviors belong in the first plugin version?
- How should existing private-chat conversations migrate to the plugin model?
- How are expiration and deletion states synchronized across linked devices?

## Implementation Notes

Requires SIP-5. Reuse existing private-chat behavior where it maps cleanly, but place new shared semantics behind explicit plugin capability negotiation.
