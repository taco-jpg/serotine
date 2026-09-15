---
sip: 18
title: Ephemeral attachment delivery
author: louisliu
status: Draft
created: 2026-09-14
updated: 2026-09-14
---

# SIP-18: Ephemeral attachment delivery

## Summary

Treat Serotine's server-side attachment storage primarily as a temporary delivery buffer rather than permanent chat history. For a direct message, once the intended recipient has successfully received and integrity-verified the complete attachment, Serotine should promptly delete the server-side attachment objects and associated delivery-only metadata. The sender and recipient may retain their own local copies.

For private groups, use recipient acknowledgements to remove the server copy once every currently required recipient has received the attachment, subject to a bounded fallback expiry. Communities may use a different bounded retention policy because membership and asynchronous delivery make immediate all-recipient deletion more complicated.

The objective is to sharply reduce persistent R2 storage, repeated server reads, and long-lived attachment state without making ordinary image sending unreliable.

## Motivation

Images and files are much larger than ordinary message metadata. Keeping every successfully delivered attachment on Serotine's infrastructure indefinitely makes storage scale with total historical usage even when both endpoints already possess the bytes.

The current large-file design deliberately keeps a published object available after send and relies on lifecycle expiry rather than deleting it when delivery succeeds. This protects against a lost acknowledgement, but it also turns the server into historical attachment storage. Serotine should instead optimize for a small infrastructure budget: retain bytes while they are needed for delivery, then reclaim them as soon as the protocol has evidence that they are no longer needed.

This proposal concerns server retention. It does not require deleting the attachment from either participant's browser or device after successful receipt.

## Proposal

### Direct messages

For a one-to-one conversation:

1. The sender stages the encrypted attachment as today and publishes its encrypted attachment capability with the message.
2. The recipient downloads the complete attachment.
3. The recipient verifies the expected object/chunk integrity before acknowledging completion. Merely opening the message, receiving attachment metadata, or starting a download is not sufficient.
4. The recipient sends an authenticated attachment-complete acknowledgement tied to the message, attachment identity, and expected content/integrity metadata.
5. After the server validates that acknowledgement as coming from the intended recipient, it marks the attachment delivered and schedules physical deletion of every server object belonging exclusively to that attachment.
6. Deletion should occur promptly, preferably in the same bounded cleanup flow or an idempotent asynchronous cleanup job. Repeated acknowledgements must not create repeated expensive work.

Once cleanup succeeds, the existing message can remain in local history with its attachment metadata and local cached copy. If a user later loses that local copy, Serotine does not promise that the server can redownload an already acknowledged attachment.

The UI should make this semantic understandable where relevant: successfully received attachments are retained locally, while server delivery storage is temporary.

### Reliability boundary

Do not delete server bytes on a generic message `delivered` or `read` receipt. Attachment cleanup requires proof that the entire attachment was received and verified.

If acknowledgement is lost, the server retains the attachment until a later valid acknowledgement or the fallback expiry. If the acknowledgement reaches the server but deletion partially fails, cleanup is retried idempotently. A recipient must never acknowledge completion before local verification finishes.

The sender should not need to remain online for cleanup to occur.

### Private groups

A private-group attachment may have multiple required recipients. Maintain a compact delivery set for the attachment rather than retaining arbitrary read transcripts.

The server may delete the shared attachment once every recipient who was an active intended recipient at send time has authenticated successful receipt, excluding recipients whose membership was terminally removed under a protocol rule that explicitly releases their pending delivery requirement.

This acknowledgement is an attachment-lifecycle mechanism, not a user-visible `read by` transcript. SIP-13's minimization of group/community read and delivered receipts still applies.

If one recipient remains offline indefinitely, the attachment must not remain forever. Apply a bounded maximum delivery retention period. After expiry, delete the server copy even if some recipients never downloaded it; their clients show the attachment as expired/unavailable rather than repeatedly consuming server storage.

### Communities

Communities can have asynchronous members and more complicated membership epochs, so the first implementation does not need to use immediate all-recipient deletion. Community attachment storage must nevertheless be bounded.

Use a deliberately finite retention window and lifecycle deletion. A later implementation may use epoch-scoped recipient completion to reclaim a community attachment earlier when all intended recipients have received it.

Community retention must not silently become permanent archival storage.

### Small images and previews

Thumbnails, previews, alternate image sizes, encrypted manifests, and chunks derived solely from an attachment share its lifecycle. When the attachment becomes eligible for deletion, delete those derived objects as well.

Do not retain a hidden full-size copy merely because a thumbnail or message record remains.

