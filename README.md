# Serotine

Browser-based, end-to-end encrypted conversations with device-local identities, an authenticated Cloudflare D1 relay, and optional direct WebRTC delivery.

## Run locally

Use Node.js 22.13 or newer and npm (the maintained lockfile is `package-lock.json`).

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open `http://localhost:3000`. Development uses OpenNext's local Cloudflare context and the `serotine_db` binding in `wrangler.toml`. No production credentials are needed for the local D1 database. Use two **separate browser profiles**, create an identity in each, exchange their full public addresses, and add each other as contacts.

Keep the conversation open to receive messages from that contact. History lives in IndexedDB on that browser. The download button next to Serotine creates a password-protected identity backup; the login screen restores that file. Backups restore keys and the address, **not** message history or contacts. Simultaneously using one identity on multiple devices does not synchronize history: whichever device acknowledges a queued message first collects it.

## Using conversations

- Unsent drafts survive reloads and switching contacts. Each draft belongs to one identity and contact, stays in browser storage, and is excluded from identity backups. A storage warning means the draft is only in memory; keep the tab open. A delayed send cannot clear a newer draft revision.
- Search a conversation with the magnifying-glass button. Previous/next controls (or Shift + Enter / Enter in the search field) move through matching messages saved on this browser; Escape closes search.
- While reading older messages, the new-message count and **Jump to latest** button let you return without losing your place. This count concerns the open conversation, not a background inbox.
- Filter contacts by name or address and use the pencil button to rename them. Contact changes refresh across tabs on the same browser.
- Backup downloads require matching passwords. Use **Show passwords** to check your entry before downloading. The restore screen also supports revealing the password.
- The **Reconnect** button retries the relay and refreshes saved history without reloading. Failed conversation initialization has its own retry control. Focusing a tab also refreshes history and the connection.
- Open tabs on the same browser refresh committed history using identity-scoped notifications. Notification payloads contain routing addresses, never plaintext messages or keys. If cross-tab messaging is unavailable, focus refresh still works. This does not synchronize different browser profiles or devices.
- Relay requests time out after 15 seconds so a stalled request does not leave the composer locked. **Unconfirmed · Retry** reuses the original message ID: a timeout cannot establish whether a remote write succeeded. A recent send from another tab remains pending; an abandoned pending attempt becomes retryable after 30 seconds.
- Drafts that cannot be written to browser storage remain in memory across conversation changes in the same tab. **Try saving draft again** retries persistence, and the browser may warn before closing a tab with unsaved text. Reloading or closing can still lose these memory-only drafts.
- Search highlights matching text and respects input-method composition. Each message has a **Copy** action, and the composer grows with multiline text. Screen readers get sender labels and arrival announcements without replaying restored history.
- Adding an address already in your contact list opens its conversation. The whole contact panel scrolls on short screens, including the add-contact form and expanded address.

- A blocked draft read can be retried with **Try loading draft again**; it does not overwrite the unread text. Failed cleanup of submitted text remains pending in this tab and deletes only the submitted revision, preserving newer edits.
- Creating and restoring identities are serialized with a browser Web Lock where supported, with a per-tab queue and a final storage comparison as fallback. Legacy identity reads no longer write during loading. Older browsers without Web Locks cannot guarantee atomic writes across tabs; use one tab for identity creation/restoration there.
- Browser storage/HTTPS problems on the login screen offer **Check again** instead of incorrectly requiring a backup restore.
- Confirmed outgoing messages cannot be downgraded by a slower retry in another tab. Local storage preserves the original text and timestamp for the same message ID, and retries of already-confirmed messages avoid another relay write.

## Verify and deploy

```sh
npm test
npm run typecheck
npm run build
```

Tests exercise the actual Web Crypto implementation and server actions against SQLite, with only the D1 binding substituted. They cover signed ownership, replay rejection, expired and tampered packets, recipient-scoped acknowledgments, sender-filtered inboxes, retry deduplication, rate limits, and relay failures. Draft regression tests also cover recipient/identity isolation, reloads, failed storage writes, and delayed-send races. They are not an independent security audit or a browser/network compatibility test.

