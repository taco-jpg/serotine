# Serotine

Browser-based, end-to-end encrypted messaging with device-local identities and an authenticated Cloudflare D1 relay. No email address or phone number is required.

## Conversations

- **Group chats:** create a named group, add contacts, manage membership, and leave. The creator manages membership and the group name. Groups support up to twenty people.
- **Inbox:** all conversations receive messages while Serotine is open, with unread counts and recent-message previews. Unknown people appear in message requests.
- **Notifications:** explicitly enable browser notifications, then choose all messages, mentions only, or muted for each conversation. Notifications use a generic preview. Serotine must remain open; this release does not include closed-app push delivery.
- **Mentions:** type `@` in the message box to search conversation members. Use arrow keys and Enter/Tab, or click a result, to insert a mention. Editing or deleting its text removes that notification target.
- **Replies and pins:** reply to a particular message, jump to the original, and keep important messages in the pinned panel.
- **Editing and receipts:** edit your own text with an edited label. Sending, relay confirmation, delivery, and optional read receipts are separate states.
- **Shared files and links:** browse a conversation's attachments and links together. Files are limited to 10 MiB, encrypted in chunks, and checked against a SHA-256 digest before opening or downloading. Supported images and audio have inline previews; other formats download as files.
- **Adding files:** drop files anywhere in the open chat, paste files into the message box, or use Attach. Up to eight files can wait in the preview queue; each requires an explicit Send. Pending file selections stay in memory and do not survive navigation or reload.
- **Auto compact files:** an optional browser-local setting losslessly compresses supported files to `.gz` when it saves at least 5% and 1 KiB. Recipients extract the downloaded archive. Photos, audio, video, and common compressed formats keep their original format. Source files up to 50 MiB can be compacted if the result fits the 10 MiB send limit.
- **Invites:** copy an invitation link containing only your public address. The recipient explicitly adds you; opening a link does not automatically trust an identity.
- **Search:** search all locally saved messages, filenames, and links, then jump to the matching conversation. Conversation search remains available.
- **Polls:** create a question with options and let each participant choose or change their vote.
- **Voice messages:** record, preview, send, or cancel an audio message. Microphone access is requested only when recording. Voice messages use the same attachment size limit.
- **Message yourself:** your own address opens a normal conversation. Send yourself text, files, links, and voice messages using the normal composer.
- **Backups and linked devices:** export a password-encrypted full backup containing identity, contacts, legacy history, message events, attachment chunks, and preferences. Restore it on another device to link that device and synchronize retained incoming and outgoing events.
- **Message requests and blocking:** accept unfamiliar senders, block them, or unblock them later. Muted and unaccepted conversations do not generate notifications.
- **Math and code:** render inline/display math and fenced code without interpreting raw HTML. Math rendering disables trusted commands.

Drafts stay local to each browser and conversation. Backups do not include drafts. Keep a tab open if it warns that a draft could not be saved. Failed outgoing events remain locally available for explicit retry, retaining their original IDs and recipient lists.

## Run locally

Use Node.js 22.13 or newer and npm:

```sh
npm ci
npm run db:migrate:local
npm run dev
```

Open `http://localhost:3000`. Development uses OpenNext's local Cloudflare context and the `serotine_db` binding in `wrangler.toml`; production credentials are not required. Use separate browser profiles to test different identities. To test linked devices, restore the same full backup into another profile.

## Backups and synchronization

Open **Backups and linked devices** to download an encrypted snapshot, or **Link another device** for transfer instructions. Use a password of at least twelve characters and keep it separate from the backup file. The password cannot be recovered. Existing identity-only backups remain importable, but naturally contain no chat history.

The relay retains new encrypted events for seven days. Each browser tracks its own position in a non-destructive feed that includes both received and sent events. Reading on one device does not remove another device's copy. A new device obtains older history from the full backup and then catches up from the retained feed. A device offline beyond the retention window may need a newer full backup. Contact aliases, notification preferences, and drafts are device-local after the initial transfer.

