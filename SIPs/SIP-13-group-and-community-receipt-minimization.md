---
sip: 13
title: Group and community receipt minimization
author: louisliu
status: Draft
created: 2026-09-14
updated: 2026-09-14
---

# SIP-13: Group and community receipt minimization

## Summary

Stop producing durable per-recipient **delivered** and **read** receipts for private group chats and community text channels. Opening or reading a group/community message remains a local client state and must not generate a receipt event for every sender and recipient pair.

For the sender, a group/community message may still show **Pending**, **Sent**, or **Failed** based on the sender's own submission state. It must not show `Read by N`, `Delivered to N`, a per-member reader list, or equivalent metadata. Direct-message receipt behavior remains unchanged.

## Motivation

Per-recipient receipts are useful in a one-to-one conversation, where a single acknowledgement maps cleanly to the other participant. In a group or community channel they create a different product and systems cost:

- reading becomes participant-tracking metadata rather than a simple delivery hint;
- every message can produce receipt fan-out proportional to the number of recipients;
- retained receipt events consume relay storage, database rows, synchronization work, and client processing without carrying conversation content;
- a large reader count creates noisy UI and social pressure without reliably proving that anyone understood the message.

The existing application records `deliveredTo` and `readBy` data and can emit receipt events in group/community flows. This SIP removes that networked receipt layer for multi-person text conversations instead of merely hiding it in the UI.

## Proposal

### No durable multi-person receipts

For private group chats and community text channels:

- Do not emit a network event when a recipient merely receives, displays, scrolls past, or reads a message.
- Do not persist per-member `delivered` or `read` acknowledgements in the retained message relay.
- Do not synchronize `readBy`, `deliveredTo`, reader counts, or equivalent participant-level receipt metadata between members.
- Do not create a replacement aggregate receipt such as `12 people read this`; it has the same fan-out and privacy problem with a different presentation.
- Keep unread counts, last-read positions, and notification clearing local to the user's own client unless a later multi-device proposal explicitly defines a private synchronization mechanism.

This applies equally to ordinary text, replies, reactions, polls, and file messages. The presence of an attachment must not turn message reading into a durable social receipt.

### Sender state

A sender still needs to know whether its own operation succeeded. Use sender-local transport state:

| State | Meaning |
| --- | --- |
| Pending | The local client has not yet completed its submission attempt. |
| Sent | The sender's configured transport accepted the message for delivery. This does not mean every member received or read it. |
| Failed | The sender's submission failed and requires retry or another explicit action. |

For relay-backed conversations, **Sent** means accepted by the relay under the normal delivery contract. For a future direct-only mode, its own transport proposal may define a stronger acknowledgement without reintroducing multi-person reader tracking.

### Transport acknowledgements

Low-level acknowledgements needed for reliability are allowed only when they are transport-scoped, short-lived, and not exposed as participant reading metadata. For example, a file-transfer implementation may acknowledge chunks for integrity and retransmission. Such acknowledgements must not become retained `read` events or a durable history of which members opened a message.

### User interface

Remove multi-person receipt affordances from group and community messages. Do not show reader avatars, counts, `Read`, `Received by N`, or tooltips naming recipients.

The sender may see the local Pending/Sent/Failed state. Recipients keep normal local unread markers. Opening a conversation must not create visible activity for other members.

## Security & Privacy

This change reduces behavioral metadata. A member can still infer activity from replies, reactions, typing, calls, or other explicit actions, but merely reading a message no longer creates a durable receipt trail.

The proposal does not claim that a server cannot observe transport timing or that another participant cannot copy a message. It specifically removes application-level multi-person read/delivery receipts and their retained fan-out.

Transport retries and error reporting must not smuggle the same metadata back under a different event name. Receipt removal should be enforced in the shared group/community messaging paths, not only in rendering code.

## Compatibility

Direct-message receipts remain compatible with existing behavior.

New clients should tolerate historical group/community receipt events when rebuilding old local history, but they should not generate new ones. A sender must not treat the absence of multi-person receipts as a delivery failure. Older clients that still emit group/community receipts may be ignored by updated clients; capability negotiation may be used during transition if required to prevent retry loops.

Existing local unread state and notification behavior continue to work. Backups may contain older receipt metadata, but restoring a backup must not cause those receipts to be re-emitted.

## Alternatives

- **Hide receipts only in the UI:** leaves the privacy, row-count, synchronization, and fan-out costs in place.
- **Keep delivered receipts but remove read receipts:** reduces some tracking, but still creates one acknowledgement path per recipient and message. A sender-local Sent state is enough for the baseline multi-person product.
- **Make group receipts optional:** creates mixed expectations and still requires the full receipt protocol. A later explicit opt-in proposal can be evaluated if a strong use case appears.

## Open Questions

- Should local multi-device unread synchronization be introduced later through a user-private channel that is invisible to conversation participants?
- Which existing attachment-transfer acknowledgements are purely transport-level and can remain ephemeral after durable message receipts are removed?

## Implementation Notes

Audit both private-group and community paths. In particular, remove automatic receipt creation from visibility/read handlers, stop multi-person receipt events from entering the retained outbox, and remove `readBy`/`deliveredTo` from new group/community UI state where they are no longer required.

Tests should prove that opening or reading a group/community conversation creates **zero retained receipt events**, including after reload, file completion, reconnect, and history synchronization. Measure the resulting reduction in relay events and database operations separately from ordinary message traffic.
