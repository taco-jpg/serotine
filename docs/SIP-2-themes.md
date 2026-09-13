# SIP 2: expanded and custom themes

Implementation of [SIP 2](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-2-expanded-and-custom-themes.md).

## Appearance choices

The existing Light, Dark, and System preference keeps its original storage key and behavior. A separate palette preference provides Default, Forest, Ocean, Lavender, Rose, and Monochrome, each with light and dark variants. Default leaves the existing stylesheet colors untouched. Palette changes update semantic color variables only: they do not change density, font sizes, spacing, or sidebar preferences.

The theme menu opens **Palettes & custom themes**. A custom theme starts from a preset or a copy of the current theme. Both variants can be edited independently. The preview includes incoming/outgoing messages, links, selected states, and controls. Edits stay inside the preview until saved and applied; cancellation leaves the current palette intact. Resetting a draft restores its starting preset. The editor and recovery menu use readable built-in colors even when the current palette is hard to read.

## Local storage and recovery

Up to 20 named custom themes are stored in `serotine:palettes:v1`, independently of identities, conversations, and the appearance-mode preference. Changes are synchronized between tabs of the same browser origin. They are not sent to participants, the relay, or linked devices, and are not added to chat backups. Clearing site data clears these preferences.

Invalid stored themes are discarded and missing color values fall back to the selected built-in base. A missing or invalid selection falls back to Default. Normal saves and selections report storage failures without replacing the current preference. Restoring Default remains effective for the current session even when storage cannot be written.

## Theme files

Export contains only `version: 1`, `name`, `baseId`, `light`, and `dark`. Each color variant allows only `background`, `foreground`, `surface`, `sidebar`, `accent`, `mutedText`, `incoming`, `incomingText`, `outgoing`, and `outgoingText`, encoded as six-digit hexadecimal colors. Imports reject unsupported properties, versions, invalid values, and oversized files. Both variant objects are required; omitted individual colors inherit their built-in base. An imported file receives a new local identifier and opens as a draft without changing the current palette.

Theme files cannot supply CSS, HTML, scripts, URLs, remote resources, messages, keys, or backup data. Text/background contrast below 4.5:1 produces feedback for both variants; it warns without preventing the user from saving their chosen colors. Button foreground and supporting surfaces are derived from the bounded colors.

## Verification

`node --test tests/themes.test.cjs` checks the color model, built-in readability, import validation, and storage fallback behavior. `npm run test:palettes` checks the browser selection/edit/save/import/recovery flow, persistence, appearance-mode changes, and narrow layouts. The existing `npm run test:appearance` remains the broader conversation/layout regression.