### Storage and operation efficiency

Design the cleanup path to reduce total infrastructure work rather than exchanging storage savings for excessive database operations.

- Keep attachment lifecycle metadata compact and keyed for direct lookup; do not scan a user's entire message history on each acknowledgement.
- Batch physical object deletion when an attachment contains multiple chunks or representations.
- Make acknowledgement and deletion idempotent.
- Avoid periodic high-frequency polling solely to discover completed attachments.
- Prefer event-driven cleanup plus a low-frequency bounded expiry sweep for abandoned uploads and lost acknowledgements.
- Once physical objects are gone, delete delivery-only rows that are no longer needed. Retain only minimal tombstone/idempotency state when necessary to reject replayed acknowledgements or capabilities.
- Measure R2 bytes stored, R2 reads/writes/deletes, D1 rows read/written, and average attachment server lifetime. The change is successful only if total infrastructure cost falls materially.

### Fallback expiry

Every server-stored attachment has a hard maximum lifetime independent of acknowledgements. Exact durations are deployment policy and may differ between DMs, groups, and communities, but they must be finite and documented.

The expiry is a safety net, not the normal DM cleanup path. A successfully received DM attachment should normally disappear from server storage shortly after verified receipt rather than waiting days for lifecycle expiration.

## Security & Privacy

Attachment-complete acknowledgements must be authenticated and bound to the intended recipient and attachment. An unrelated client must not be able to force deletion of another user's pending file.

Server deletion cannot erase copies already downloaded, cached, backed up, screenshotted, or forwarded by endpoints. The feature is infrastructure retention minimization, not remote revocation.

Random attachment capabilities should stop resolving after physical cleanup. Logs and tombstones must not retain the attachment payload or capability unnecessarily.

## Compatibility

Older clients that do not emit attachment-complete acknowledgements continue to rely on the hard expiry. Their existence must not force indefinite storage.

Message history remains structurally readable after server cleanup. A client with a local attachment copy can continue displaying it; a client without one should show a clear expired/unavailable state rather than retrying the server forever.

SIP-15 governs terminal conversation-wide server purging. This SIP provides the much earlier normal-case lifecycle for successfully delivered attachment payloads. SIP-13 still governs ordinary group/community receipt minimization; attachment-complete acknowledgements are narrowly scoped storage-control events.

Force P2P under SIP-9 bypasses server attachment storage entirely and therefore does not need this cleanup path for directly transferred payloads.

## Alternatives

**Keep attachments until a fixed lifecycle expiry:** simpler and robust against lost acknowledgements, but wastes storage after successful delivery and remains the fallback rather than the desired steady state.

**Delete on ordinary message delivery:** cheaper but unsafe because message metadata may arrive before all attachment bytes.

**Never store DM attachments server-side:** minimizes infrastructure further but removes offline delivery; SIP-9 covers the explicit direct-only design instead of silently changing ordinary messaging semantics.

**Keep permanent server history:** easiest for redownload and multi-device recovery, but incompatible with the intended low-cost infrastructure model.

## Open Questions

- What hard expiry windows give acceptable offline-delivery reliability for DMs, groups, and communities?
- Should a second device be allowed to fetch an attachment after another device has acknowledged it, or is local/device synchronization explicitly outside the retention guarantee?
- Can the existing encrypted attachment manifest provide enough integrity identity for the completion acknowledgement, or should the protocol add a dedicated attachment digest/id?
- For group membership changes, which terminal removal events release a pending recipient from the attachment delivery set?

## Implementation Notes

The existing large-file path already separates staging from publication and has physical object deletion for abandoned drafts, while published objects currently remain available and are protected against premature deletion when an acknowledgement is lost. Reuse its object ownership and cleanup primitives rather than introducing a second attachment store.

Before accepting implementation, verify at minimum:

- A DM attachment remains downloadable until the recipient has completely received and verified it.
- A valid recipient completion acknowledgement causes the attachment's server objects and derived objects to disappear promptly.
- Metadata-only receipt, partial download, corrupted download, forged acknowledgement, and acknowledgement from the wrong identity cannot trigger deletion.
- Duplicate acknowledgements and duplicate cleanup jobs are harmless and inexpensive.
- Group objects survive until required recipients acknowledge or the hard expiry occurs.
- Community objects cannot persist beyond their configured maximum retention.
- Reloads, retries, delayed events, and old backups cannot recreate physically retired attachment objects without an explicit new upload.
- R2 and D1 operation measurements demonstrate lower steady-state infrastructure usage rather than merely shifting cost into polling or cleanup scans.
