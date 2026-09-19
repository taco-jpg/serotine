---
sip: 15
title: Server-side conversation lifecycle purging
author: louisliu
status: Accepted
created: 2026-09-14
updated: 2026-09-19
---

# SIP-15: Server-side conversation lifecycle purging

## Implementation status — 2026-09-19

Implemented in [PR #67](https://github.com/taco-jpg/serotine/pull/67); awaiting merge and deployment validation. New retained data uses authenticated scopes, minimal terminal state, and bounded retryable deletion. Removing a direct contact closes server retention for the pair; both parties must explicitly accept a new relationship boundary before relay-backed traffic resumes. Terminal group/community deletion closes its corresponding scope before cleanup, and stale submissions cannot reopen it. Legacy data without a reliable conversation scope keeps its previous retention policy because safe retroactive attribution is unavailable; this release does not retroactively purge those archives. Local history, downloaded files, exports, and screenshots remain outside server cleanup. Local D1/R2 tests exercise actual object deletion and replay/race rejection; production bindings, scheduled cleanup, and deployed behavior still require verification.

## Summary

Tie retained server data to the lifetime of the social relationship that created it. When a private group or community is terminally deleted, purge its retained relay data and conversation-scoped server objects. When either participant removes the other as a friend/contact in a direct-message relationship, purge the server-retained DM data for that pair.

The goal is simple: once the relationship or shared space no longer exists, Serotine should not keep paying to store a retained server copy indefinitely.

This is **server-side retention cleanup**, not remote deletion from another person's device. Local history, exported backups, screenshots, and already downloaded files cannot be erased by this proposal.

## Motivation

Serotine currently retains encrypted relay events so offline clients can synchronize. Encryption protects content, but retained ciphertext still has storage and operational cost. Keeping data after a group/community has been deleted or after a DM relationship has been intentionally severed provides little product value while increasing:

- D1 rows and indexes;
- R2/object-storage usage for relay payloads and attachments;
- synchronization work against conversations that should be terminal;
- the amount of encrypted metadata and ciphertext held by the service.

Local deletion is not enough. Deleting a conversation only from one browser while the relay continues retaining the same events does not reclaim server resources and can create confusing restore/replay behavior.

## Proposal

### Retention scopes

Every newly retained conversation event should belong to an authenticated **retention scope** representing one direct relationship, private group, or community. The server does not need plaintext messages to perform lifecycle deletion.

A retention scope must be:

- opaque or minimally revealing;
- bound to the authenticated event submission;
- stable enough to find the rows and server objects that belong to the same lifecycle;
- unforgeable as authority to purge unrelated data.

Do not add a cleartext message body, channel title, group name, or other unnecessary conversation content merely to make cleanup easier.

### Direct messages

For an accepted one-to-one relationship, either participant may terminate the server-retention relationship by using the normal **Remove friend / Remove contact** flow.

After a valid termination request:

- delete retained relay events in both directions for that DM retention scope;
- delete conversation-scoped relay payload objects that no longer have a live reference;
- invalidate queued offline delivery for that relationship;
- prevent delayed pre-termination events from repopulating the retained history;
- require a new accepted relationship boundary before future relay-backed DM traffic can create a fresh scope.

The other participant does not need to approve the server purge. Either person is allowed to end the server-retained relationship. This does not force deletion of the other participant's already downloaded local history.

Removing a local nickname or merely archiving a conversation does **not** trigger a purge.

### Private groups

An authorized terminal **Delete group / Dissolve group** action purges the group's retained server data. Ordinary member departure does not delete the group's history for remaining members.

On terminal group deletion:

- stop accepting new retained traffic under that group's retention scope;
- invalidate pending invitations;
- delete retained group events and retry/outbox records held server-side;
- garbage-collect group-scoped attachments and relay payload objects when no other live reference exists.

The deletion authority must match the private-group ownership/admin model. A normal member cannot purge the whole group by leaving.

### Communities

A valid terminal community deletion by the authority defined in SIP-1 triggers equivalent cleanup for the community retention scope, including channel events and pending invitation state that exists on the service.

Deleting one channel may use a narrower child scope in a future extension, but this SIP only requires terminal whole-community cleanup.

### Minimal terminal tombstones

Immediate content purge and replay prevention are separate requirements. After deleting retained conversation content, the server may keep a **minimal terminal tombstone** containing only what is necessary to reject stale replay or stale invitations.

The tombstone must not contain message ciphertext, attachment content, names, descriptions, or member-readable history. Its storage should be tiny compared with the deleted conversation and may itself expire once replay is no longer possible under the protocol.

This exception exists so an offline client or restored old backup cannot recreate a server-retained conversation simply by replaying old validly signed events.

### Attachments and shared objects

Do not blindly delete an object that can legitimately be referenced from another live scope. Use ownership/reference metadata or conversation-scoped object keys so lifecycle cleanup can prove that an object is no longer needed.

For objects that are exclusive to the deleted scope, remove both metadata and underlying storage. Failed object cleanup should be retryable without restoring the deleted conversation itself.

## Security & Privacy

Lifecycle purge is destructive and therefore requires strict authorization.

- A DM purge must be authenticated as one of the two participants in that DM retention scope.
- A group/community purge must be authenticated by the authority allowed to terminally delete that space.
- Possessing a message ID, relay sequence number, invitation URL, or object URL must not be sufficient to purge a conversation.
- A client must not be able to choose another conversation's retention scope and delete it.

The retention-scope design should minimize new metadata leakage. If a shared scope identifier would let the relay correlate recipients in a way it cannot today, prefer scoped purge capabilities or another construction that supports deletion without unnecessarily increasing observability.

Server deletion cannot recall data already delivered to clients. The UI must not imply otherwise.

## Compatibility

Existing retained rows that predate retention scopes may continue under their existing expiry policy if they cannot be safely attributed without decrypting content. Do not perform a risky heuristic migration merely to claim retroactive cleanup.

New clients and servers should use the scoped lifecycle mechanism for newly created relationships/spaces. During rollout, a client must not assume that a successful local delete means the old server supports purge; expose failures clearly and retry authenticated cleanup where safe.

Archive, mute, local chat deletion, and backup behavior remain separate concepts.

## Alternatives

- **Rely only on TTL expiry:** simple, but keeps clearly dead data until the full retention period ends and does not invalidate stale replay immediately.
- **Delete only local IndexedDB history:** saves no server storage and leaves relay state intact.
- **Let only both DM participants jointly approve purge:** prevents either person from ending server retention unilaterally and leaves dead relationships stored when one side disappears.
- **Store plaintext conversation IDs for easy SQL deletion:** operationally simple but adds avoidable server-visible metadata.

## Open Questions

- What retention-scope/capability construction provides efficient deletion with the least additional relay metadata?
- How long, if at all, must a terminal replay-prevention tombstone survive after all ordinary retained events are gone?
- Which existing attachment and large-relay-object paths need reference counting versus naturally conversation-scoped keys?

## Implementation Notes

The current retained relay is indexed primarily by sender/recipient/sequence and stores encrypted event data. Efficient lifecycle cleanup therefore needs an explicit server-visible cleanup primitive rather than scanning and decrypting application history.

Prefer bounded indexed deletes or asynchronous batched cleanup over unbounded D1 transactions. The terminal state should be recorded before or atomically with making the scope non-writable, so a racing send cannot repopulate rows after purge begins.

Tests must cover deletion racing with send/retry, an offline recipient returning later, stale backup replay, duplicate purge requests, attachment cleanup failure, and attempts by unrelated identities to purge another scope. Measure reclaimed rows/bytes and verify that terminal cleanup does not create a new high-frequency database path.
