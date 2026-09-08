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

## Verify and deploy

```sh
npm test
npm run typecheck
npm run build
```

Tests exercise the actual Web Crypto implementation and server actions against SQLite, with only the D1 binding substituted. They cover signed ownership, replay rejection, expired and tampered packets, recipient-scoped acknowledgments, sender-filtered inboxes, retry deduplication, rate limits, and relay failures. They are not an independent security audit or a browser/network compatibility test.

This project deploys to **Cloudflare Workers with OpenNext**, not Pages or `next-on-pages`. `npm run build` must produce `.open-next/worker.js`; generated `.open-next` output is intentionally not committed. For Cloudflare Workers Builds, set the **Build command** to `npm run build` so a fresh OpenNext bundle exists before the configured deploy or preview-deploy command runs. Keep `wrangler.toml` pointed at your intended D1 database and Worker. After authenticating Wrangler for that account:

```sh
npx wrangler d1 migrations apply serotine-db --remote
npm run deploy
```

Apply migrations before deploying code. `0002_authenticated_transport.sql` creates the v2 relay, encrypted signal, and replay-prevention tables without deleting existing tables. Deploying v2 requires both peers to reload into v2. Old unsigned queued messages and signals are not accepted as authenticated v2 traffic. Already-saved browser history is imported once for its original identity; legacy database tables are preserved. Do not roll back to the old unauthenticated public actions on an internet-facing deployment.

## Delivery and security model

- An address is a P-256 public key. Its private key is created locally and stays in browser storage. Requests use ECDSA/SHA-256 proofs of possession of that existing P-256 identity, binding action, full payload, timestamp, and single-use nonce. The same underlying key currently serves ECDH and ECDSA for compatibility; separate certified signing and encryption identities are a future protocol change.
- Content and signaling are encrypted with ECDH-derived AES-256-GCM keys and fresh 96-bit IVs. Encrypted message envelopes bind protocol version, sender, recipient, UUID, timestamp, and content. Both relay and direct delivery validate these fields.
- Sends are durably queued at the relay before reporting success. The direct channel can deliver the same encrypted packet immediately; the receiver deduplicates its stable ID. “Sent to relay” is **not a delivered or read receipt**.
- A recipient acknowledges a message only after saving it locally. Fetching alone never deletes it. Inbox queries and acknowledgments are signed and recipient-scoped. Polling continues while a direct channel is open and retries relay errors.
- Queued messages expire after seven days. Queries exclude expired records; message writes purge expired ciphertext. Expired signaling and nonce records are also purged during their respective operations. This is logical application deletion, not a promise about provider backups or physical erasure.
- Sender writes have per-identity request and queue limits. These do not stop Sybil attacks or volumetric abuse. Configure Cloudflare request/rate controls and monitor resource usage before exposing a relay publicly.
- The relay can observe public routing addresses, message sizes, timing, and requests. WebRTC peers and STUN services can learn IP information. This is not an anonymity network.
- Verify contact addresses through a trusted independent channel. Static identity keys do not provide forward secrecy, key rotation, or a Signal-style ratchet. Anyone controlling the served JavaScript, the browser profile, an extension with sufficient access, or the device may access local keys and plaintext history. HTTPS and a trusted deployment are required.
- Identity backups use PBKDF2-SHA-256 (600,000 iterations, random salt) and AES-GCM. The backup password cannot be recovered. Legacy unencrypted encryption-key JSON can also be imported.

The interface does not promise disappearing messages, metadata secrecy, or audited security. Production rollout still requires deployment configuration, real-browser/two-device validation, operational abuse controls, and independent security review appropriate to the intended use.
