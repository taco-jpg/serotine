# SIP-7: AI summary plugin

- Status: Draft
- Type: Plugin / AI
- Requires: SIP-5

## Summary

Add a first-party AI plugin that can summarize unread or unanswered conversation history with a slash command such as `/summarize`.

## Core behavior

- `/summarize` summarizes the block of messages since the user's last meaningful reply, or another clearly defined unread/unanswered range.
- The result is shown locally by default.
- The user may explicitly send the generated summary as an ordinary message if desired.
- If the peer does not have the plugin, they do not receive or see local plugin UI or local-only summaries.
- If a future shared AI action requires both sides, Serotine should negotiate that through SIP-5 rather than assuming support.

## AI provider

The initial intended provider is Cloudflare AI. Provider credentials and deployment details are intentionally left for implementation later.

The plugin interface should avoid hard-coding one model/provider so a future provider can be swapped without changing the conversation protocol.

## Privacy

Before sending message content to an AI provider, the plugin must make the data flow obvious to the user. It should minimize the amount of history transmitted and avoid sending unrelated contacts, files, keys, or metadata.

A local-only summary should not become part of conversation history unless the user explicitly sends it.

## Possible future commands

- `/summarize`
- `/catchup`
- summarize selected messages
- summarize only unanswered questions

These are ideas, not required syntax for the first version.
