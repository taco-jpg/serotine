---
sip: 2
title: Expanded and custom themes
author: sodium-qed
status: Final
created: 2026-09-12
updated: 2026-09-14
---

# SIP-2: Expanded and custom themes

## Summary

Serotine provides paired preset palettes and a custom color editor with local saving and data-only import/export. Appearance mode (light, dark, or system) stays separate from the chosen palette and from layout density. This SIP documents the implemented behavior.

## Motivation

Light, dark, and system appearance modes address brightness preferences but originally offered limited visual personalization. Additional palettes let users choose an appearance they enjoy, while a custom editor supports preferences that presets cannot cover. Changing colors preserves the compactness and usability of the conversation view.

## Proposal

### Appearance and presets

Appearance mode and palette are separate choices. A user can select a palette and use its light version, dark version, or let the system determine which version appears. The built-in pairs are Default, Forest, Ocean, Lavender, Rose, and Monochrome.

### Custom colors

Users start from a preset and edit ten allowlisted colors independently for light and dark variants: background, text, surface, sidebar, accent, muted text, incoming message background/text, and outgoing message background/text.

Provide a live conversation preview with representative messages, links, controls, and selected states. Users should be able to cancel an edit, reset to the starting preset, and restore a readable built-in theme without navigating an unreadable custom preview. Show feedback when selected text and background colors are difficult to distinguish.

Users can name and save up to 20 custom themes locally. Theme selection is a personal preference: it changes the selecting user's interface and does not automatically change how a conversation appears to other participants.

### Import and export

Data-only import and export let friends share palettes. Theme files contain only allowlisted theme properties and are validated before preview or use. Import opens the editor for review without silently applying the theme; files are limited to 16 KiB.

## Security & Privacy

Theme data must exclude messages, identities, credentials, access keys, and backup material. Imported themes must not contain executable code, arbitrary CSS or HTML, or remote URLs. Importing a theme should not fetch outside resources or silently apply it. Invalid or unsupported values should produce a clear error while preserving the current usable theme.

## Compatibility

Default remains the fallback palette. Later design refinements aligned the built-in palettes with the app's visual design while preserving saved custom colors. Switching palettes does not alter message spacing, density, font size, or layout. Missing theme values fall back to readable defaults. Theme preferences do not change messaging or encryption behavior.

## Alternatives

Adding presets alone would be simpler but would leave custom themes unaddressed. An accent-color selector would provide a smaller first step, with less control over the overall appearance. Arbitrary stylesheet uploads are excluded from this proposal because a bounded color format is easier to validate and keep usable.

## Implemented decisions and follow-ups

- Custom themes contain both light and dark variants, initialized from a built-in base and edited separately.
- Readability feedback warns when checked text/background pairs fall below a 4.5:1 contrast ratio; it does not block saving. The editor's built-in controls and default-palette recovery remain readable.
- Background images, fonts, message shapes, and cross-device theme synchronization remain outside this implemented scope.

## Implementation Notes

Implemented in [PR #50](https://github.com/taco-jpg/serotine/pull/50), with app-wide design refinements in [#52](https://github.com/taco-jpg/serotine/pull/52) and stronger palette distinctions in [#54](https://github.com/taco-jpg/serotine/pull/54). Their automated and browser checks cover preset variants, custom editing, preview cancellation, import/export validation, persistence, recovery, and narrow-screen layouts.

See the [implementation notes](https://github.com/taco-jpg/serotine/blob/main/docs/SIP-2-themes.md). Status reviewed against application `main` on 2026-09-14.
