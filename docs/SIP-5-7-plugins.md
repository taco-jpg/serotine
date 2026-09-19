# First-party plugins (SIP 5–7)

This implements the first-party scope of [SIP 5](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-5-plugin-system.md), the [Private Chat plugin](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-6-private-chat-plugin.md), and the [AI Summary plugin](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-7-ai-summary-plugin.md).

## Plugin controls

Open **Inbox settings → Plugins** to review the built-in plugins and their permissions. Enabling a plugin requires accepting its stated access. Installation and permission choices belong to the current identity in this browser; they are not included in full backups or automatically copied to linked devices. Disable or remove a plugin from the same panel.

The first release includes only compiled first-party plugins. It does not load JavaScript, URLs, or executable modules supplied by another participant. Stable identifiers, versions, permission manifests, and narrow extension points keep optional features separate from ordinary messaging. Peer compatibility never grants access to local history or an AI service.

| Plugin | Identifier | Local access |
| --- | --- | --- |
| Private Chat | `serotine.private-chat` | Optional encrypted private-chat controls and capability negotiation |
| AI Summary | `serotine.ai-summary` | A bounded ordinary-text range, with separate confirmation before each provider request |

Missing, disabled, or unsupported plugins do not prevent ordinary messaging. Removing either plugin does not delete ordinary conversation history.

## Private Chat

Both participants must enable a compatible Private Chat plugin. Open **Private chat settings** and check the other participant's support before enabling a timer. The check uses signed, encrypted capability events and a fresh challenge/response; restored history alone cannot establish current support. An unavailable or incompatible participant produces an explanation instead of a false privacy indicator.

The existing 5-minute, 1-hour, and 24-hour timers, expiring access keys, and destruction controls use the existing authenticated encrypted transport. Private content remains excluded from saved drafts, search, pins, and full backups. Receiving clients retain the core validation, expiration, and destruction handling needed to protect existing messages even when the optional plugin is disabled.

Disabling a plugin does not cancel existing timers or silently send an intended private message as ordinary retained text. Private sends require current local permission and peer compatibility, including when queued work is retried. Turning off a timer and destroying existing private history remain available as recovery actions.

Compatibility means the other client advertised supported behavior; it cannot prove that a participant uses unmodified software. Expiration and destruction cannot recall screenshots, copied text, or content retained outside cooperating clients. Encrypted server copies still follow the relay retention policy.

## AI Summary

Enable **AI Summary**, then use **Summarize** or enter `/summarize` in a supported conversation. The command opens a local dialog and is not sent as a chat message.

The preview selects eligible ordinary messages since the last meaningful reply you sent. If there is no eligible reply, it uses recent history from the last 24 hours. The selection is bounded to 80 messages, 12,000 total text characters, and 2,000 characters per message. The dialog reports truncation and shows the text that will be submitted. Private messages, access-key messages, expiring content, attachments, polls, and failed or pending sends are excluded.

Each generation requires confirmation that the previewed text will be sent to this Serotine server and Cloudflare Workers AI. Participants use temporary labels such as `You` and `Participant 1`; the provider request does not add public addresses, contact names, file contents, or conversation identifiers. Text may itself contain identifying or sensitive information, so review the preview before confirming. The authenticated request to Serotine includes the requesting identity's public key; that proof is not part of the provider prompt.

Summaries stay in the open dialog's memory. They are not saved as chat history, drafts, or backup content. Closing the dialog or changing conversations discards the result. **Send summary** is a separate explicit action that sends ordinary chat text. Review generated text before sending it; an AI summary can omit context or make mistakes.

Disabling the plugin cancels its local workflow. Cancelling a request cannot recall content already submitted to the provider. Provider errors leave ordinary messaging available and do not automatically retry or send a summary.

## Cloudflare setup

The initial adapter uses a server-side Cloudflare Workers AI binding named `AI`. The binding and optional model configuration belong to the existing Worker deployment; no provider secret is sent to the browser or another participant. See the [official Workers AI binding instructions](https://developers.cloudflare.com/workers-ai/configuration/bindings/).

AI processing starts disabled in `wrangler.toml`. To activate it for a reviewed deployment, uncomment the `[ai]` section with `binding = "AI"` and change `SUMMARY_AI_ENABLED` to `"true"`. This enables provider usage under the site's Cloudflare account. Keeping the binding commented lets local browser tests run without Cloudflare inference access.

The default model is `@cf/meta/llama-3.1-8b-instruct`. `SUMMARY_AI_MODEL` can select another compatible `@cf/` text-generation model in deployment configuration; a browser cannot choose a model or provider URL. A narrow provider adapter keeps the conversation protocol independent of this choice. A deployment without an enabled provider returns a clear unavailable message.

Only explicit signed requests can invoke summarization. The route bounds request bodies, input text, generated output, and request duration; it enforces replay protection, retired-identity checks, and request limits. The application does not save or log summary text or the submitted history. Standard infrastructure and provider processing policies still apply.

## Validation

Use the ordinary repository checks plus the focused plugin browser suite:

```sh
npm test
npm run typecheck
npm run lint
npm run test:plugins
npm run test:private
npm run build
npm run deploy:check
```

Browser suites run sequentially because each starts a local Next server. They require Playwright Chromium; `SEROTINE_CHROMIUM_PATH` can select an existing Chromium executable. Each suite creates isolated synthetic D1 state using the version 1 local storage adapter, with remote bindings and outbound browser requests disabled. Production version 2 storage routing is covered separately by the unit and local workerd tests.

Tests use synthetic identities and mocked AI output; a real Cloudflare inference request is a separate deployment check. No test should transmit a person's actual conversation to a provider.
