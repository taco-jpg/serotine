# SIP-5: Plugin system

- Status: Draft
- Type: Architecture / UX

## Summary

Introduce a lightweight Serotine plugin system so optional features can be added without turning every experiment into permanent core UI or protocol behavior.

## Goals

- Plugins can add commands, composer actions, message renderers, conversation tools, or optional protocol behavior.
- A plugin may be purely local or shared between participants.
- Installing a plugin must not silently change what another participant sees.
- Shared plugin behavior should be capability-negotiated: if both sides support the same plugin/version, the shared experience can activate.
- If only one side has a plugin, its local UI can still exist, but the other side should see only ordinary compatible Serotine content or nothing plugin-specific.
- Plugins should fail safely. A missing or broken plugin must not make the base conversation unreadable.

## Proposed model

Each plugin has a stable identifier, version, declared capabilities, and a small manifest. Serotine exposes narrow extension points rather than arbitrary access to all application internals.

Possible extension points include:

- slash commands such as `/summarize`
- composer buttons
- message actions
- conversation-side panels
- custom rendering for plugin-owned payloads
- optional negotiated conversation modes

Shared plugin payloads should include enough metadata to identify the plugin and version. Core Serotine should preserve compatibility and should never execute remote code supplied by a peer.

## Capability negotiation

Participants advertise supported plugin IDs and versions through an authenticated, non-secret capability description. A plugin requiring shared semantics becomes fully active only when the required participants support it.

For group chats, a plugin may define whether it requires every member or only the sender/receiver pair to support it.

## Privacy and permissions

Plugins should request only the minimum data they need. Access to message history, files, contacts, microphone, network services, or AI providers should be explicit rather than automatic.

A plugin should be removable without damaging ordinary message history.

## Non-goals

This proposal does not require a public plugin marketplace, arbitrary third-party JavaScript execution, or a stable external SDK in the first version. The first implementation can support a small set of first-party plugins while the API settles.
