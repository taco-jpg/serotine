---
sip: 16
title: Unified product design and motion
author: louisliu
status: Accepted
created: 2026-09-14
updated: 2026-09-19
---

# SIP-16: Unified product design and motion

## Implementation status — 2026-09-19

Implemented in [PR #67](https://github.com/taco-jpg/serotine/pull/67); awaiting merge and deployment validation. Shared semantic theme, typography, spacing, control, and motion tokens connect the landing page and application while preserving preset/custom SIP-2 themes. Motion is reduced or removed under prefers-reduced-motion and preserves keyboard focus. Synthetic browser checks exercise responsive layouts, themes, reduced motion, and interaction state; they do not substitute for production or physical-device checks.

## Summary

Unify Serotine's public landing page and authenticated application under one visual and interaction language, while adding restrained motion and richer interaction feedback so the product feels alive rather than static.

The target is not a large redesign for its own sake. Preserve the current restrained, human visual direction, but make the landing page, inbox, conversations, communities, settings, dialogs, and empty states feel like one product with shared typography, spacing, surfaces, controls, icon treatment, and motion behavior.

## Motivation

A polished landing page loses credibility if entering the product feels like switching to a different design system. The reverse is also true: an expressive product shell can make a quiet landing page feel unfinished or disconnected.

Serotine already has theme work under SIP-2 and recent app-wide visual refinements. This proposal addresses a different layer: **coherence and interaction behavior** across the whole product.

The current experience can also feel overly static. Adding movement everywhere would make it noisy and cheap; adding no movement makes navigation, state changes, and reordering feel abrupt. The goal is purposeful motion that communicates continuity.

## Proposal

### One product language

The landing page and authenticated app should share the same core design tokens and recognizable visual grammar:

- typography scale and text hierarchy;
- spacing rhythm and content widths;
- corner radii and border treatment;
- surface elevation and background hierarchy;
- accent usage;
- button, input, menu, dialog, tooltip, and focus behavior;
- icon size and stroke conventions;
- loading, empty, success, warning, and error states.

The landing page may be more expressive than the inbox, but it should feel like the same product at a different level of intensity. Avoid maintaining a separate one-off landing-page aesthetic that cannot survive contact with the actual application.

### Preserve SIP-2 theming

Build the unified language on semantic design tokens rather than hard-coded colors. Existing light/dark behavior, preset palettes, and custom themes from SIP-2 must continue to work.

Motion, spacing, shape, and hierarchy must not depend on a particular palette. A theme should change appearance without breaking the product's structural identity.

### Restrained product energy

Add visual interest through interaction and state, not decorative clutter.

Suitable examples include:

- subtle message or conversation entrance transitions when content genuinely appears;
- small hover/focus responses that reinforce clickability;
- shared-element or position transitions when a panel expands, collapses, or changes state;
- smooth disclosure of menus, dialogs, search, and settings sections;
- quiet ambient behavior in the landing-page conversation visual where it helps explain the product.

Avoid gratuitous floating objects, constant background animation, large parallax effects, exaggerated springs, bouncy controls, random 3D elements, or motion that competes with reading messages.

### Motion system

Define shared motion tokens instead of inventing timings per component. At minimum, standardize:

- quick feedback transitions;
- ordinary enter/exit transitions;
- list movement/reordering transitions;
- panel expansion/collapse;
- modal/dialog transitions.

Use short, calm easing curves. Motion should normally finish quickly enough that it never delays an action. The interface must remain fully usable if animation is interrupted.

A state change should animate only when the motion explains **what changed and where it went**. Do not animate unrelated content merely because the route changed.

### Navigation continuity

Moving between inbox, direct messages, groups, communities, and settings should preserve enough visual continuity that the user understands where they are. Avoid full-view replacement flashes when a smaller state transition can communicate the change.

On desktop, persistent navigation regions should remain visually stable while conversation content changes. On mobile, transitions should reinforce forward/back navigation without imitating a native app so aggressively that web behavior becomes confusing.

### Landing page

The landing page should communicate what Serotine is before relying on style alone. Its visual thesis should be conversation and connection, not an unrelated decorative object.

Keep the current restrained direction, but make the page feel active through meaningful product-adjacent interaction. A visitor should understand that Serotine is a messaging product, see a credible hint of the real interaction model, and reach the product without encountering a completely different aesthetic after sign-in.

### Density and responsiveness

Do not use motion as a substitute for layout quality. The unified system must work on narrow phones, normal laptops, and large screens. Preserve compact, information-dense conversation views where useful while allowing more breathing room on marketing surfaces.

## Security & Privacy

Animations and previews must not expose real private message content on public surfaces, logs, screenshots generated by the app, or unauthenticated routes. Landing-page examples should use static/demo content.

Do not fetch remote decorative assets in a way that bypasses existing privacy expectations or theme import restrictions.

Motion must respect `prefers-reduced-motion`. Reduced-motion mode should keep the same information architecture and state clarity with transitions removed or simplified.

## Compatibility

This SIP should not require a messaging protocol change. It must preserve SIP-2 themes and existing accessibility semantics.

Components introduced under this proposal should prefer shared primitives/tokens so old and new screens do not diverge again. A staged rollout is acceptable; individual routes can adopt the system incrementally as long as mixed states are temporary and visually coherent.

## Alternatives

- **Redesign only the landing page:** easier, but preserves the disconnect between public identity and product experience.
- **Redesign only the app:** improves daily use while leaving first impression and product identity fragmented.
- **Add large amounts of animation:** increases novelty but conflicts with Serotine's restrained direction and can make a communication product exhausting to use.
- **Keep everything static:** avoids motion bugs but preserves abrupt state changes and makes an otherwise refined interface feel rigid.

## Open Questions

- Which existing components should become the canonical shared primitives for both public and authenticated routes?
- What exact motion durations/easing values feel responsive across low-end phones and desktop browsers?
- Which landing-page interaction best communicates the product without becoming a fake screenshot or a heavy demo application?

## Implementation Notes

Start by inventorying duplicate visual primitives and hard-coded landing/app differences. Establish shared semantic tokens and a small motion vocabulary before changing many screens.

Use visual-regression and browser checks for light/dark/custom themes, reduced motion, keyboard focus, narrow layouts, and route transitions. Performance tests should ensure that motion relies primarily on composited properties and does not introduce continuous layout thrashing or expensive background work.
