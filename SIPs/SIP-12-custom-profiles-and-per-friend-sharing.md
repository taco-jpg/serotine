---
sip: 12
title: Custom profiles and per-friend sharing
author: sodium-qed
status: Draft
created: 2026-09-14
related: SIP-11, SIP-1, SIP-2
---

# SIP-12: Custom profiles and per-friend sharing

## Summary

Give Serotine users expressive profiles with GIF banners, static or animated profile pictures, an optional display name, a bio, a status, and profile colors. All of these features are available without a paid subscription.

When adding or accepting a friend, choose exactly which profile fields to share with that person using separate checkboxes. Optional profile information is private by default. Being in the same conversation or community does not grant access, and friendship alone does not share every field.

This is a proposal for discussion, not an implementation. It builds on [SIP-11](SIP-11-custom-user-avatars.md). If adopted, its explicit sharing rules replace SIP-11's assumption that a custom avatar is visible wherever an identity appears, and animated profile pictures become supported rather than an open question.

## Motivation

The requested experience is the expressive, polished feel of Discord-style profiles without requiring a Nitro-like subscription. A friend should be able to personalize their profile with a GIF banner and picture while deciding who sees each part.

For example, someone might share their picture with a close friend but keep their banner private, or share a banner while keeping their picture hidden. A stranger in a shared community should not gain access to either field. Profile customization and control over its audience should be designed together.

## Proposal

### Profile editor

Add an **Edit profile** screen with a live profile-card preview. Users can set, replace, or remove each optional field independently.

| Field | Customization |
| --- | --- |
| Profile picture | Static image or animated GIF; square crop with the existing avatar presentation |
| Banner | Static image or animated GIF; wide crop and position preview |
| Display name | Optional profile name, separate from the authenticated address and private local nicknames |
| About me | Short plain-text bio |
| Status | Short custom text with an optional emoji; does not imply online presence |
| Profile colors | Accent and background colors selected through bounded controls |

Allow common supported static formats such as PNG, JPEG, and WebP alongside GIF. Preserve animation when saving an animated picture or banner. Show upload limits before selection and a clear error for files that cannot be processed.

Keep cards readable on mobile and in compact views. Profile colors affect the profile card only, with readable text and controls in every existing app theme. This proposal does not redesign the landing page or app themes. Arbitrary HTML, scripts, custom CSS, music, and a public profile directory are outside its scope.

### Choose what this friend can see

Both **Add friend** and **Accept friend** include a section labeled **Share with this friend**:

- [ ] Profile picture
- [ ] Banner
- [ ] Display name
- [ ] About me
- [ ] Status
- [ ] Profile colors

All boxes start unchecked. Adding a friend works with every box unchecked. A preview labeled **What this friend will see** updates as selections change; a separate **View as a stranger** preview shows the fallback presentation.

Selections made while sending a request are saved locally and take effect only after friendship is established. Pending, rejected, or canceled requests do not receive optional fields. The person accepting chooses their own sharing settings independently.

Permissions are directional: Alice sharing her banner with Bob does not give Alice access to Bob's banner. Each permission covers the field's current value and future edits while enabled. Explain this in the sharing UI. New fields introduced later stay private until explicitly selected.

### Visibility rules

| Viewer | What they can see |
| --- | --- |
| Profile owner | Their complete profile and sharing previews |
| Accepted friend with selected boxes | Only the selected fields |
| Accepted friend with no selected boxes | Fallback identity presentation |
| Pending requester, stranger, or community member who is not a friend | Fallback identity presentation |
| Removed or blocked friend | No continuing access to optional fields |

Fallback presentation means the existing minimum identity information needed in that context and a generic/generated avatar. It contains no custom banner, picture, bio, status, display name, or profile colors. This proposal hides optional customization; it does not promise to hide the address or identifier already needed to communicate or verify identity.

Apply the same viewer-specific rules to profile cards, message authors, conversation rows, group and community member lists, mentions, search, notifications, and call participant cards. Community ownership or moderation does not automatically grant profile access. A participant who can see a picture must not cause it to be included in a shared message or member payload delivered to everyone.

Existing local-only nicknames remain local and independent of the shared display name. Profile pictures and names never replace identity verification.

