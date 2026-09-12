---
sip: 1
title: Public communities and channels
author: sodium-qed
status: Draft
created: 2026-09-12
---

# SIP-1: Public communities and channels

## Summary

Add opt-in communities that people can join through a shared invitation link or QR code, with multiple text channels under one membership. Consider a public discovery directory as a later stage. This draft records the idea and a suggested starting scope; it does not approve implementation or settle the protocol.

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

### History and delivery stages

The proposed default is that newcomers receive messages sent after admission. Sharing earlier history needs a separate explicit policy and design. Leaving or removal stops future delivery under the updated membership; it does not recall previously received content.

Build invitation-based membership and basic controls first, then channels. Keep public discovery as a later decision once active communities and moderation needs justify it. Voice rooms, bots, elaborate role hierarchies, and unlimited membership are outside the initial scope.

## Security & Privacy

Public joining widens who may become a recipient. Encryption does not stop admitted members from copying messages. Clearly show the admission policy and history visibility before joining and inside community settings.

Community support should preserve authenticated membership changes and encrypted member messaging. Public previews and any directory intentionally expose some metadata; specify exactly which fields. Private groups must remain private unless their owner explicitly chooses a supported conversion.

Invitation validation, replay protection, permission changes, removal, and obsolete membership versions need protocol review before implementation. Rate limits and admission controls should address spam; with device-local identities, banning one address does not guarantee that the person cannot create another.

## Compatibility

Keep existing direct chats and private groups working without automatic migration. Older clients should show an unsupported-feature state or reject unsupported community events safely. Do not weaken admission or permissions to accommodate them.

Current group delivery uses a separately encrypted copy for each recipient, which the relay stores and forwards. Measure delivery, attachment, storage, and mobile costs before choosing a community size limit; this proposal does not promise large-scale server capacity.

## Alternatives

- Add join links to existing groups only: smaller scope, but leaves topic organization unresolved.
- Launch channels and discovery together: broader functionality, with greater delivery and moderation complexity before demand is established.

## Open Questions

- Should the first version offer direct admission, approval, or both? Who processes admission when the owner is offline?
- How are moderator authority, ownership transfer, and removal represented and synchronized?
- What happens to delayed messages addressed to an obsolete membership?
- Should owners ever share pre-join history, and how would members understand that choice?
- What member and channel limits fit measured relay capacity?
- When is discovery worthwhile, and who handles listing reports and removal?

## Implementation Notes

Before implementation, revise this draft with the membership, invitation, and event formats. Validate joining, revoked invitations, unauthorized actions, removal, outdated clients, notification behavior, and narrow-screen navigation using multiple identities.
