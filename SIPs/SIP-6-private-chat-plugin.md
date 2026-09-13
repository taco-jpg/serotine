# SIP-6: Private chat plugin

- Status: Draft
- Type: Plugin / Privacy
- Requires: SIP-5

## Summary

Move the idea of Lark-style private or self-destructing chat into the plugin system rather than making it a permanently special core conversation type.

## Motivation

Private chat is useful, but it is optional behavior with stronger semantics than ordinary messaging. Treating it as a plugin keeps the base messenger simpler and gives Serotine room to evolve the feature without hard-coding one private-chat model forever.

## Proposal

- Implement Private Chat as a first-party Serotine plugin.
- Both participants must have a compatible version installed before shared private-chat semantics activate.
- If only one participant has the plugin, that participant may see local controls, but the peer must not be shown fake or unsupported private-chat behavior.
- The plugin may support expiration, local disappearance, reduced history retention, and explicit warnings about what cannot actually be recalled.
- Private-chat messages should still use Serotine's normal authenticated and encrypted transport underneath unless a future SIP specifies otherwise.
- Entering private mode should be explicit to both sides and visibly distinct from an ordinary chat.

## Safety semantics

The UI must not promise impossible guarantees. Expiration cannot erase screenshots, copied plaintext, downloaded files, compromised devices, or messages already captured by another participant.

Any destructive behavior should be narrowly defined: what disappears, from which device, and at what time.

## Migration

Serotine already has private-chat functionality in main. A future implementation may migrate that behavior behind the plugin interface rather than deleting it outright. Compatibility with existing private-chat messages should be preserved where practical.
