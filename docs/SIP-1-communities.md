# SIP 1: invitation communities and text channels

Implementation of the first invitation-based stage of [SIP 1](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-1-public-communities-and-channels.md). Public discovery remains deferred.

## Wire format and trust

Community events use the existing signed v3 messaging envelope with a new `community` kind and a single `payload.community` discriminated object. Older clients reject the unknown kind. The conversation ID is `community:<owner public key>:<UUID>`, binding the community to its immutable owner. No relay schema change is needed. Community events share the durable encrypted relay outbox, retained feed, IndexedDB event store, and full backup.

Owner-signed state records contain the name, description, member addresses, moderators, banned addresses, text channels, admission policy, joining pause, invitation generation, and monotonic membership epoch. Peers verify the owner signature and event signature. A member-authored message cannot establish membership; admission requires an owner-authored state event. Equal-epoch conflicts and obsolete state are rejected. Ownership transfer is not supported in this version.

A public invitation exposes the community ID, owner public address, name, description, admission policy, after-join history policy, invitation generation, random token, expiry, and owner signature. It exposes no member roster, message history, or private key. The encoded invitation lives in the link fragment, and its QR code encodes that same link. The signed preview may be stale; validity is checked again against current state by the owner before admission.

## Admission and administration

A signed encrypted join request goes only to the owner. Direct admission is processed automatically while the owner's client is running. Approval requests are reviewed by the owner. Their invitation tokens remain private between applicant and owner. Moderator requests for membership changes are authenticated commands to the owner, who checks current authority and serializes state changes. Duplicate request and command IDs cannot repeat an already processed mutation.

Before adding a member the owner checks the current invitation generation, expiry, joining pause, ban list, and 20-member limit. Revocation increments the invitation generation. Member removal excludes their address from future fanout after synchronization; bans also reject subsequent requests from that address. A person can create another device-local identity, so an address ban is not a person-wide ban.

Channels share one membership. There are at most eight channels; a channel permits all members or only the owner and moderators to post. The first stage supports text messages only, avoiding attachment fanout expansion. Reports are encrypted to the owner and current moderators; message hides are authenticated and enforced by cooperating clients. Hiding does not erase copies held elsewhere.

## Delivery and history

Messages carry the current epoch and channel ID. Recipients check admission, author membership, channel permission, and recipient scope. Newcomers do not receive earlier history. Community outbox delivery synchronizes membership first and rejects obsolete queued traffic rather than changing the recipients of a signed event.

There is no globally synchronous revocation in a client-mediated relay: already delivered messages and sends from a device that has not learned a removal cannot be recalled. State changes on concurrently active owner devices can conflict; one owner device should administer a community at a time. Conflicting equal-epoch states are rejected instead of silently choosing a new authority.

## Operational scope

No public listing is created. Private direct/group conversations retain their existing behavior. Invitation previews require explicit joining. The initial UI includes compact community/channel navigation, unread counts, channel notification preferences, reports and member controls, and narrow-screen navigation. Full backups carry community events and preferences; restoring an old backup still needs relay synchronization to learn newer changes.
