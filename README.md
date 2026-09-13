# Serotine

Browser-based, end-to-end encrypted messaging with device-local identities and an authenticated Cloudflare D1 relay. No email address or phone number is required.

## Conversations

- **Appearance:** choose Light, Dark, or System from the theme button. System follows your device automatically; your choice is remembered in this browser. The desktop sidebar collapses into a conversation rail and remembers its width preference. Compact message spacing and a single composer toolbar leave more room for messages and media.
- **Delete individual messages:** open a message’s actions and choose **Delete for me…**, then confirm. This removes that message and its attachment from this device’s saved history, search, pins, and shared-file list. Other participants and independently linked devices retain their copies. Deletion markers travel in full backups and prevent replay or importing an older backup from restoring removed content.

- **Group chats:** create a named group, add contacts, manage membership, and leave. The creator manages membership and the group name. Groups support up to twenty people.
- **Inbox:** all conversations receive messages while Serotine is open, with unread counts and recent-message previews. Unknown people appear in message requests.
- **Archive and delete chats:** open a chat's options menu in the inbox or conversation header, including for left groups and retired contacts. Archive hides the chat from the inbox and notifications while keeping its history; use the Archived view to restore it. Delete asks for confirmation and removes saved messages and files on this device, keeping contacts and group membership unchanged. New messages can start the chat again; sync and old-backup imports do not bring back deleted history. These preferences travel in full backups but do not automatically sync to other devices.
- **Notifications:** explicitly enable browser notifications, then choose all messages, mentions only, or muted for each conversation. Notifications use a generic preview. Serotine must remain open; this release does not include closed-app push delivery.
- **Private chats:** in a direct conversation, open Private chat and choose 5 minutes, 1 hour, or 24 hours. Both updated participants use that timer for new text messages, measured from sending. Private text has no saved draft, search result, link preview, pin, reply, or backup copy. Files, polls, and mentions are unavailable while private mode is on. Turning the mode off leaves existing private messages on their original timers.
- **Access keys:** Share access key sends an exact credential through the existing signed, end-to-end encrypted direct transport, with an expiry even when private chat is off. Check the displayed recipient address with the person through a trusted channel. The key is masked until explicitly revealed, can be copied, and hides again after 30 seconds or when the window loses focus. Serotine does not validate or revoke the credential at its issuer.
- **Destroy private history:** either participant can confirm a signed request to remove earlier private messages and access keys from this conversation. Updated clients remove them when the request arrives and reject delayed replays. Ordinary history stays available. Private expiry and destruction also remove the local stored payloads; closed/suspended browsers perform cleanup when they next run.
- **Mentions:** type `@` in the message box to search conversation members. Use arrow keys and Enter/Tab, or click a result, to insert a mention. Editing or deleting its text removes that notification target. Mentions display using your local contact names; your own appear as `@You` by default. Choose **Inbox settings → Private nickname** to change your name on this browser only. This nickname is scoped to your identity and is never sent to others or included in backups. New selected mentions send public addresses instead of local names; existing address-based mentions also display with your local names.
- **Replies and pins:** reply to a particular message, jump to the original, and keep important messages in the pinned panel.
- **Editing and receipts:** edit your own text with an edited label. Sending, relay confirmation, delivery, and optional read receipts are separate states.
- **Shared files and links:** browse a conversation's attachments and links together. Files support up to 50 MiB each in direct chats and messages to yourself, encrypted in chunks, and checked against a SHA-256 digest before opening or downloading. Images and uploaded GIFs display at a useful size; tap or click to open the larger viewer. Supported videos play inline with playback controls, including on phones. Audio has inline controls; unsupported formats retain a download option.
- **GIF search:** the GIF button searches GIPHY and inserts the selected GIF into your draft for explicit Send. GIPHY GIFs load automatically inline as they approach the visible conversation; Hide GIF and Show GIF control individual previews. Searches and loaded GIFs contact GIPHY directly; the relay receives only an encrypted message containing the GIF reference. Search uses the G content rating. See the one-time app key setup below.
- **File bank:** upload frequently used files and GIFs once, then search, rename, remove, or queue them from any conversation under the same identity. You can also save a selected attachment to the bank before sending. The bank holds up to 100 files and 50 MiB per identity, with a 50 MiB per-file limit (and 50 MiB total bank capacity). Files stay in this browser, survive reloads, and are sent through the normal encrypted attachment flow. Bank files are not included in backups or synchronized to linked devices; keep original copies. Clearing site data removes them.
- **Adding files:** drop files anywhere in the open chat, paste files into the message box, or use Attach. Up to eight files can wait in the preview queue; each requires an explicit Send. Pending file selections stay in memory and do not survive navigation or reload.
- **Auto compact files:** an optional browser-local setting losslessly compresses supported files to `.gz` when it saves at least 5% and 1 KiB. Recipients extract the downloaded archive. Photos, audio, video, and common compressed formats keep their original format. Source files up to 50 MiB can be compacted if the result fits the conversation’s send limit.
- **Contact QR codes:** open **Invite a friend** to show or save a QR image containing your exact full public address. In **Add contact** or a group's **Invite a member**, choose **Scan QR code**, then **Use camera** or **Upload QR image**. Review the scanned address and press Add; scanning never automatically saves a contact or joins a group. Existing public addresses and invitation links still work, and conversation settings show each contact's QR code.
- **Search:** search all locally saved messages, filenames, and links, then jump to the matching conversation. Conversation search remains available.
- **Polls:** create a question with options and let each participant choose or change their vote.
- **Voice messages:** record, preview, send, or cancel an audio message. Microphone access is requested only when recording. Voice messages use the same attachment size limit.
- **Message yourself:** your own address opens a normal conversation. Send yourself text, files, links, and voice messages using the normal composer.
- **Backups and linked devices:** export a password-encrypted full backup containing identity, contacts, legacy history, message events, attachment chunks, and preferences. Restore it on another device to link that device and synchronize retained incoming and outgoing events.
- **Phones and tablets:** inbox and conversation views fit narrow screens, dialogs scroll within the visible viewport, and the composer adjusts for the on-screen keyboard and device safe areas. Touch controls remain accessible without hover.
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

