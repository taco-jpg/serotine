---
sip: 8
title: Share selected messages
author: louisliu
status: Accepted
created: 2026-09-12
updated: 2026-09-19
---

# SIP-8: Share selected messages

## Implementation status — 2026-09-19

Implemented in [PR #67](https://github.com/taco-jpg/serotine/pull/67); awaiting merge and deployment validation. Selected messages become a new signed encrypted copy after a preview and destination confirmation. Bundles contain at most 20 messages and an 8,000-character fallback. Private, secret, expiring, moderator-hidden, pending, failed, deleted, and already-shared messages are excluded. Attachments contribute name/type/size only; bytes, download capabilities, keys, local aliases, and optional profile fields are never copied. Polls become question/options snapshots without voter identities. Original edits or deletion do not alter a shared copy. Older direct/group clients can display the fallback; strict older community clients require an update.

## Summary

Allow a user to select several existing messages and share them into another Serotine conversation as one structured bundle.

## Motivation

Forwarding several related messages as separate bubbles loses context and creates noise. A structured bundle makes it easier to share a useful excerpt while keeping the selected messages together and making it clear that the recipient is seeing a copy rather than gaining access to the source conversation.

## Proposal

- Add multi-select mode for messages.
- The user can choose one or more messages and select Share.
- The destination receives a compact message such as `Louis shared 4 messages` rather than four unrelated forwarded bubbles.
- Opening the shared bundle reveals the selected messages in order with enough context to understand who originally sent each one.
- Preserve text, basic timestamps, sender labels, and safe attachment references where possible.
- Do not silently expose messages from a conversation the user did not explicitly select.
- Sharing should create a new message/event; it must not grant the recipient access to the source conversation.

Selection should work on desktop and mobile. The first version can prioritize a simple checkbox/selection toolbar over advanced drag selection.

## Security & Privacy

The UI should distinguish a shared copy from the original conversation. It should not imply cryptographic proof that the quoted content is unchanged unless Serotine explicitly adds such verification later.

Attachments should follow normal Serotine attachment rules. If an attachment cannot be re-shared safely, the bundle can show metadata without the file. Sharing must include only the explicitly selected messages and their necessary display context.

## Compatibility

Older clients that do not understand structured shared bundles should fail safely. Where practical, the event should degrade to a readable fallback rather than breaking the conversation. Sharing must not change access permissions on the source conversation or existing stored messages.

## Alternatives

Forward each selected message individually. This is simpler but produces noisy output and weakens the relationship between messages. Another option is to generate a screenshot or text export, but that loses structure and attachment semantics.

## Open Questions

- Which sender and timestamp metadata should be preserved exactly?
- Should nested shared bundles be allowed?
- How should edited or deleted source messages affect an already shared copy?
- Which attachment types can be safely re-shared in the first version?

## Implementation Notes

Define a compact structured payload with an explicit fallback representation. Verify desktop/mobile selection, destination confirmation, ordering, attachment handling, and behavior on unsupported clients.