### Change or stop sharing

Each friend's menu includes **Profile sharing**, using the same checkboxes and preview. Changing one friend's choices does not affect other friends. Removing a profile field stops sharing it with everyone.

Disabling a field stops future delivery and retrieval for that friend. Supported clients clear the field and its cached display after receiving the change. Unfriending or blocking revokes all grants, and re-adding the person starts with fresh unchecked choices.

Offline clients may display previously received data until they reconnect and process the revocation. Previously saved files, screenshots, or copies retained by a modified client cannot be erased remotely; the interface must not promise that they can.

## Security & Privacy

Enforce permissions before transmitting profile fields, media references, or decryption material. Hiding a rendered element is insufficient. An unauthorized viewer must not be able to fetch a hidden image through a public media URL, alternate endpoint, community payload, or stale permission cache.

Authenticate the profile owner and the viewing identity using Serotine's existing identity model. Authorize each field separately and fail closed when friendship, permission, or client capability cannot be established. Reuse authenticated encrypted delivery where available. Relays should not need plaintext optional profile fields or an openly readable profile directory.

Profile media needs the same audience restrictions as profile text. The implementation may use authenticated retrieval or encrypted media with recipient-scoped key delivery, but it must document how revocation and replacement work. A former friend must not receive future versions through an old URL or reusable decryption key. Previously delivered ciphertext and keys cannot be recalled.

Validate actual image content, bound decoded dimensions and animation frame counts as well as file size, strip unnecessary metadata, and reject active content. Use Serotine-managed upload/delivery rather than loading arbitrary user-supplied remote URLs in viewers' browsers. Apply storage and update-rate limits to keep animated profiles practical.

## Compatibility

Profiles and grants are optional additions to the existing identity model. Existing contacts start with all new sharing grants disabled; migration must not silently expose an existing picture to every friend or community. Keep locally saved customization available for the owner to review and share explicitly.

Clients that cannot honor the sharing model receive only fallback identity data. They can continue messaging normally. Unsupported animation uses a still frame, and reduced-motion or disabled-autoplay preferences are respected. Pause offscreen animation and load media only when an authorized view needs it.

Missing, invalid, or unavailable profile media falls back cleanly without preventing messaging. Profile fields are resolved by identity and viewer rather than copying profile content into every message.

## Implementation Notes

Keep one profile per identity and a separate directional set of allowed fields for each friend. Use a shared authorization and rendering path across all profile surfaces. Store profile versions and revocation state so delayed updates cannot restore a revoked field; synchronize permissions securely across the owner's supported devices. If state is uncertain after restore or synchronization, keep sharing off until reconciled.

Coordinate avatar handling with SIP-11 and community views with [SIP-1](SIP-1-public-communities-and-channels.md). Reuse the current media pipeline where it can meet these privacy requirements. Profile colors are independent of the app theme work in [SIP-2](SIP-2-expanded-and-custom-themes.md).

### Acceptance checks

1. A user can create, preview, replace, and remove a GIF banner and static or animated profile picture without payment.
2. Add/accept flows allow every box to remain unchecked and disclose nothing while a request is pending.
3. Alice shares only her banner with Bob: Bob sees that banner and a fallback avatar; Alice gains no reciprocal access.
4. A different friend receives only their own selected fields. A stranger in the same community sees none of Alice's optional profile information, including through media retrieval.
5. Updating a shared field reaches authorized friends. A newly introduced field remains private.
6. Disabling sharing, removing a field, blocking, or unfriending stops future access; connected clients clear the display and delayed updates cannot restore it. Re-adding starts with empty grants.
7. Old clients, offline/reconnecting clients, missing media, mobile layouts, and reduced-motion preferences behave as described above.
8. Malformed, oversized, or excessively complex images are rejected, and profile animation does not block chat use.

## Open Questions

- What separate byte, dimension, frame-count, and duration limits should pictures and banners use?
- What text limits and banner aspect ratio best fit the current mobile and desktop layouts?
- Which existing authenticated media and encrypted synchronization mechanisms can support field-level grants and revocation?

These implementation choices remain open; private defaults, per-friend field selection, free customization, and GIF support are part of the proposed behavior.
