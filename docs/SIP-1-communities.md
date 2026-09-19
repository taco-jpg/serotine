# SIP 1: invitation communities and text channels

Implementation of the first invitation-based stage of [SIP 1](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-1-public-communities-and-channels.md). Public discovery remains deferred.

## Wire format and trust

Community events use the existing signed v3 messaging envelope with a new `community` kind and a single `payload.community` discriminated object. Older clients reject the unknown kind. The conversation ID is `community:<founder public key>:<UUID>`, retaining its founding trust anchor when primary ownership changes. No relay schema change is needed. Community events share the durable encrypted relay outbox, retained feed, IndexedDB event store, and full backup.

Owner-signed state records contain the name, description, member addresses, moderators, banned addresses, text channels, admission policy, joining pause, invitation generation, and monotonic membership epoch. Peers verify the owner signature and event signature. A member-authored message cannot establish membership; admission requires an owner-authored state event. Equal-epoch conflicts and obsolete state are rejected. Version 2 adds primary-owner-signed transfers, co-owner roles, and permanent community deletion. The owner key embedded in the ID remains the founding trust anchor.

A public invitation exposes the community ID, owner public address, name, description, admission policy, after-join history policy, invitation generation, random token, expiry, and owner signature. It exposes no member roster, message history, or private key. The encoded invitation lives in the link fragment, and its QR code encodes that same link. The signed preview may be stale; validity is checked again against current state by the owner before admission.

## Admission and administration

A signed encrypted join request goes only to the owner. Direct admission is processed automatically while the owner's client is running. Approval requests are reviewed by the owner. Their invitation tokens remain private between applicant and owner. Moderator requests for membership changes are authenticated commands to the owner, who checks current authority and serializes state changes. Duplicate request and command IDs cannot repeat an already processed mutation.

Before adding a member the owner checks the current invitation generation, expiry, joining pause, ban list, and 20-member limit. Revocation increments the invitation generation. Member removal excludes their address from future fanout after synchronization; bans also reject subsequent requests from that address. A person can create another device-local identity, so an address ban is not a person-wide ban.

Channels share one membership. There are at most eight channels; a channel permits all members or only the primary owner, co-owners, and moderators to post. Channels support the regular shared-chat tools: formatted text and math, replies, mentions, attachments with captions, inline media, voice notes, GIFs, saved files, editing your own text, local message deletion, pins, polls, and votes. Files retain the existing recipient-count-based relay budget. Reports are encrypted to the primary owner, co-owners, and current moderators; message hides are authenticated and enforced by cooperating clients. Hiding does not erase copies held elsewhere.

## Delivery and history

Messages carry the current epoch and channel ID. Recipients check admission, author membership, channel permission, and recipient scope. Newcomers do not receive earlier history. Community outbox delivery synchronizes membership first and rejects obsolete queued traffic rather than changing the recipients of a signed event.

There is no globally synchronous revocation in a client-mediated relay: already delivered messages and sends from a device that has not learned a removal cannot be recalled. State changes on concurrently active owner devices can conflict; one owner device should administer a community at a time. Conflicting equal-epoch states are rejected instead of silently choosing a new authority.

## Operational scope

No public listing is created. Private direct/group conversations retain their existing behavior. Invitation previews require explicit joining. Communities appear as full-size rows alongside conversations in the Inbox, with previews, unread counts, and recent activity. Channel views provide search, saved drafts, Files/Links/Pinned views, notification choices, reports and member controls, and narrow-screen navigation. Recently opened conversations and communities affect ordering; the last community and each community’s last channel are remembered locally per identity. Full backups carry community events and preferences; restoring an old backup still needs relay synchronization to learn newer changes.


## Ownership and deletion (version 2)

A primary owner can give an existing member co-owner status, remove that status, transfer primary ownership, or delete the community. Co-owners manage settings, channels, moderator roles, and ordinary members through signed commands; the primary device serializes and confirms those changes. Co-owners and moderators cannot remove the primary owner or change ownership through a settings payload. Primary-owner-generated invitations and admission review keep their existing workflow.

Ownership transfers carry a founder-rooted signature chain. Each handoff is signed by the previous primary owner and bound to its exact state, allowing the successor to issue later signed states without sharing private keys. Clients check chain continuity before epoch ordering so a former owner cannot regain authority through a larger epoch. The community ID, channel IDs, and history stay in place. Transfer revokes old invitations and rejects pending admission requests on the outgoing owner's device rather than leaving them waiting indefinitely.

Version-2 content and administrative events bind to their signed membership state. A delayed command is checked against current permissions when processed. A signed deletion is terminal once observed: clients hide community history, reject further admission/sends, and cancel pending content. The durable signed tombstone survives backup/restore and relay replay. It does not erase copies already retained by another member.

An existing version-1 community upgrades atomically: save a founder-only legacy membership fence and the version-2 replacement together in one IndexedDB transaction. Older clients receive the fence and stop participating; current clients retain their actual membership from the replacement. A failed write cannot retire the old membership without saving the replacement. All upgraded members need the current client.

## Shared-chat features

Content controls remain inside the signed `community` envelope and bind to the channel and current membership state. Edits are author-restricted, targets cannot cross channels, and announcement channels preserve posting restrictions. SIP-13 removes durable per-person delivered/read receipts for community traffic; local unread markers remain. Verified attachment-completion acknowledgements are storage controls, not reader lists. Local deletion removes the selected message and its attachment bytes on this device while retaining membership and ownership proofs; deletion tombstones survive backup imports. Moderator hiding remains a separate shared action.

Private disappearing messages and access-key messages remain direct-chat features, as they are in regular conversations; they are not enabled for regular groups or community channels. The new community event variants require an updated client. Existing text community events retain their format.
