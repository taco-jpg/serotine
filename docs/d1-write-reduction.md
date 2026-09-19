Serotine storage v2 reduces D1 writes by 94.9–95.5% in the two active messaging workloads below. Idle clients, direct calls, and voice rooms produce zero recurring D1 writes. These are local Miniflare/workerd measurements through the real signed HTTP handlers, D1, Durable Objects, and R2. They are not production billing measurements or a prediction of the total Cloudflare bill.

The baseline is main commit `42f794ecc791bc9a11e9a79d7ecca77a76b6acc1`, including the earlier 30-second calling refresh hotfix. Both revisions execute the same workload. Counts sum D1 `meta.rows_written`; they are not statement counts or SQLite `changes`, and include index and trigger writes. Cloudflare documents these counters in its [D1 return objects](https://developers.cloudflare.com/d1/worker-api/return-object/) and [pricing documentation](https://developers.cloudflare.com/d1/platform/pricing/).

| Ten-minute workload | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Three idle devices | 4,243 | 0 | 100% |
| 30 text events + 10 delivery retries | 4,727 | 211 | 95.5% |
| Active direct call + linked device | 4,670 | 0 | 100% |
| Two-person voice room + linked device | 6,241 | 0 | 100% |
| Texts, staged file, legacy file, retries and downloads | 4,780 | 242 | 94.9% |

There are two identities and three devices. Each device synchronizes its event cursor and compatibility inbox every five seconds and renews calling presence every 30 seconds. The room workload renews room membership every five seconds. The mixed workload sends 30 text events, a file manifest, a 1 MiB encrypted staged upload, and an old inline attachment packet; it repeats a chunk upload and downloads the published file from linked devices. Presence and call snapshots are checked throughout, so expired/broken calls cannot masquerade as a zero-write success.

One-time initial schema setup is recorded separately. The mixed workload conservatively includes eight D1 writes from its first file-schema bootstrap. Legacy migration and normal seven-day/30-day retention cleanup are separate from steady-state client work. The tests do not represent sustained maximum-rate sending, large community fan-out, or production load: permanent delivery records still require D1 writes, so those write-heavy workloads have a lower reduction percentage.

The baseline trace identified nonce insertion/expiry as the largest source: even read-only synchronization used to create a nonce row and later delete it. In the active text workload, 4,396 of 4,727 writes were nonce operations; presence contributed 120 and durable events 211.

| State | Storage after this change |
| --- | --- |
| Replay protection and rate-window nonces | `RelayRealtimeStore` SQLite Durable Object |
| Call presence, leases, signaling, room members, old relay signals | Same Durable Object, retaining existing SQL arbitration |
| Permanent room membership anti-rollback checkpoints | Same Durable Object, retained across expiry and restart |
| WebSocket connection state and transient response ACKs | Existing hibernating `CallSignalingHub` attachments |
| Delivery history and quota accounting | D1, with compact encrypted-payload references |
| Every opaque message/event payload, including old embedded files | Private R2 |
| Staged file bytes | Private R2; compact file/chunk metadata remains in D1 |
| Permanent identity retirement | D1, serialized with call state through the Durable Object |

The existing WebRTC and Cloudflare TURN configuration is unchanged. WSS remains signaling-only. SQL batches that arbitrate room admission execute transactionally inside the Durable Object; a cross-store data batch is rejected rather than silently losing transaction semantics. Cloudflare's [SQLite Durable Object API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) provides the transactional storage used here.

File chunks now use conditional R2 creation to prevent overwriting a competing digest, followed by one conditional metadata commit. A ready chunk no longer needs a reservation write followed by a ready-state write. Retries verify existing content and make zero D1 writes once the chunk is ready. Cancellation still wins against a late upload, failed deletion retains reserved quota, and publication keeps sent files available. This uses the documented [R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations).

Opaque encrypted packets are always externalized because the server cannot distinguish an old embedded attachment from text. Existing APIs hydrate R2 references back into the original encrypted string. Missing or corrupt objects fail the complete feed response, without advancing a cursor or acknowledging a legacy message. Byte quotas use original payload sizes, not reference lengths. Different ciphertext under the same message ID cannot overwrite the first accepted message. Content-addressed R2 objects make uncertain-commit retries safe; unreferenced retry objects age out by lifecycle.

Legacy migration copies each packet to R2, reads it back, verifies its digest and bytes, and only then conditionally replaces the D1 body. IDs, expiry, sequence numbers, quota counters and metadata do not change. Interrupted uploads/verification/commits keep the old body readable; rerunning the bounded sweep resumes safely. Original v1 `Message` archives use `relay-payloads/legacy-v2/`, without a new automatic expiry, because their historical retention is not assumed to match the current seven-day feed.

Realtime migration first installs D1 write fences on the old transient tables, then imports their rows, indexes, cursor sequences, and permanent room checkpoints in resumable pages. Late old-version writes fail and retry instead of creating a second call authority after the snapshot. Source data remains intact and read-only. Retirements are refreshed from the primary D1 store before realtime operations; a lost cross-store retirement response is safe to retry. Current APIs continue to accept old clients.

Deployment requires the existing private `serotine_files` R2 bucket, D1 binding, and new `SEROTINE_REALTIME` SQLite Durable Object binding/migration in `wrangler.toml`. `SEROTINE_STORAGE_VERSION=2` is the production setting; a missing setting defaults to v2 and missing bindings fail closed. Version 1 exists solely for explicit pre-cutover compatibility/testing. Do not roll back to a v1 writer or remove the write fences after migration: those rows are no longer the live authority. Use forward fixes that retain the v2 storage boundary. Deploy at 100%, not as a gradual mix of storage versions. A deployment-spanning old request can need a retry while the boundary changes.

The first Cloudflare PR build completed compilation but failed at `npx wrangler versions upload` with error **10211**. That command cannot apply the new Durable Object migration. In **serotine → Settings → Build**, set the production deploy command to `npm run deploy:built` and the non-production branch deploy command to `npm run deploy:check`, with `main` as the production branch. Keep the build command as `npm run build` or `pnpm run build`. Then retry the updated PR build. These dashboard settings cannot be changed by a repository commit. This error is a deployment-method constraint, not evidence that the API token needs more permissions.

`deploy:check` runs `wrangler deploy --dry-run` against the built custom Worker. GitHub CI runs the same check after building. It validates bundling and local configuration, without applying a migration, publishing a preview, or routing production traffic. The approved release uses `deploy:built`, which invokes OpenNext's full `wrangler deploy` path and applies the Durable Object migration and Cron trigger. Remote migration success must still be verified during that release. Cloudflare documents the [migration restriction](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/#durable-object-migrations) and [non-production command setting](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#non-production-branch-deploy-command).

Before deployment, add this lifecycle rule to the new current-payload prefix only, preserving the existing 33-day rule for `encrypted-files/v1/`:

```sh
npx wrangler r2 bucket lifecycle add serotine-files serotine-relay-payload-expiry relay-payloads/v2/ --expire-days 8
npx wrangler r2 bucket lifecycle list serotine-files
```

Do not apply that eight-day rule to the whole bucket or `relay-payloads/legacy-v2/`. The application denies access when its D1 record expires; lifecycle is a later physical-cleanup backstop. The five-minute Worker Cron migrates up to 16 old packets and removes bounded batches of expired history/uploads without tying cleanup to idle clients. It performs one-time migration/retention writes, not heartbeat writes. No plaintext or permanent Cloudflare token is sent to a browser.

`SEROTINE_D1_METRICS=1` emits `serotine.d1` records for routed D1 writes with source table, operation, rows written, and rows read; no SQL parameters or ciphertext are logged. Migration progress emits `serotine.payload_migration`. Retention/migration is intentionally reported separately from request workloads. Watch for any nonce, presence or call table returning in the D1 write-source list, and compare the account's production D1 dashboard counters after rollout.

The remaining normal D1 sources are durable event rows and their indexes/quota triggers, compatibility queue insertion/acknowledgment, file metadata and publication, permanent identity retirement, and expiry cleanup. In the mixed test, 217 writes were durable event insertion, five were compatibility queue insertion, 12 were file/chunk metadata and state changes, and eight were first-time file schema setup. The small replay/lease records now incur Durable Object storage operations; packet bodies incur R2 operations. This is a D1-write reduction, not a claim of equivalent savings across all storage products.

Reproduce with:

```sh
npm test
npm run typecheck
npm run db:migrate:local
npm run build
npm run deploy:check
npm run test:d1
npm run measure:d1
# To remeasure the untouched baseline, supply a checkout of the pinned commit:

SIPs 15 and 18 add D1 retention-scope, terminal-boundary, file-delivery, and completion metadata. The measurements below describe the earlier storage-v2 baseline; they are not a claim that lifecycle operations add zero writes. New lifecycle counters and local verification are recorded in [SIP 8–18 implementation notes](SIP-8-18.md). Request nonces and short-lived direct setup continue to use the Durable Object path.
node tests/support/d1-workload.cjs /absolute/path/to/baseline-checkout
```

The raw baseline is `tests/fixtures/d1-baseline.json`; the measured result is `docs/d1-after.json`. The D1 regression suite gates every workload at at least 90% reduction, requires zero idle/direct-call/room writes, and covers encrypted file round trips, lost reads/commits, retries, nonce replay after restart and at the inclusive timestamp boundary, simultaneous linked-device claims, permanent retirement, source write fencing, and active-call/checkpoint migration. Existing protocol tests still exercise the same SQL authorization, quota, and race conditions, and the real workerd WebSocket test now uses storage v2.

Validation result for this change: 707/707 Node tests passed; TypeScript, local D1 migrations, a clean OpenNext production build, and Wrangler's deployment dry run passed. The dry run recognized both Durable Object classes, D1, R2, and storage-v2 settings. The separate browser RTP smoke test could not launch because Chromium is absent in this runner; downloading it from Playwright's CDN timed out. Browser media behavior and production billing have therefore not been independently verified in this run. No production migration or deployment was performed.
