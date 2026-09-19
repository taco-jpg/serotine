---
sip: 5
title: Plugin system
author: louisliu
status: Final
created: 2026-09-12
updated: 2026-09-19
---

# SIP-5: Plugin system

## Implementation status — 2026-09-19

The first-party plugin foundation was merged in [PR #66](https://github.com/taco-jpg/serotine/pull/66). It provides bundled manifests and versions, identity/browser-scoped installation and explicit permissions, enable/disable/remove controls, local commands, and authenticated peer capability negotiation. This release does not load arbitrary third-party code. See the [implementation guide](https://github.com/taco-jpg/serotine/blob/main/docs/SIP-5-7-plugins.md).

## Summary

Introduce a lightweight Serotine plugin system so optional features can be added without turning every experiment into permanent core UI or protocol behavior.

## Motivation

Serotine needs room for optional features such as commands, composer actions, private-chat behavior, and AI helpers without forcing every experiment into core UI or protocol semantics. A bounded plugin system keeps the base messenger smaller while still allowing first-party extensions to evolve independently.

## Proposal

### Goals

- Plugins can add commands, composer actions, message renderers, conversation tools, or optional protocol behavior.
- A plugin may be purely local or shared between participants.
- Installing a plugin must not silently change what another participant sees.
- Shared plugin behavior should be capability-negotiated: if both sides support the same plugin/version, the shared experience can activate.
- If only one side has a plugin, its local UI can still exist, but the other side should see only ordinary compatible Serotine content or nothing plugin-specific.
- Plugins should fail safely. A missing or broken plugin must not make the base conversation unreadable.

### Proposed model

Each plugin has a stable identifier, version, declared capabilities, and a small manifest. Serotine exposes narrow extension points rather than arbitrary access to all application internals.

Possible extension points include:

- slash commands such as `/summarize`
- composer buttons
- message actions
- conversation-side panels
- custom rendering for plugin-owned payloads
- optional negotiated conversation modes

Shared plugin payloads should include enough metadata to identify the plugin and version. Core Serotine should preserve compatibility and should never execute remote code supplied by a peer.

### Capability negotiation

Participants advertise supported plugin IDs and versions through an authenticated, non-secret capability description. A plugin requiring shared semantics becomes fully active only when the required participants support it.

For group chats, a plugin may define whether it requires every member or only the sender/receiver pair to support it.

### Non-goals

This proposal does not require a public plugin marketplace, arbitrary third-party JavaScript execution, or a stable external SDK in the first version. The first implementation can support a small set of first-party plugins while the API settles.

## Security & Privacy

Plugins should request only the minimum data they need. Access to message history, files, contacts, microphone, network services, or AI providers should be explicit rather than automatic.

A plugin should be removable without damaging ordinary message history. Core Serotine must not execute arbitrary remote code received from peers, and capability negotiation must not be treated as authorization for privileged local resources.

## Compatibility

Missing or unsupported plugins must not make ordinary conversations unreadable. Shared plugin payloads should either degrade into compatible base content or remain safely ignorable. Removing a plugin should preserve ordinary messages and avoid corrupting stored conversation state.

## Alternatives

Keep every optional feature in core Serotine. This is simpler initially but makes experiments harder to isolate and permanently expands the core surface. A full third-party extension SDK is another option, but it adds sandboxing, distribution, and compatibility commitments before the extension points are stable.

## Open Questions

- Which extension points belong in the first version?
- How should plugin versions and compatibility ranges be represented?
- Which permissions need explicit per-plugin consent?
- How should group capability negotiation work when only some members support a plugin?

## Implementation Notes

Start with first-party plugins and a narrow manifest/API. Add extension points only when a concrete plugin needs them, and keep local plugin state separate from core conversation data where practical.
