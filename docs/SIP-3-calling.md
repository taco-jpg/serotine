# SIP 3: voice, video, group calls, and voice channels

This implements direct calls, private-group calls, and community voice channels from [SIP 3](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-3-voice-and-video-calling.md). Screen sharing, recording, device handoff, and closed-app push notifications remain follow-up work.

## Calling

Open an accepted contact's conversation and choose **Voice call** or **Video call** from the phone menu. Both people need a current Serotine tab open. Self chats, blocked contacts, and unaccepted requests cannot place calls.

Starting a call opens a local preparation view. The microphone is requested after an explicit start/answer action; the camera requires a video action. Review the preview and microphone state before connecting. An incoming invitation alone never requests device access. A video invitation can be answered with audio only. No peer connection transmits media until the invitation is accepted.

The call bar remains visible across conversations. It includes connection state, duration, microphone and camera controls, device choices, and an end button. Video expands into a larger view. Camera-off releases camera capture. Ending, cancelling, timeout, identity change, and page exit release local media. A late permission response after cancellation also releases its tracks. Camera failure leaves audio available.

Incoming invitations play a local ringtone and outgoing calls play a quieter waiting tone. **Calling · Waiting for answer** means the invitation has not been accepted; it does not confirm that another device is making sound. Browsers require an interaction before playing audio; use **Enable call sounds** when shown. Sounds stop on answer, cancel, timeout, silence, or identity change. A fast answer is retained even when the outgoing invitation response arrives later.

Invitations expire after 40 seconds. Connection setup has a 30-second deadline; interruption permits a bounded 30-second reconnection attempt, preserving media choices. A new call requires another explicit action. Browsers can suspend background tabs, especially on phones; suspended or closed browsers cannot reliably ring or maintain calls.

One live call reserves both participants' identities on the relay. A conditional database write selects the first incoming device that accepts. Other tabs/devices stop ringing when their WebSocket state refreshes. Concurrent outgoing calls cannot reserve the same identity twice.

Incoming calls follow contact acceptance, block, mute, and archive preferences. **Call privacy and notifications** also offers a device-local silence switch. Calling preferences do not change messaging or appearance preferences.

## Group calls and voice channels

Open a private group's phone menu to start or join its shared voice/video call. Group members join explicitly; starting a room does not ring every member or grant microphone access on another device. The participant list shows who is currently in the room. Up to eight people can join at once, using encrypted WebRTC connections between each pair. This limit keeps bandwidth and device load bounded without an SFU media server.

Community administrators can create a **Voice** channel alongside text channels. Select that channel and choose to join after reviewing your microphone. Voice channels are audio-only. A channel restricted to moderators admits only community administrators and moderators. Existing channels without an explicit type remain text channels, and their original signatures stay valid.

Room controls remain available when switching conversations. Microphone mute, camera-off in group calls, device selection, participant media, and leaving apply to the whole room. Leaving releases the local stream and every peer connection. A participant joining from another device cannot take over an existing membership. Direct calls and rooms share the same per-identity busy check.

The relay verifies signed group or community membership before admitting participants or forwarding room signals. Updated membership, bans, channel deletion, and permission changes invalidate access; clients also stop media when their local accepted membership changes. Membership freshness depends on an updated signed state reaching the calling relay. A server cannot learn a membership change it has not received.

Rooms have no durable call history. Active membership and encrypted negotiation have short leases; they never enter message events or backups. The relay retains only a minimal membership revision checkpoint (authority, epoch, signature, deletion flag, and ownership-transfer signatures) to reject older signed states after a room empties. Group rooms are bound to the group's signing administrator; community checkpoints apply across all channels. Authorization stores only the active roster, roles, and channel IDs/permissions, without display names, descriptions, or ban lists. Explicit leave clears an idle room's authorization data; when browsers disappear, expired data is rejected immediately and physically cleared on subsequent room requests.

## Direct media and WebSocket signaling

