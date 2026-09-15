---
sip: 17
title: Stable conversation ordering and list motion
author: louisliu
status: Draft
created: 2026-09-14
updated: 2026-09-14
---

# SIP-17: Stable conversation ordering and list motion

## Summary

Opening a conversation must not move it to the top of the inbox merely because it was opened. Conversation order should reflect meaningful conversation activity, not navigation history.

When real activity does change ordering, rows should move with a short spatial transition rather than disappearing from one position and instantly reappearing at another. The selected conversation stays visually selected without being artificially promoted.

## Motivation

The current navigation preference system records each opened conversation and `sortByRecentActivity` combines that local open timestamp with the conversation's real `updatedAt` value. As a result, clicking an older conversation immediately makes it the newest item in the sidebar.

That behavior is disorienting for two reasons:

- the user's click changes the location of the thing they just clicked, even though no conversation activity occurred;
- the row jumps by replacement rather than moving in a way that preserves spatial continuity.

A messaging inbox should be predictable. Opening an item is navigation, not new message activity.

## Proposal

### Separate navigation history from conversation recency

Keep `lastView`/last-opened information for restoring the user's previous location, but do not use it to rank the inbox.

The default inbox order should be based on actual conversation activity. At minimum:

- a newly sent or received message may update recency;
- a newly created conversation may appear at the appropriate recent position;
- community ordering may use the latest eligible channel activity;
- opening, closing, viewing, scrolling, marking read, or restoring a route must not update inbox recency by themselves.

A local nickname edit, settings change, archive toggle, or notification preference change should not unexpectedly make a conversation the newest chat unless a separate product rule explicitly says so.

### Selected row stays in place

Clicking a row should:

1. keep the row at its current list position;
2. apply the selected/active visual state;
3. update the conversation pane;
4. remember the route for restoration without changing list rank.

The user should be able to move through nearby conversations without the list continuously reshuffling under the pointer.

### Meaningful reordering

When new conversation activity genuinely changes rank, reorder the list. Examples include a new incoming message or a successful new outgoing message.

The ordering rule must be deterministic. Ties should use a stable secondary key so rows do not flicker between positions on rerender.

Do not use receipt arrival, local read state, or local navigation timestamps as synthetic conversation activity.

### List motion

When a row changes position because of meaningful activity, animate the positional change briefly so the user can track where it moved.

The animation should:

- preserve the row's visual identity while it moves;
- avoid a remove-then-insert flash;
- not block clicking or keyboard navigation;
- use the shared motion tokens defined by SIP-16 if that SIP is adopted;
- disable or simplify itself under `prefers-reduced-motion`.

If reliable list-motion support is unavailable in a given layout, stable immediate reordering is preferable to a broken animation. The essential requirement is that **clicking alone never causes the reorder**.

### Filtering, archive, and search

Filtering may temporarily hide rows but must not rewrite their underlying recency. Clearing the filter restores the same activity-based order.

Archiving removes the item from the inbox view by explicit user action. Unarchiving returns it according to its real conversation activity, not the time it was unarchived or opened.

Search-result ordering is separate and may rank by message relevance or timestamp; selecting a search result must not artificially promote the parent conversation in the normal inbox.

### Communities

The same principle applies to communities in the combined inbox. Opening a community or switching channels is navigation. It does not make the community the most recent item unless new eligible conversation activity actually occurred.

Channel-selection preferences may still be remembered locally for route restoration.

## Security & Privacy

No new network metadata is required. Navigation history remains a local preference and should continue to stay local unless a separate synchronization proposal explicitly changes that.

Removing local open timestamps from inbox ranking also reduces the chance that a future synchronization feature accidentally treats browsing behavior as conversation activity.

## Compatibility

Existing stored navigation preferences can keep their `lastView`, opened timestamps, and channel-selection data for route restoration. The `opened` timestamps simply stop participating in inbox sorting.

No messaging wire-format change is required. Existing conversation `updatedAt` semantics may be reused where they already represent genuine activity, but any non-message state that currently mutates `updatedAt` should be reviewed so it does not reproduce the same problem through a different field.

SIP-16 is not required for the ordering fix. If SIP-16 is adopted, this SIP should consume its shared list-motion tokens rather than inventing a separate animation language.

## Alternatives

- **Keep opened conversations at the top:** makes recent navigation easy to find but continuously reshuffles the primary inbox and conflates browsing with activity.
- **Pin the selected conversation temporarily:** still changes list structure on click and creates special-case behavior when switching quickly.
- **Remove reordering entirely:** maximizes spatial stability but loses the familiar value of bringing genuinely active conversations forward.
- **Fix ordering but keep instant jumps:** corrects the main bug, but meaningful reorders can still feel abrupt. This is acceptable as an intermediate implementation, not the final interaction goal.

## Open Questions

- Which non-message events, if any, should count as meaningful inbox activity: calls, group membership changes, or explicit system notices?
- Should users eventually get manual pinning as an independent ordering layer above activity recency?

## Implementation Notes

The current implementation should specifically review `rememberNavigation`, `NavigationPreferences.opened`, and `sortByRecentActivity`. Route restoration can continue using `lastView`; inbox sorting should stop taking `max(updatedAt, opened[id])`.

Add regression tests that open conversations in several orders and assert that the sidebar order does not change. Then inject a real new message and assert that only the affected conversation reorders. Browser tests should verify selected-row focus, pointer stability, reduced-motion behavior, filtering, archive/unarchive, and community navigation.
