# SIP 3: voice, video, group calls, and voice channels

This implements direct calls, private-group calls, and community voice channels from [SIP 3](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-3-voice-and-video-calling.md). Screen sharing, recording, device handoff, and closed-app push notifications remain follow-up work.

## Calling

Open an accepted contact's conversation and choose **Voice call** or **Video call** from the phone menu. Both people need a current Serotine tab open. Self chats, blocked contacts, and unaccepted requests cannot place calls.

Starting a call opens a local preparation view. The microphone is requested after an explicit start/answer action; the camera requires a video action. Review the preview and microphone state before connecting. An incoming invitation alone never requests device access. A video invitation can be answered with audio only. No peer connection transmits media until the invitation is accepted.

The call bar remains visible across conversations. It includes connection state, duration, microphone and camera controls, device choices, and an end button. Video expands into a larger view. Camera-off releases camera capture. Ending, cancelling, timeout, identity change, and page exit release local media. A late permission response after cancellation also releases its tracks. Camera failure leaves audio available.

Incoming invitations play a local ringtone and outgoing calls play a quieter waiting tone. **Calling · Waiting for answer** means the invitation has not been accepted; it does not confirm that another device is making sound. Browsers require an interaction before playing audio; use **Enable call sounds** when shown. Sounds stop on answer, cancel, timeout, silence, or identity change. A fast answer is retained even when the outgoing invitation response arrives later.

Invitations expire after 40 seconds. Connection setup has a 30-second deadline; interruption permits a bounded 15-second reconnection attempt, preserving media choices. A new call requires another explicit action. Browsers can suspend background tabs, especially on phones; suspended or closed browsers cannot reliably ring or maintain calls.

One live call reserves both participants' identities on the relay. A conditional database write selects the first incoming device that accepts. Other tabs/devices stop ringing when their WebSocket state refreshes. Concurrent outgoing calls cannot reserve the same identity twice.

Incoming calls follow contact acceptance, block, mute, and archive preferences. **Call privacy and notifications** also offers a device-local silence switch. Calling preferences do not change messaging or appearance preferences.

## Group calls and voice channels

Open a private group's phone menu to start or join its shared voice/video call. Group members join explicitly; starting a room does not ring every member or grant microphone access on another device. The participant list shows who is currently in the room. Up to eight people can join at once, using encrypted WebRTC connections between each pair. This limit keeps bandwidth and device load bounded without an SFU media server.

Community administrators can create a **Voice** channel alongside text channels. Select that channel and choose to join after reviewing your microphone. Voice channels are audio-only. A channel restricted to moderators admits only community administrators and moderators. Existing channels without an explicit type remain text channels, and their original signatures stay valid.

Room controls remain available when switching conversations. Microphone mute, camera-off in group calls, device selection, participant media, and leaving apply to the whole room. Leaving releases the local stream and every peer connection. A participant joining from another device cannot take over an existing membership. Direct calls and rooms share the same per-identity busy check.

The relay verifies signed group or community membership before admitting participants or forwarding room signals. Updated membership, bans, channel deletion, and permission changes invalidate access; clients also stop media when their local accepted membership changes. Membership freshness depends on an updated signed state reaching the calling relay. A server cannot learn a membership change it has not received.

Rooms have no durable call history. Active membership and encrypted negotiation have short leases; they never enter message events or backups. The relay retains only a minimal membership revision checkpoint (authority, epoch, signature, deletion flag, and ownership-transfer signatures) to reject older signed states after a room empties. Group rooms are bound to the group's signing administrator; community checkpoints apply across all channels. Authorization stores only the active roster, roles, and channel IDs/permissions, without display names, descriptions, or ban lists. Explicit leave clears an idle room's authorization data; when browsers disappear, expired data is rejected immediately and physically cleared on subsequent room requests.

## Direct media and WebSocket signaling

Audio and video use direct WebRTC peer connections. STUN and ICE discover network addresses and attempt NAT hole punching. Calls always use `iceTransportPolicy: "all"` with STUN-only servers; no TURN configuration, credentials, provider requests, or server media fallback are supported. Relay candidates in remote ICE/SDP are rejected. An older client requiring relay-only calling must update before calling this version.

Participants can learn each other's network addresses. This is disclosed in call preparation and settings. Starting or answering remains an explicit action; an incoming invitation never captures a microphone or camera. A restrictive firewall or NAT can prevent a direct connection. Setup then ends with a clear error and releases local media. Group calls use the same direct mesh: an unreachable participant can fail independently while connected participants continue.

The browser connects to `/api/calls/socket` over WSS for invitations, ringing state, accept/reject, SDP offer/answer, ICE candidates, room membership, and hangup. Local development permits `ws:` only on localhost. There is no browser HTTP polling fallback. Successful changes trigger targeted content-free notifications; clients fetch authenticated encrypted state over the same WebSocket and immediately drain remaining pages. Presence leases renew every 8 seconds for direct calls and 10 seconds for joined rooms.

Socket loss rejects requests with uncertain outcomes rather than automatically replaying mutations. Reconnection obtains a fresh signed authentication proof, wakes the engines, and resynchronizes their cursors. Existing invitation and connection deadlines bound failures. A disconnected browser never changes to a server media path.

## Server setup

`custom-worker.ts` wraps the generated OpenNext fetch handler and serves WebSocket upgrades through the `CallSignalingHub` Durable Object. `wrangler.toml` includes the `CALL_SIGNALING` binding and additive SQLite Durable Object migration. Deploy the complete build so the wrapper and binding are present together:

```sh
npm run build
npm run deploy:built
```

Keep the existing `WORKER_SELF_REFERENCE` and `serotine_db` bindings. The Durable Object forwards signed requests internally to the existing `/api/calls` handler, preserving its D1 arbitration and authorization. These internal requests carry signaling only. The message relay, R2 attachments, homepage, and themes are unaffected by the calling transport change.

No TURN secrets are needed or read. `CALL_STUN_URLS` optionally supplies comma-separated `stun:`/`stuns:` URLs; otherwise the app uses the existing Google STUN default. Only URLs are accepted, without usernames or credentials. STUN helps discover a route and cannot guarantee connectivity through every network.

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

Run `npm test`, `npm run typecheck`, and `npm run lint`. Tests cover real Web Crypto and SQLite, signed WebSocket authentication, replay and identity isolation, targeted notifications, frame/backpressure bounds, hibernation, socket lifecycle, and direct-only ICE configurations. A local workerd integration test exercises the actual WebSocket server, self binding, D1 backend, and STUN-only configuration.

After `npm run build`, `npm run test:calling` and `npm run test:call-rooms` run the complete built app in local workerd. Alternatively set `SEROTINE_BROWSER_ORIGIN` to an already running local workerd origin. Set `SEROTINE_CHROMIUM_PATH` for a non-default Chromium installation. Run the browser suites sequentially. `npm run test:ringing` independently checks browser autoplay restrictions, synthesized sound, and cleanup.

The default browser checks require received live RTP. A restricted runner that cannot gather native ICE candidates can explicitly set `SEROTINE_CALL_SMOKE_SIGNALING_ONLY=1`. This verifies WSS exchange, permissions, capture/cleanup, call state, no-TURN configuration, and graceful direct-connection failure; it does **not** establish successful remote audio/video. Keep that limitation in test reports.

Before release, test real microphone output, cameras, and calls across physical devices/networks. Successful direct calling depends on those networks; a restrictive-network failure is expected to end clearly without a media relay fallback.