Audio and video remain WebRTC peer connections. Each browser constructs the existing `RTCPeerConnection` with `iceTransportPolicy: "all"`, `bundlePolicy: "max-bundle"`, STUN, and authenticated Cloudflare-managed TURN credentials. ICE gathers candidate routes concurrently and prioritizes working direct/reflexive routes; a relay candidate is available when those routes fail. This is standard ICE selection, not a manually sequenced transport or a WebSocket media fallback. Signed remote relay candidates are permitted; peer DTLS fingerprint verification remains intact.

Starting or answering remains explicit. Incoming invitations never capture devices. Each group/community peer pair uses the same mesh and ICE configuration. An unreachable participant can fail independently while other participants continue. Reconnect attempts renew credentials, use the existing ICE restart negotiation, and terminate after a bounded deadline (30 seconds by default). A later interruption after a successful reconnect gets a fresh bounded recovery attempt.

The browser connects to `/api/calls/socket` over WSS for invitations, ringing state, accept/reject, SDP offer/answer, ICE candidates, room membership, and hangup. Local development permits `ws:` only on localhost. There is no browser HTTP polling fallback. Successful changes trigger targeted content-free notifications; clients fetch authenticated encrypted state over the same WebSocket and immediately drain remaining pages. Presence leases renew every 8 seconds for direct calls and 10 seconds for joined rooms.

Socket loss rejects requests with uncertain outcomes rather than automatically replaying mutations. Reconnection obtains a fresh signed authentication proof, wakes the engines, and resynchronizes their cursors. Existing invitation and connection deadlines bound failures. WebSocket disconnection never switches media to a Worker. TURN relays encrypted WebRTC packets independently of the signaling service.

## Server setup

`custom-worker.ts` wraps the generated OpenNext fetch handler and serves WebSocket upgrades through the `CallSignalingHub` Durable Object. `wrangler.toml` includes the `CALL_SIGNALING` binding and additive SQLite Durable Object migration. Deploy the complete build so the wrapper and binding are present together:

```sh
npm run build
npm run deploy:built
```

Keep the existing `WORKER_SELF_REFERENCE` and `serotine_db` bindings. The Durable Object forwards signed requests internally to the existing `/api/calls` handler, preserving its D1 arbitration and authorization. These internal requests carry signaling only. The message relay, R2 attachments, homepage, and themes are unaffected by the calling transport change.