## Contact QR codes

Contact QR codes contain public addresses only, not private keys, passwords, or backup files. QR generation and image decoding run locally without a QR service. Camera access is requested only after choosing **Use camera**, requires HTTPS (or localhost), and stops when scanning finishes, is cancelled, the scanner closes, or the page is hidden. PNG, JPEG, WebP, GIF, and BMP images up to 10 MiB are supported. Copy/paste remains available when a camera or readable image is unavailable.

## Backups and synchronization

Open **Backups and linked devices** to download an encrypted snapshot, or **Link another device** for transfer instructions. Use a password of at least twelve characters and keep it separate from the backup file. Retype the confirmation field: paste and drag/drop are disabled there, while copying from either field and pasting into the first or restore field remain available. The password cannot be recovered. Existing identity-only backups remain importable, but naturally contain no chat history.

On a phone that already has a different identity, open **Restore**, select the desktop backup, and enter its password. Serotine validates the backup and asks you to confirm **Switch identity and restore**. The previous identity and its chats remain saved separately in this browser; they are not merged into the desktop identity. Previous identities are available in the backup controls. Do not clear site data to get past an identity conflict.

The relay retains new encrypted events for seven days. Each browser tracks its own position in a non-destructive feed that includes both received and sent events. Reading on one device does not remove another device's copy. A new device obtains older history from the full backup and then catches up from the retained feed. A device offline beyond the retention window may need a newer full backup. Contact aliases, notification preferences, and drafts are device-local after the initial transfer.

Private messages and access keys are excluded from full backup exports and imports, even before expiry. Private settings and signed destruction markers contain no message text and are retained. Both participants must use an updated Serotine client; older versions reject the new private event types. Private mode does not prevent screenshots, copied credentials, modified clients, or someone with access to your unlocked browser or identity key from keeping content. Encrypted relay copies follow the same seven-day retention, rather than being erased immediately by a timer or destruction request. The existing encryption uses long-lived identity keys and does not provide forward secrecy; this feature is not an audited credential vault.

Linked devices share the same identity private key. Revoking only one linked device is not supported. If a backup password or identity key leaks, use **Backups and linked devices → Security → Retire old identity and create new address** on the trusted device holding the affected identity. Confirming permanently retires that address on this relay, blocking old keys from authenticated relay operations and rejecting new messages addressed to it. Retirement is signed by the affected identity; no administrator can infer the right identity from a backup password.

Serotine saves the replacement key and the old identity locally before requesting retirement. After the server confirms, it activates the new address and copies contacts. Old chats stay under the old identity for recovery. Existing group membership does not transfer: contacts need your new address, and group administrators must add it. Make a new backup with a fresh password and restore it on your other devices. If the server response is lost, retry on the same browser; the staged replacement key is reused.

Retirement cannot erase downloaded files, prevent offline decryption of an old backup, recall delivered messages, cancel requests already in flight, or revoke access through another server or an established legacy peer connection. Re-encrypting a new backup alone does not invalidate an older one. The retired-address records are permanent security state: retain them when migrating the relay database. Browser storage and exported snapshots contain sensitive information; clearing site data without a usable backup can lose local history.

## Verification

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

For browser integration, run `npx playwright install chromium` once, then `npm run test:browser`. The smoke test starts a local server and uses synthetic identities to exercise actual D1 traffic, groups, attachments, voice recording, backups, linked browsers, and the mobile layout. `SEROTINE_CHROMIUM_PATH` can point to an existing Chromium executable.