Linked devices share the same identity private key. This release does not support revoking only one linked device. A lost or compromised identity requires creating a new identity and sharing its new address. Browser storage and exported snapshots contain sensitive information; clearing site data without a usable backup can lose local history.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

For browser integration, run `npx playwright install chromium` once, then `npm run test:browser`. The smoke test starts a local server and uses synthetic identities to exercise actual D1 traffic, groups, attachments, voice recording, backups, linked browsers, and the mobile layout. `SEROTINE_CHROMIUM_PATH` can point to an existing Chromium executable.

Tests cover the actual Web Crypto and SQLite implementations alongside controlled browser/storage boundaries. They exercise authenticated relay access, replay protection, identity scoping, retained synchronization, group authorization, message controls, attachment integrity, and encrypted backups. Automated tests are not an independent security audit or a substitute for real-device deployment checks.

## Deployment

Deploy to **Cloudflare Workers with OpenNext**. Keep the `serotine_db` D1 binding in `wrangler.toml` pointed at the intended database. For Workers Builds, use `npm run build` as the build command and `npm run deploy:built` as the production deploy command. After authenticating Wrangler for that account:

```sh
npm run deploy
```

Both the existing relay schema and the new event tables initialize additively on authenticated requests. The new schema does not delete the old v2 queue or browser history. Reload both clients after deployment to use the new event protocol. Old clients can still send legacy messages, which the new identity-wide compatibility inbox can collect; old clients cannot display new group, file, or event messages. Upgrade both participants for normal conversations.

Files sent by the earlier attachment release remain readable. The compatibility inbox accepts its v3 envelopes (up to four files totaling 1 MiB) and saves the files before acknowledging the queued message. Existing local attachments, including unconfirmed sends, migrate into the current conversation view and remain included in full backups. New sends support up to 10 MiB using the same 30 KiB chunk format. Update both participants to receive files above the previous 2 MiB limit.

The new retained event log is separate from the legacy acknowledged queue. It uses a monotonically increasing sequence for stable pagination, including multiple senders at the same timestamp. Each sender is limited to 2,000 event writes per minute and 16,000 retained rows totaling 512 MiB of ciphertext. Large transfers automatically pause at the rate limit and resume with their saved recipient confirmations. A large group file creates a separately encrypted copy for each recipient, so it consumes more relay storage than a direct attachment. Full encrypted backups remain capped at 100 MiB.

## Delivery and security

- Public addresses are P-256 keys. Private keys are generated and stored on the device. Relay requests require ECDSA ownership proofs tied to the action, payload, timestamp, and single-use nonce.
- New events and group membership descriptors carry signatures. Content is encrypted per recipient using ECDH-derived AES-256-GCM keys and fresh nonces. The relay sees routing addresses, timing, and ciphertext sizes, but not message text, group names, polls, or file contents.
- Group membership changes are authorized by the group creator. Events bind their membership version and recipient list. Removed members do not receive messages addressed to the new membership. Previously received history cannot be recalled.
- A relay-confirmed event is not automatically a delivered or read message. Recipient receipts communicate those separate states; read receipts can be disabled.
- Full backups use PBKDF2-SHA-256 with 600,000 iterations, a random salt, and AES-GCM. Restore validates identity ownership and message records before import.
- The original v2 direct WebRTC transport remains available in the legacy code. The current feature-rich conversation interface uses the retained encrypted event relay for consistent device synchronization.
- Verify addresses through a trusted independent channel. Static identity keys do not provide forward secrecy or a Signal-style ratchet. A compromised device, extension, or served application can expose local plaintext and keys. This is not an anonymity network or independently audited security product.

## Troubleshooting

Do not clear browser data to fix a relay outage. Use the inbox reconnect/sync control, preserve drafts, and retry failed sends after the connection returns. The relay distinguishes missing database configuration, daily database allowances, temporary overload, and incompatible schema. A generic connection error alone does not establish the cause.

A newly deployed version may require one reload. Do not reload while the composer says its only saved copy is in the current tab. Database setup can repair missing tables and indexes, but cannot create a missing Cloudflare binding or fix provider outages.