This project deploys to **Cloudflare Workers with OpenNext**, not Pages or `next-on-pages`. `npm run build` must produce `.open-next/worker.js`; generated `.open-next` output is intentionally not committed. For Cloudflare Workers Builds, set the **Build command** to `npm run build` and the production **Deploy command** to `npm run deploy:built`. The normal deploy command uploads the Worker. The relay automatically creates any missing v2 tables and indexes on the first authenticated request through its existing D1 binding; no separate migration command or extra deployment-token database permissions are needed for this bootstrap. Keep `wrangler.toml` pointed at your intended D1 database and Worker. After authenticating Wrangler for that account:

```sh
npm run deploy
```

`0002_authenticated_transport.sql` defines the v2 relay, encrypted signal, and replay-prevention tables without deleting existing tables. Automatic setup uses the same additive statements, repairs missing indexes, checks required columns, and caches only successful readiness. Concurrent requests safely initialize independently; failed setup is retried. It never creates a database binding or alters incompatible existing tables. Explicit `npm run db:migrate:remote` remains available for operators and future migrations, but is not required to recover missing v2 tables. Deploying v2 requires both peers to reload into v2. Old unsigned queued messages and signals are not accepted as authenticated v2 traffic. Already-saved browser history is imported once for its original identity; legacy database tables are preserved. Do not roll back to the old unauthenticated public actions on an internet-facing deployment.

## Troubleshooting a relay outage

A generic relay error alone does not establish the cause. Do not clear browser data to fix a server outage: that can remove your identity and local history.

- **Automatic database setup:** after this version is deployed, valid requests create missing v2 tables and indexes automatically. No dashboard change is needed for a missing migration when `serotine_db` already points to a writable D1 database. Incompatible schemas, a missing binding, or service outages remain explicit failures.
- **Messaging is not configured:** check the Worker's `serotine_db` D1 binding against `wrangler.toml`.
- **Temporarily unavailable:** inspect Worker logs and D1 availability. Requests automatically retry; use **Reconnect** after service returns and retry each unconfirmed message using its existing bubble.
- For production Workers Builds, use `npm run build` followed by `npm run deploy:built`. Keep preview deployments bound to their intended database. Bootstrap runs through the configured binding, so it does not guess a database or require a separate authenticated Wrangler migration.

These diagnostics distinguish known setup failures without exposing query text or message data. Tests and local migrations do not verify the state of a deployed database.

## Delivery and security model

- An address is a P-256 public key. Its private key is created locally and stays in browser storage. Requests use ECDSA/SHA-256 proofs of possession of that existing P-256 identity, binding action, full payload, timestamp, and single-use nonce. The same underlying key currently serves ECDH and ECDSA for compatibility; separate certified signing and encryption identities are a future protocol change.
- Content and signaling are encrypted with ECDH-derived AES-256-GCM keys and fresh 96-bit IVs. Encrypted message envelopes bind protocol version, sender, recipient, UUID, timestamp, and content. Both relay and direct delivery validate these fields.
- Sends are durably queued at the relay before reporting success. The direct channel can deliver the same encrypted packet immediately; the receiver deduplicates its stable ID. “Sent to relay” is **not a delivered or read receipt**.
- A recipient acknowledges a message only after saving it locally. Fetching alone never deletes it. Inbox queries and acknowledgments are signed and recipient-scoped. Polling continues while a direct channel is open and retries relay errors. Signed cursor pagination processes one page at a time so unreadable rows cannot block later messages; those rows remain queued for another attempt.
- Queued messages expire after seven days. Queries exclude expired records; message writes purge expired ciphertext. Expired signaling and nonce records are also purged during their respective operations. This is logical application deletion, not a promise about provider backups or physical erasure.
- Sender writes have per-identity request and queue limits. These do not stop Sybil attacks or volumetric abuse. Configure Cloudflare request/rate controls and monitor resource usage before exposing a relay publicly.
- The relay can observe public routing addresses, message sizes, timing, and requests. WebRTC peers and STUN services can learn IP information. This is not an anonymity network.
- Verify contact addresses through a trusted independent channel. Static identity keys do not provide forward secrecy, key rotation, or a Signal-style ratchet. Anyone controlling the served JavaScript, the browser profile, an extension with sufficient access, or the device may access local keys and plaintext history. HTTPS and a trusted deployment are required.
- Identity backups use PBKDF2-SHA-256 (600,000 iterations, random salt) and AES-GCM. The backup password cannot be recovered. Legacy unencrypted encryption-key JSON can also be imported.

The interface does not promise disappearing messages, metadata secrecy, or audited security. Production rollout still requires deployment configuration, real-browser/two-device validation, operational abuse controls, and independent security review appropriate to the intended use.