Run `npm run test:relay-origin` for the focused browser transport regression. It uses a local HTTP server, the real relay route, and in-memory SQLite to check that messaging overrides the page's `no-referrer` policy with `strict-origin`. Only the site origin is sent as `Referer`; conversation paths and query strings stay private.

To reproduce the Safari engine failure and verify the fix, install WebKit with `npx playwright install --with-deps webkit`, then run `SEROTINE_BROWSER=webkit npm run test:relay-origin`. This mode requires the original client to reproduce the `Origin: null` rejection before testing the corrected client. The default Chromium run checks compatibility but may not reproduce Safari's original failure.

`npm run test:private` checks two-participant private messaging, exact access-key reveal/copy/hiding, expiry and destruction, draft/search/backup exclusions, narrow mobile layouts, and native clipboard behavior in the backup password fields.

`npm run test:qr` checks exact-address QR display/download, image import, explicit contact/group confirmation, invalid code handling, camera cleanup, and narrow mobile dialogs with synthetic identities. To test the production bundle without starting Cloudflare's development runtime, first run `npm run build:next -- --webpack`, then `SEROTINE_QR_PRODUCTION=1 npm run test:qr`. Camera tests use a controlled video stream; check physical-camera focus and permissions on your target phones before release.

Run `npm run test:appearance` for theme selection, system-theme changes, sidebar collapse, desktop/mobile layout, message actions, and individual-message deletion.

Run `npm run test:cleanup` for desktop and mobile archive/restore/delete controls, reload persistence, deletion confirmation, and protection against replay or old-backup imports restoring deleted history.

Run `npm run test:recovery` separately to exercise the real mobile restore confirmation, identity archives, permanent retirement, and old-device denial with synthetic identities. Run `npm run test:media` for inline images/videos, file bank persistence, and GIF search/viewing with mocked provider responses. Each browser suite starts its own development server; run them sequentially.

Tests cover the actual Web Crypto and SQLite implementations alongside controlled browser/storage boundaries. They exercise authenticated relay access, replay protection, identity scoping, retained synchronization, group authorization, message controls, attachment integrity, and encrypted backups. Automated tests are not an independent security audit or a substitute for real-device deployment checks.

## GIF provider setup

Create a GIPHY API app in the [GIPHY developer dashboard](https://developers.giphy.com/dashboard/) and set `NEXT_PUBLIC_GIPHY_API_KEY` in `.env.local` for development or in your Cloudflare Worker’s **Settings → Variables and Secrets**. The browser can fetch this intentionally public key from the uncached `/api/giphy/config` endpoint at runtime, so a Worker binding also works when the key was absent during the build. The endpoint exposes only this public key; it never exposes other environment variables. Setting the key in the build environment remains supported, but changing an embedded build value requires rebuilding. Do not put a private server credential in this variable. Follow GIPHY's production approval and quota requirements for your app.

Without the key, the GIF picker explains that search is not configured; uploaded GIFs, image/video attachments, and the file bank still work. GIPHY failures show a retry action or an ordinary link. GIF metadata and media are fetched directly from GIPHY when a conversation GIF approaches the viewport, or when searching in the picker. GIPHY can see your IP address and the GIFs you view. The picker does not upload chat history, contact addresses, or bank files to GIPHY. Provider GIFs remain references rather than copied assets in the bank, in line with [GIPHY's integration requirements](https://developers.giphy.com/docs/api/).


## Deployment

Deploy to **Cloudflare Workers with OpenNext**. Keep the `serotine_db` D1 binding in `wrangler.toml` pointed at the intended database. For Workers Builds, use `npm run build` as the build command and `npm run deploy:built` as the production deploy command. After authenticating Wrangler for that account:

```sh
npm run deploy
```

Both the existing relay schema and the new event tables initialize additively on authenticated requests. The new schema does not delete the old v2 queue or browser history. Reload both clients after deployment to use the new event protocol. Old clients can still send legacy messages, which the new identity-wide compatibility inbox can collect; old clients cannot display new group, file, or event messages. Upgrade both participants for normal conversations.

Files sent by the earlier attachment release remain readable. The compatibility inbox accepts its v3 envelopes (up to four files totaling 1 MiB) and saves the files before acknowledging the queued message. Existing local attachments, including unconfirmed sends, migrate into the current conversation view and remain included in full backups. New sends support up to 50 MiB using the same 30 KiB chunk format. Larger groups show a lower per-file cap that fits their encrypted delivery copies within the existing relay budgets. Update both participants to send and receive files above the previous 10 MiB limit. Full backups remain capped at 100 MiB, so attachment-heavy history may exceed that backup limit; sending files does not remove history to make a backup fit.

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
