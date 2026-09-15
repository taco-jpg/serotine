---
sip: 14
title: Explicit group invitations and terminal invalidation
author: louisliu
status: Draft
created: 2026-09-14
updated: 2026-09-14
---

# SIP-14: Explicit group invitations and terminal invalidation

## Summary

Make private-group membership explicitly consensual. Adding a person to a group creates a **pending invitation**, not immediate membership, even when the inviter and invitee are already friends or accepted contacts. The invitee must choose **Accept** before receiving ordinary group traffic or appearing as an active member.

Pending invitations are revocable and terminally invalidated when the group is dissolved. A deleted group must not leave behind an invitation that can still be accepted or continue appearing as actionable UI.

Community admission remains governed by SIP-1. This SIP applies the same explicit-consent principle to private group chats and defines the missing invitation lifecycle for them.

## Motivation

Friendship is permission to contact someone directly; it is not blanket permission to place them into any group. Automatically treating an invited friend as a member creates several problems:

- the invitee may begin receiving group messages or metadata before consenting;
- other members may see the invitee as present before the invitee has accepted;
- a stale invitation can outlive the group it refers to;
- deleting or dissolving a group becomes ambiguous if outstanding invitations can later resurrect membership.

The current application already has a request/acceptance concept around group invitations, but the protocol should make the boundary explicit: a pending invitee is not an active member, and contact status must never bypass that rule.

## Proposal

### Invitation is not membership

When an administrator invites a person to a private group:

1. Create a signed invitation containing the group identity, display name, inviter, invitation identifier, and the minimum preview metadata needed to make a decision.
2. Deliver the invitation as a pending request.
3. Do **not** add the invitee to the active membership set yet.
4. Do **not** send ordinary group message history or new group messages to the invitee while the invitation is pending.
5. Do **not** expose the invitee to existing members as an active member before acceptance.

The invitee chooses **Accept** or **Decline**. Acceptance produces an authenticated membership transition. Only after that transition succeeds does the person become eligible for normal group traffic.

Existing friendship, accepted-contact state, prior DMs, local address-book entries, or a previous group together must not auto-accept the invitation.

### Acceptance and decline

Acceptance must be explicit and attributable to the invited identity. The UI should show enough context to avoid blind acceptance: group name, inviter, and current member count or a bounded member preview where safe.

Declining removes the pending invitation locally and should send the minimum authenticated decline/cancellation signal needed to stop retries. Declining does not block the inviter or remove an existing friendship.

Repeated delivery of the same invitation ID must be idempotent. It must not create duplicate requests or multiple membership transitions.

### Revocation and deletion

An administrator may revoke an outstanding invitation before it is accepted. Revocation makes later acceptance fail cleanly.

If the group is dissolved or terminally deleted:

- every outstanding invitation for that group becomes invalid immediately;
- pending invitation UI is removed once the terminal state is learned;
- accepting an old link, request, QR code, restored backup item, or delayed relay event must fail with a clear `Group no longer exists` state;
- an old invitation must never recreate the group or re-add a member after terminal deletion.

A small replay-prevention tombstone may remain as defined by the storage lifecycle proposal; the full invitation and group history need not remain actionable.

### Group dissolution

Private groups need a distinct terminal **Delete group / Dissolve group** action for the authorized administrator, separate from an ordinary member choosing **Leave group**.

Leaving affects only that member. Dissolving the group terminates the group identity for everyone, invalidates invitations, prevents new message delivery under that group ID, and triggers any server-retention cleanup defined by the applicable lifecycle SIP.

Deletion requires confirmation and should clearly distinguish itself from deleting a local chat view.

## Security & Privacy

An invitation must not grant group read access before acceptance. Preview metadata should be minimal and must not contain message history, attachment capabilities, private channel content, or reusable secrets unrelated to joining.

Acceptance, revocation, and terminal deletion must be authenticated. A non-admin participant must not be able to forge a deletion or add arbitrary members. Conversely, an admin must not be able to manufacture an invitee's acceptance.

Old invitations are untrusted after a terminal delete. Clients must validate current invitation state rather than assuming that a previously valid signature remains sufficient forever.

## Compatibility

Existing private groups continue to work. This proposal changes **new invitation transitions**, not the identity of already accepted members.

During migration, a current group state that already lists an unaccepted request recipient should be normalized carefully: do not silently convert an old pending request into consent. If the client can prove that the person previously accepted, preserve membership; otherwise require a fresh invitation/acceptance boundary.

SIP-1 already requires an explicit Join or Request-to-join action for communities. Do not create a second community admission protocol here.

## Alternatives

- **Auto-accept friends:** convenient but conflates direct-contact consent with group membership consent.
- **Add first, let the user leave later:** leaks group traffic and membership metadata before consent.
- **Keep invitations valid after deletion:** creates stale actions and risks resurrecting a terminal group identity.

## Open Questions

- How much member preview metadata should a pending private-group invitation expose before acceptance?
- Should invitations expire automatically after a bounded period in addition to explicit revocation and terminal deletion?

## Implementation Notes

The request UI alone is not sufficient if the signed group state already treats pending invitees as active members. Tests must verify that a pending invitee receives no ordinary group messages, is not counted as an active member, and cannot send into the group before acceptance.

Add coverage for friend-to-friend invitations specifically, because accepted contact status is the easiest path for an accidental auto-accept regression. Also test revocation, group dissolution, delayed invitation delivery, duplicate invitations, backup restore, and an acceptance racing with deletion.
