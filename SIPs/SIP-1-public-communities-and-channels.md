---
sip: 1
title: Public communities and channels
author: sodium-qed
status: Final
created: 2026-09-12
updated: 2026-09-14
---

# SIP-1: Public communities and channels

## Summary

Serotine supports opt-in communities joined through a shared invitation link or QR code, with multiple channels under one membership. The invitation-based stage is implemented, including moderation, co-owners, ownership transfer, deletion, and rich channel messaging. Final applies to this implemented scope; a public discovery directory remains a later stage.

## Motivation

A club, project team, or larger friend group benefits from one shared space with separate conversations for announcements, general discussion, and projects. Creating unrelated group chats makes joining and membership management repetitive.

The [current application documentation](https://github.com/taco-jpg/serotine/blob/main/README.md#conversations) describes creator-managed groups of up to twenty people. Communities would introduce a broader joining and organization model, rather than merely changing that limit.

## Proposal

### Joining and visibility

A community has a name, description, owner, members, and channels. Its owner chooses whether a valid invitation permits joining directly or requires approval. Opening a link or scanning a QR code shows a preview and an explicit Join or Request to join action. The UI confirms membership only after an authorized membership update succeeds.

Keep these access choices distinct:

| Access | Intended behavior |
| --- | --- |
| Shared invitation | Anyone holding a valid link can attempt to join under the owner's chosen admission policy; the community is unlisted. |
| Approval required | A valid invitation allows a request, which an authorized administrator must approve. |
| Public discovery | A later, separately enabled listing exposes selected community information so people can find it without receiving a link. |

Owners can revoke invitations and pause joining. A QR code carries the same invitation as its corresponding link, not a private identity key. Publishing a community listing does not automatically publish its messages or member addresses.

### Channels and administration

Members join the community once and can open its shared text channels. Start with a small owner-defined set; an announcements channel may restrict posting to administrators. Support channel unread indicators and notification controls without forcing an expanded sidebar or changing message density.

Provide owner and moderator responsibilities, member removal, bans, invitation management, and a way to report a message to moderators. Any moderator action affecting other members must be authenticated and checked against the current permissions. Moderated-message hiding applies to cooperating clients and cannot erase retained copies.

The primary owner can assign co-owners, transfer ownership, and delete the community. Co-owners can manage settings, channels, moderators, and ordinary members; their commands are processed by the primary owner's client. Ownership transfer and deletion remain primary-owner actions. Communities appear in the Inbox and support files, voice notes, GIFs, replies, mentions, editing, local deletion, pins, polls, search, and saved drafts.

### History and delivery stages

Newcomers receive messages sent after admission. Sharing earlier history needs a separate explicit policy and design. Leaving or removal stops future delivery under the updated membership; it does not recall previously received content.

Invitation-based membership, administration, and channels are implemented. Public discovery remains a later decision once active communities and moderation needs justify it. Community voice channels were subsequently added under [SIP-3](SIP-3-voice-and-video-calling.md), whose calling rollout checks remain open. Bots, elaborate role hierarchies, and unlimited membership remain outside this scope.

## Security & Privacy

Public joining widens who may become a recipient. Encryption does not stop admitted members from copying messages. Clearly show the admission policy and history visibility before joining and inside community settings.

Community support preserves authenticated membership changes and encrypted member messaging. Shared invitation previews expose the metadata described in the [implementation protocol](https://github.com/taco-jpg/serotine/blob/main/docs/SIP-1-communities.md), without including the member roster, message history, or private keys. A future discovery directory needs its own explicit disclosure policy. Existing private groups remain separate and are not converted automatically.

Community events use signed v3 envelopes, owner-signed state and membership epochs, invitation generation/expiry checks, and current-permission validation. Stale queued traffic is checked against membership before transmission. Revocation takes effect as clients synchronize and cannot recall content already sent. Admission controls and bounded requests limit abuse; with device-local identities, banning one address does not guarantee that the person cannot create another.

## Compatibility

Keep existing direct chats and private groups working without automatic migration. Older clients should show an unsupported-feature state or reject unsupported community events safely. Do not weaken admission or permissions to accommodate them.

Community delivery uses a separately encrypted copy for each recipient, which the relay stores and forwards. The implemented limits are 20 members and eight channels per community. These bounds do not promise large-scale server capacity.

## Alternatives

- Add join links to existing groups only: smaller scope, but leaves topic organization unresolved.
- Launch channels and discovery together: broader functionality, with greater delivery and moderation complexity before demand is established.

## Implemented decisions and follow-ups

- Both direct invitation admission and owner approval are supported. The primary owner's client processes admission and administrative commands; requests wait while it is offline. Retry admission recovers a stalled confirmation.
- Signed state, membership epochs, an ownership-transfer chain, and terminal deletion records govern changes. Transferring ownership revokes prior invitations and requires pending applicants to use a new invitation.
- New members receive post-admission messages. Sharing pre-join history remains future work.
- Public discovery and its listing moderation remain open design questions.

## Implementation Notes

Implemented in [PR #48](https://github.com/taco-jpg/serotine/pull/48), with ownership controls in [#49](https://github.com/taco-jpg/serotine/pull/49), admission recovery in [#53](https://github.com/taco-jpg/serotine/pull/53), and rich messaging/Inbox integration in [#54](https://github.com/taco-jpg/serotine/pull/54). These merged changes document automated and browser checks for membership, permissions, ownership, messaging, and mobile layouts.

The [implementation protocol](https://github.com/taco-jpg/serotine/blob/main/docs/SIP-1-communities.md) records invitation and event formats, serialized owner authority, and synchronization limitations. Status reviewed against application `main` on 2026-09-14.
