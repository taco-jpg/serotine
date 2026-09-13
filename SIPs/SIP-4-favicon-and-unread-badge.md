# SIP-4: Favicon and unread badge

- Status: Draft
- Type: UX

## Summary

Give Serotine a real browser favicon and let the favicon reflect unread activity.

## Motivation

Serotine currently has no useful favicon, which makes the tab feel unfinished and harder to recognize when several tabs are open. Unread messages are also easy to miss when Serotine is in a background tab.

## Proposal

- Add a proper Serotine favicon and app icon set.
- When there is at least one unread message, render a small red notification dot on the favicon.
- Remove the dot when there are no unread messages.
- The unread badge should represent Serotine-wide unread state, not only the currently open conversation.
- Keep the badge simple: a dot is enough; a numeric counter is optional and can be explored later.
- The favicon should remain recognizable at normal browser-tab sizes and in both light and dark browser chrome.

## Notes

This is presentation-only. It should not change notification permissions, read-receipt behavior, or message delivery semantics.
