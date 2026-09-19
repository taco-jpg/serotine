---
sip: 7
title: AI summary plugin
author: louisliu
status: Accepted
created: 2026-09-12
updated: 2026-09-19
---

# SIP-7: AI summary plugin

## Implementation status — 2026-09-19

The consented summary workflow and server-side Workers AI adapter were merged in [PR #66](https://github.com/taco-jpg/serotine/pull/66). The exact bounded ordinary-text preview requires explicit confirmation; results stay local until separately sent. AI starts disabled in deployment configuration. Unit and browser tests use synthetic conversations and mock inference; enabling the binding and verifying a real provider request remain deployment checks. See the [configuration and limits](https://github.com/taco-jpg/serotine/blob/main/docs/SIP-5-7-plugins.md).

## Summary

Add a first-party AI plugin that can summarize unread or unanswered conversation history with a slash command such as `/summarize`. This proposal depends on SIP-5.

## Motivation

Long or fast-moving conversations can be difficult to catch up on, especially when the user has not replied for a while. A local-first summary action can reduce that friction without forcing AI-generated content into the conversation or making AI a core messaging dependency.

## Proposal

### Core behavior

- `/summarize` summarizes the block of messages since the user's last meaningful reply, or another clearly defined unread/unanswered range.
- The result is shown locally by default.
- The user may explicitly send the generated summary as an ordinary message if desired.
- If the peer does not have the plugin, they do not receive or see local plugin UI or local-only summaries.
- If a future shared AI action requires both sides, Serotine should negotiate that through SIP-5 rather than assuming support.

### AI provider

The initial intended provider is Cloudflare AI. Provider credentials and deployment details are intentionally left for implementation later.

The plugin interface should avoid hard-coding one model/provider so a future provider can be swapped without changing the conversation protocol.

### Possible future commands

- `/summarize`
- `/catchup`
- summarize selected messages
- summarize only unanswered questions

These are ideas, not required syntax for the first version.

## Security & Privacy

Before sending message content to an AI provider, the plugin must make the data flow obvious to the user. It should minimize the amount of history transmitted and avoid sending unrelated contacts, files, keys, or metadata.

A local-only summary should not become part of conversation history unless the user explicitly sends it. Provider credentials must stay out of conversation payloads and client-visible logs.

## Compatibility

The plugin is local by default and should not require peer support for local summaries. Conversations must remain fully usable without the plugin, and removing or disabling it must not alter ordinary message history.

## Alternatives

Build summarization directly into core Serotine, which reduces plugin overhead but permanently couples messaging to an AI feature. Another option is a separate external bot, but that would require sending conversation data to a participant-like service and would change the privacy model more substantially.

## Open Questions

- What exactly counts as the unread or unanswered range?
- Should summaries be generated on demand only, or may the plugin cache local results?
- Which provider and model constraints are acceptable for latency, cost, and privacy?
- Should selected-message summarization be part of the first version?

## Implementation Notes

Requires SIP-5. Start with an explicit local `/summarize` action and a narrow provider adapter. Keep generated summaries outside persistent conversation history unless the user explicitly sends them.
