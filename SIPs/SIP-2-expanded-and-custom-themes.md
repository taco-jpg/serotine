---
sip: 2
title: Expanded and custom themes
author: sodium-qed
status: Draft
created: 2026-09-12
---

# SIP-2: Expanded and custom themes

## Summary

Add more visual themes to Serotine, including a way to create and save custom color themes. Keep appearance mode (light, dark, or system) separate from the chosen palette and from layout density. This SIP records a proposal for discussion; it does not authorize or contain an implementation.

## Motivation

Serotine already supports light, dark, and system appearance modes. These address brightness preferences, but offer limited visual personalization. Additional palettes would let users choose an appearance they enjoy, while a custom editor would support preferences that presets cannot cover. Changing colors should preserve the compactness and usability of the conversation view.

## Proposal

### Appearance and presets

Treat appearance mode and palette as separate choices. A user could select a palette and use its light version, dark version, or let the system determine which version appears. Offer a small set of coordinated preset pairs. Names such as Forest, Ocean, Lavender, Rose, and Monochrome are examples for discussion, not a fixed list.

### Custom colors

Let users start from a preset and edit a defined set of colors, potentially including the main background, sidebar, accent, message surfaces, and text. The exact controls should follow a review of Serotine's existing styling so that one choice has predictable effects throughout the interface.

Provide a live conversation preview with representative messages, links, controls, and selected states. Users should be able to cancel an edit, reset to the starting preset, and restore a readable built-in theme without navigating an unreadable custom preview. Show feedback when selected text and background colors are difficult to distinguish.

Allow users to name and save multiple custom themes locally. Theme selection is a personal preference: it changes the selecting user's interface and does not automatically change how a conversation appears to other participants.

### Optional sharing

Consider data-only import and export so friends can share palettes. This is an optional extension, not a prerequisite for preset themes or the custom editor. A theme file would contain only an allowlisted set of theme properties, with validation before preview or use.

## Security & Privacy

Theme data must exclude messages, identities, credentials, access keys, and backup material. Imported themes must not contain executable code, arbitrary CSS or HTML, or remote URLs. Importing a theme should not fetch outside resources or silently apply it. Invalid or unsupported values should produce a clear error while preserving the current usable theme.

## Compatibility

Preserve a familiar built-in appearance for existing users until they choose another theme. Palette changes must not alter message spacing, density, font size, or layout. Missing theme values should fall back to readable defaults. Theme preferences should not change messaging or encryption behavior.

## Alternatives

Adding presets alone would be simpler but would leave custom themes unaddressed. An accent-color selector would provide a smaller first step, with less control over the overall appearance. Arbitrary stylesheet uploads are excluded from this proposal because a bounded color format is easier to validate and keep usable.

## Open Questions

- Which presets and editable colors belong in the first version?
- Should custom themes require both light and dark variants, or derive one from the other?
- Should readability feedback warn or block specific combinations?
- Should background images, fonts, or message shapes receive a separate proposal?
- Is cross-device theme synchronization desirable after local saving works?

## Implementation Notes

First inspect the existing theme and preference structure. Proposed acceptance checks: presets work in each appearance mode; preview cancellation preserves the previous theme; saved themes survive reopening; invalid imports remain harmless; and switching palettes preserves density settings.