Create a **Cloudflare Realtime TURN key** using the [official dashboard/API instructions](https://developers.cloudflare.com/realtime/turn/generate-credentials/). No SFU app, VPS, coturn, or additional Worker/DO migration is needed. The existing deployment is OpenNext on Workers with static assets; hosting is unchanged.

| Worker secret / variable | Value |
| --- | --- |
| `CALL_TURN_KEY_ID` | The TURN key's `uid` / Token ID. Store as a Worker secret or variable. |
| `CALL_TURN_API_TOKEN` | The **TURN key's** server-side `key` / API token. Store as a Worker secret. This is not the account API token. |
| `CALL_STUN_URLS` | Optional comma-separated STUN URLs; defaults to `stun:stun.cloudflare.com:3478`. |

Set secrets on the existing `serotine` Worker using `npx wrangler secret put CALL_TURN_KEY_ID` and `npx wrangler secret put CALL_TURN_API_TOKEN`, then deploy the reviewed build. Use an ignored `.dev.vars` for local workerd. Never set `NEXT_PUBLIC_*` credentials or commit `.dev.vars`.

Provisioning uses `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/calls/turn_keys` with a descriptive `name`. The [official create-key API](https://developers.cloudflare.com/api/resources/calls/subresources/turn/methods/create/) requires **Calls Write**; read/list operations use Calls Read. Cloudflare Realtime SDK permissions alone are not evidence that this separate TURN permission is present. Writing Worker secrets additionally requires Workers Scripts Write on this account. Once the key is created, the application uses its separate returned bearer token and does not need the account management token at runtime.

After existing identity/signature verification, nonce replay protection, and action rate limiting, `call:configuration` makes the documented server-side request:

`POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers` with `Authorization: Bearer {TURN_KEY_API_TOKEN}` and JSON `{ "ttl": 3600 }`.

Clients receive only provider-issued `iceServers` plus an expiry and status. Credentials remain in memory, renew before expiry with `setConfiguration()`, and refresh on ICE restart. A brief provider outage preserves still-valid credentials. Browser-blocked port 53 is removed; documented UDP, TCP, and TLS/443 alternatives remain. Provider requests time out after eight seconds; bodies are bounded to 16 KiB; provider errors and tokens are never logged or forwarded. Missing/failed TURN setup keeps direct calls available and displays a clear fallback-unavailable notice. The release is not TURN-ready until the secrets are configured and a relayed media call passes.

The custom entrypoint follows [OpenNext's custom Worker guide](https://opennext.js.org/cloudflare/howtos/custom-worker); the signaling hub uses [Cloudflare WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/). Running `next dev` alone does not serve this WebSocket upgrade. Use the built app with local `wrangler dev` for calling development.

## Authentication and privacy

API requests use existing P-256 identity proofs, nonce replay checks, bounded payloads, and action rate limits. Call envelopes are encrypted to the peer and signed. They bind the unique call ID, both identity addresses, selected device sessions, signal ID, and expiry. Authenticated SDP establishes the WebRTC DTLS fingerprint, which remains pinned across ICE restarts. Media uses the browser's WebRTC DTLS-SRTP transport rather than passing audio/video through the text relay. See the [WebRTC connection guide](https://webrtc.org/getting-started/peer-connections) and [W3C WebRTC specification](https://www.w3.org/TR/webrtc/).

The signaling operator can observe call participants, timing, short-lived calling availability/contact permissions, and the history-suppression flag. Room admission also sends the signed group/community membership proof to the operator, including its roster and settings, so the server can enforce access. The signaling server does not transport or record call media. Encryption cannot prevent another participant from making an external recording. Application logs must not include SDP, ICE payloads, media, or relay credentials.

Presence and media negotiation expire after 30 seconds; terminal call tombstones remain available for two minutes so other devices can observe cancellation and privacy corrections. Expired rows are rejected immediately and physically removed in bounded batches on subsequent authenticated calling requests. WebSocket connections require fresh identity/session authentication, close after 90 seconds without activity, and reconnect after at most one hour. Unauthenticated sockets expire after ten seconds. Binary frames are rejected; frame size, concurrent requests, unacknowledged responses, and per-identity socket counts are bounded.

## Call history and backups

The conversation's **Call history** contains local display-only summaries: peer, voice/video type, direction, outcome, time, and connected duration. It contains no SDP, ICE addresses, session IDs, relay credentials, recordings, or transcripts. Summaries are included in full encrypted backups, but do not synchronize live across separate devices. The store retains up to 10,000 recent summaries per identity.

Individual call entries can be deleted locally. Deleting a conversation removes its summaries. Deletion markers survive full backup restore, so an older backup or a late call completion cannot restore deleted history. Imported summaries are validated as inert history and never recreate an active call.

Private calls create no persistent summary. Private mode does not impose the text-message expiry timer on the call's duration. Live signaling and credentials never enter the messaging event store or any backup.

Switching an ordinary call to private suppresses its summary on both participants. A late privacy correction removes an already-created summary and retains only its deletion marker to prevent an older backup restoring it. A call that is private from the outset creates neither a summary nor a deletion marker.

## Validation

Run `npm test`, `npm run typecheck`, and `npm run lint`. Tests cover real Web Crypto and SQLite, signed WebSocket authentication, replay and identity isolation, targeted notifications, frame/backpressure bounds, hibernation, socket lifecycle, clock-skew calibration, and STUN/managed-TURN configurations. A local workerd integration test exercises the actual WebSocket server, self binding, D1 backend, and STUN-only configuration.

After `npm run build`, `npm run test:calling` and `npm run test:call-rooms` run the complete built app in local workerd. Alternatively set `SEROTINE_BROWSER_ORIGIN` to an already running local workerd origin. Set `SEROTINE_CHROMIUM_PATH` for a non-default Chromium installation. Run the browser suites sequentially. `npm run test:ringing` independently checks browser autoplay restrictions, synthesized sound, and cleanup.

The default browser checks require received live RTP. A restricted runner that cannot gather native ICE candidates can explicitly set `SEROTINE_CALL_SMOKE_SIGNALING_ONLY=1`. This verifies WSS exchange, permissions, capture/cleanup, call state, ICE configuration and graceful connection failure; it does **not** establish successful remote audio/video. Keep that limitation in test reports.

Before release, test real microphone output and cameras on two physical devices: one call on a direct-friendly network, one across different networks, then one with direct traffic blocked. Open **Call settings → Connection** (or a participant's connection details in the room view). `TURN relay` must reflect a **selected** local or remote `relay` candidate; merely gathering a relay candidate is insufficient. Confirm received audio and moving video, not just a Connected label. Diagnostics expose only route/candidate types, transport, round-trip time, and byte counters, never IPs, ports, credentials, SDP, or raw stats.

The browser suite also supports `SEROTINE_CALL_SMOKE_BLOCK_DIRECT=1 npm run test:calling`. Configure real managed TURN credentials in local workerd first. This test keeps the production `all` policy while filtering non-relay remote ICE candidates in its browser fixture. It requires selected TURN pairs, received audio RTP, and decoded video frames. It cannot run in signaling-only mode. Repeat without the flag to verify ordinary direct-compatible behavior. The standard suite also verifies ringing, accept/reject, linked-device arbitration, hangup, and media cleanup.

### Investigation before this change

| Question | Confirmed existing behavior at `5d096b8` |
| --- | --- |
| Initiation | `CallEngine.prepareOutgoing` previews devices; `connectPreview` sends a signed encrypted invitation after contact capability checks. |
| SDP | Encrypted `offer` / `answer` envelopes through `call:send` or `room:send`. |
| ICE | Trickle candidates through those same encrypted envelopes; early candidates buffer until remote SDP. |
| Signaling | WSS `/api/calls/socket` → `CallSignalingHub` Durable Object → internal authenticated `/api/calls` handler/D1. Push notifications trigger state reads over WSS; lease timers also synchronize. No browser HTTP fallback. |
| Peer connections | `lib/call-engine.ts:createConnection`; `lib/call-room-engine.ts:createPeer`. |
| ICE config | `all`, `max-bundle`, STUN-only; default Google STUN. |
| TURN / fallback | No live TURN provider or credentials; relay candidates actively rejected. No media fallback. |
| Reproduced rejection | The unchanged implementation rejected a legitimate invite with a caller clock +1,500 ms using the exact screenshot error; aligned clocks reached ringing. Expiry upper bounds had zero skew tolerance. This happens before ICE, so TURN alone cannot fix it. |
| Network diagnosis | STUN-only topology cannot supply a relay route through restrictive NAT/firewalls. The screenshots do not prove which network condition applied; physical cross-network transport needs a real acceptance test. |
| Scope | Authenticated expiring TURN config, accepted relay candidates, safe selected-pair diagnostics, credential renewal, and bounded clock calibration. Existing signaling/auth, call state machines, peer topology, messaging, communities, and deployment remain. |

Successful authenticated responses include server time. Calling clients use that clock for their signed envelopes, subsequent request proofs, and lease comparisons; the device clock is never changed. A five-second upper-bound allowance covers small residual skew/latency. Existing signature verification, nonce replay checks, and bounded expiry remain enforced.
