---
sip: 11
title: Custom user avatars
author: louisliu
status: Accepted
created: 2026-09-13
updated: 2026-09-19
---

# SIP-11: Custom user avatars

## Implementation status — 2026-09-19

Implemented in [PR #67](https://github.com/taco-jpg/serotine/pull/67); awaiting merge and deployment validation. SIP-12 field-level, per-friend consent governs avatar visibility; shared communities do not grant access. Local processing supports static images and animated GIFs with a generated-avatar fallback for unauthorized, unsupported, or unavailable media. Input is capped at 4 MiB and 4096 × 4096 decoded static pixels; processed avatars are at most 512 × 512 and banners 1024 × 512. Each processed item plus its still preview is capped at 128 KiB. GIFs additionally allow at most 80 frames and 20 seconds per loop, with a decoded-pixel budget. Reduced motion uses the still preview.

Related accepted proposal: [SIP-12: Custom profiles and per-friend sharing](SIP-12-custom-profiles-and-per-friend-sharing.md) extends this proposal with animated pictures, GIF banners, and other profile fields. Its explicit per-friend sharing rules replace the broad avatar visibility described below. Both proposals remain Accepted while their implementation awaits merge and deployment validation.

## Summary

Add optional custom profile avatars to Serotine. Users can choose an image for their identity, replace it later, or remove it and return to the existing fallback avatar. The same avatar should appear consistently anywhere that identity is shown. The status section above records the implemented scope and release boundary for this SIP and SIP-12.

## Motivation

Serotine currently has limited profile personalization. In conversations with multiple participants, avatars make people easier to recognize at a glance and reduce reliance on repeatedly reading names or addresses.

A custom avatar is also a common expectation in messaging software and can improve the identity and polish of the interface without changing how conversations themselves work.

## Proposal

### Choosing an avatar

Add an avatar control to the user's profile or identity settings. A user can select an image from their device, preview it, and save it as the avatar for that identity.

Start with common browser-compatible image formats such as PNG, JPEG, and WebP. The client may crop or resize images before upload so the stored avatar does not need full original resolution. A square source around 256×256 or 512×512 is sufficient for the current interface.

The avatar UI should preserve the current circular presentation where Serotine already uses circular identity markers. Cropping should be predictable and should not require users to prepare a perfectly square file beforehand.

### Replacement and removal

Uploading another image replaces the current avatar. The updated avatar should propagate to normal identity views without requiring the user to create a new identity or conversation.

Users can remove their custom avatar at any time. Removing it restores the existing default or generated avatar behavior rather than leaving a broken image or blank space.

### Display behavior

Use one avatar per Serotine identity rather than storing a separate avatar per conversation. Display it wherever the corresponding identity is already represented visually, including message authors, conversation headers, member lists, profile views, and user-selection interfaces that support avatars.

Messages should continue to reference the sender identity rather than embedding a copy of the current avatar in every message. Changing an avatar may therefore change how that identity appears beside older messages as well.

Avatar display must remain secondary to the authenticated identity. A user choosing another person's photo or a misleading image does not make that avatar an authentication mechanism.

### Storage and caching

Store an avatar reference or equivalent profile field rather than duplicating image bytes across messages. The exact media backend is an implementation decision and should follow Serotine's existing attachment and storage constraints where practical.

Clients may cache avatar images. Use an avatar version, content-derived identifier, immutable media URL, or equivalent mechanism so replacing an avatar invalidates stale cached copies reliably.

Set a reasonable maximum upload size and reject unnecessarily large files. A first implementation should favor small processed avatar images rather than preserving the original upload indefinitely unless another feature requires it.

## Security & Privacy

Avatar files are untrusted input. Validate actual file type and image decoding rather than trusting the filename or declared MIME type. Reject malformed or unsupported files and do not permit avatars to introduce executable HTML, scripts, arbitrary remote content, or similar active payloads.

Only the owner of an identity may change that identity's avatar. Avatar updates must not modify identity keys or weaken authentication.

Custom avatars intentionally reveal an image to people who can view the corresponding identity. The UI should not imply that an avatar is private if it is delivered to conversation participants or available through a media endpoint. Do not embed unnecessary identity secrets, local file paths, or account metadata in avatar URLs.

Apply reasonable file-size and update-rate limits to reduce storage abuse. Where image processing is used, strip unnecessary metadata where practical, especially metadata such as location information that users may not realize exists in an uploaded photo.

## Compatibility

The avatar field should be optional. Existing identities without an avatar continue using the current fallback behavior and require no visible migration.

Older clients that do not support custom avatars may continue displaying the fallback avatar while still participating in conversations normally. Avatar support must not change message encryption, conversation membership, delivery, or identity verification.

If profile data carrying the avatar reference is unavailable or invalid, clients should safely fall back to the default avatar rather than making the conversation unusable.

## Alternatives

- Keep generated or default avatars only: simplest, but leaves users without meaningful profile personalization.
- Use a third-party avatar service such as Gravatar: reduces Serotine-managed storage but adds an external dependency and may disclose lookup information.
- Embed avatar data into every message: makes historical rendering self-contained but duplicates data, increases message size, and prevents profile changes from applying consistently.
- Support per-conversation or per-community avatars immediately: offers more customization but adds identity and UI complexity that is unnecessary for the first version.

## Open Questions

- Where should processed avatar media be stored under Serotine's current deployment model?
- What maximum upload size and final image resolution should the first version use?
- Should cropping happen entirely on the client, on the server, or both?
- Should animated formats be accepted or normalized to a static image?
- How should avatar references and version changes be synchronized across clients?
- Should per-community avatars ever be added as a separate feature?

## Implementation Notes

First identify the canonical identity/profile representation and every shared avatar component in the current UI. Prefer one reusable rendering path so conversation rows, headers, messages, and member lists do not develop separate avatar behavior.

A minimal implementation needs an optional avatar reference, a profile control to set or clear it, bounded image processing and validation, cache invalidation after replacement, and fallback rendering when no usable avatar exists.

Proposed acceptance checks: an existing user can add an avatar; replacing it updates the visible identity; removing it restores the fallback; another user sees the new avatar after synchronization; unsupported clients continue messaging normally; malformed or oversized uploads are rejected; and avatar failure never prevents opening or using a conversation.
