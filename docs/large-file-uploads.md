# Encrypted attachments up to 1 GB

Large attachments use the private `serotine_files` R2 binding and the additive D1 migration `0006_encrypted_file_uploads.sql`. They do not enter the retained message-event quota. The browser encrypts independent 4 MiB chunks with AES-GCM, authenticates their positions and attachment identity, and sends binary ciphertext. The server never receives plaintext, filenames, MIME types, or decryption keys. A single ciphertext upload can be shared with every recipient in a group or community through encrypted message metadata.

Selecting a file starts staging while the sender writes a caption. Completing the upload keeps it private. Send publishes its random read capability inside the existing encrypted message; removal from an unsent draft cancels and physically deletes its objects. Once published, draft cancellation is a no-op so a lost message acknowledgement cannot break an attachment that was actually delivered.

## Server setup

These commands are for the site operator's Cloudflare account; run them with an account that can create R2 buckets, manage lifecycle rules, apply D1 migrations, and deploy the existing Worker. The token available during implementation returned HTTP 403 for R2 administration. No remote bucket, migration, or deployment was created by this change.

1. Create the bucket if it does not already exist:

   ```sh
   npx wrangler r2 bucket create serotine-files
   ```

2. Confirm the existing `wrangler.toml` contains:

   ```toml
   [[r2_buckets]]
   binding = "serotine_files"
   bucket_name = "serotine-files"
   ```

   Keep the bucket private. This design uses the Worker binding, so it needs neither a public bucket URL nor browser-facing R2 credentials/CORS.

3. Add the cleanup backstop to this prefix only:

   ```sh
   npx wrangler r2 bucket lifecycle add serotine-files serotine-encrypted-file-expiry encrypted-files/v1/ --expire-days 33
   npx wrangler r2 bucket lifecycle list serotine-files
   ```

   R2 lifecycle management requires `Workers R2 Storage Write`. Lifecycle expiry is asynchronous; Cloudflare says deletion typically occurs within 24 hours after the object's expiration time. Application access stops at the earlier D1 expiry even if physical deletion is pending. See [Cloudflare object lifecycle documentation](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).

4. Apply the additive D1 migration and deploy the built application:

   ```sh
   npm run db:migrate:remote
   npm run deploy
   ```

5. Verify `GET /api/files` returns `available: true`. Upload, send, download, and compare a file between two different identities. Also select and remove an unsent file, and confirm its R2 objects disappear. Local development uses Wrangler's local R2/D1 simulation through the same bindings.

6. Add a recurring job in the operator's existing scheduler:

   ```sh
   node scripts/file-upload-cleanup.cjs https://your-serotine-site.example
   ```

   Run every minute for prompt cleanup, or hourly for a small deployment. Each invocation performs six signed sweeps, removing at most 24 expired uploads. It uses a fresh temporary signing identity and no user keys or Cloudflare secrets. The endpoint only selects expired/deleted/retired-owner uploads and cannot remove active published files. New upload requests also reclaim up to two expired uploads. The R2 lifecycle rule is still required for long periods without app/scheduler traffic.

## Bounds and lifetime

| Item | Bound |
| --- | --- |
| Individual plaintext file | 1,073,741,824 bytes (1 GiB, displayed as 1 GB) |
| Binary ciphertext request | 4 MiB plaintext plus a 16-byte GCM tag |
| Chunks per file | At most 256 |
| Unsigned capability query | Public availability and limits only |
| Staged/ready draft | 24 hours from upload initialization |
| Published attachment | 30 days from the first successful publish |
| Per-identity reserved upload bytes | 5 GiB, plus bounded encryption overhead |
| Global reserved upload bytes | 50 GiB, plus bounded encryption overhead |
| Live uploads per identity | 100 |
| New uploads | 20 per signed identity per minute |
| Chunk/read/control requests | 600 per action per signed identity per minute |
| Explicit cleanup requests | Six per signed identity per minute |

The browser Backpack is separate local storage. Its 5 GB limit does not reserve server upload space. Server quotas count both staged and published attachments until successful physical cleanup. Local browser storage remains subject to browser/device capacity.

Publication and expiry are authoritative server values returned in the receipt. Repeating publish does not extend the lifetime. A backup containing an attachment reference does not extend its download availability; save the actual file before that timestamp if it must remain available afterward. Existing retained-event attachment formats continue to be readable. If the server has no R2 binding, clients can continue the bounded legacy upload path; a large upload gets a setup error rather than silently entering an event store that cannot hold it.

## Request and cleanup guarantees

All operations except public capability discovery use P-256 request proofs with fresh nonces. A chunk proof covers its upload ID, position, exact ciphertext length, and SHA-256 digest; its binary body is bounded and checked before storage. D1 reserves capacity with a single conditional insert, preventing concurrent requests from exceeding a quota. Chunk reservations pin their digest, so retries are idempotent and cannot overwrite a finalized chunk with different content. Completion checks every chunk and the exact aggregate size before publication.

Downloads require both a signed identity request and the random 256-bit read capability distributed only in encrypted chat metadata. The server stores only its SHA-256 hash. Capabilities are in POST bodies, never URLs. Decryption keys remain in the encrypted metadata, and the browser verifies every chunk's encryption tag. A recipient can deliberately share an attachment capability/key just as they can share a downloaded file.

Cancellation marks a draft deleted atomically before deleting every possible object key. A concurrent writer checks state again after storing and removes any late ciphertext. Failed physical deletion retains the reserved quota and is retried. Tombstones and chunk keys remain for 32 days so subsequent sweeps also catch a worker that stopped between its R2 write and final state check; the 33-day bucket rule covers failures without further traffic. These are bounded cleanup operations, not immediate guaranteed physical erasure at the application expiry timestamp.
