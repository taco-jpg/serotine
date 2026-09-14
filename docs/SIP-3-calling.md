# SIP 3: voice, video, group calls, and voice channels

This implements direct calls, private-group calls, and community voice channels from [SIP 3](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-3-voice-and-video-calling.md). Screen sharing, recording, device handoff, and closed-app push notifications remain follow-up work.

## Calling

Open an accepted contact's conversation and choose **Voice call** or **Video call** from the phone menu. Both people need a current Serotine tab open. Self chats, blocked contacts, and unaccepted requests cannot place calls.

Starting a call opens a local preparation view. The microphone is requested after an explicit start/answer action; the camera requires a video action. Review the preview and microphone state before connecting. An incoming invitation alone never requests device access. A video invitation can be answered with audio only. No peer connection transmits media until the invitation is accepted.

The call bar remains visible across conversations. It includes connection state, duration, microphone and camera controls, device choices, and an end button. Video expands into a larger view. Camera-off releases camera capture. Ending, cancelling, timeout, identity change, and page exit release local media. A late permission response after cancellation also releases its tracks. Camera failure leaves audio available.

Incoming invitations play a local ringtone and outgoing calls play a quieter waiting tone. **Calling · Waiting for answer** means the invitation has not been accepted; it does not confirm that another device is making sound. Browsers require an interaction before playing audio; use **Enable call sounds** when shown. Sounds stop on answer, cancel, timeout, silence, or identity change. A fast answer is retained even when the outgoing invitation response arrives later.

Invitations expire after 40 seconds. Connection setup has a 30-second deadline; interruption permits a bounded 15-second reconnection attempt, preserving media choices. A new call requires another explicit action. Browsers can suspend background tabs, especially on phones; suspended or closed browsers cannot reliably ring or maintain calls.

One live call reserves both participants' identities on the relay. A conditional database write selects the first incoming device that accepts. Other tabs/devices stop ringing on their next poll. Concurrent outgoing calls cannot reserve the same identity twice.

Incoming calls follow contact acceptance, block, mute, and archive preferences. **Call privacy and notifications** also offers a device-local silence switch. Calling preferences do not change messaging or appearance preferences.

## Group calls and voice channels

Open a private group's phone menu to start or join its shared voice/video call. Group members join explicitly; starting a room does not ring every member or grant microphone access on another device. The participant list shows who is currently in the room. Up to eight people can join at once, using encrypted WebRTC connections between each pair. This limit keeps bandwidth and device load bounded without an SFU media server.

Community administrators can create a **Voice** channel alongside text channels. Select that channel and choose to join after reviewing your microphone. Voice channels are audio-only. A channel restricted to moderators admits only community administrators and moderators. Existing channels without an explicit type remain text channels, and their original signatures stay valid.

Room controls remain available when switching conversations. Microphone mute, camera-off in group calls, device selection, participant media, and leaving apply to the whole room. Leaving releases the local stream and every peer connection. A participant joining from another device cannot take over an existing membership. Direct calls and rooms share the same per-identity busy check.

The relay verifies signed group or community membership before admitting participants or forwarding room signals. Updated membership, bans, channel deletion, and permission changes invalidate access; clients also stop media when their local accepted membership changes. Membership freshness depends on an updated signed state reaching the calling relay. A server cannot learn a membership change it has not received.

Rooms have no durable call history. Active membership and encrypted negotiation have short leases; they never enter message events or backups. The relay retains only a minimal membership revision checkpoint (authority, epoch, signature, deletion flag, and ownership-transfer signatures) to reject older signed states after a room empties. Group rooms are bound to the group's signing administrator; community checkpoints apply across all channels. Authorization stores only the active roster, roles, and channel IDs/permissions, without display names, descriptions, or ban lists. Explicit leave clears an idle room's authorization data; when browsers disappear, expired data is rejected immediately and physically cleared on subsequent room requests.

## Routing and server setup

Relay-only is the default. It uses WebRTC's `iceTransportPolicy: "relay"` and refuses setup when TURN is unavailable; it never silently falls back to a direct route. Users can explicitly select direct connections, which may reveal their network address to the other participant. Direct connectivity depends on each network's firewall/NAT and is not guaranteed.

If the server cannot supply relay credentials, preparation shows **Choose a connection** before requesting microphone or camera permission. **Retry relay** retries the server configuration. **Allow direct and continue** is an explicit opt-in to sharing a network address with the other participants. An incoming invitation requiring relay-only cannot be overridden by the recipient. A direct call that cannot cross the participants' networks needs working TURN; repeatedly retrying direct routing does not resolve that infrastructure gap.

The Cloudflare Worker can issue short-lived coturn-compatible REST credentials using these runtime bindings:

| Binding | Purpose |
| --- | --- |
| `CALL_TURN_URLS` | Comma-separated `turn:`/`turns:` endpoints operated by the site owner. |
| `CALL_TURN_SECRET` | Server-only shared REST-authentication secret matching the TURN server; at least 24 characters. |
| `CALL_TURN_KEY_ID` | Cloudflare Realtime TURN key ID, as an alternative to a coturn deployment. |
| `CALL_TURN_API_TOKEN` | Server-only token belonging to that Cloudflare TURN key. |
| `CALL_STUN_URLS` | Optional comma-separated STUN endpoints for explicitly selected direct connections; defaults to Google's STUN endpoint. |

Keep the shared TURN secret in a Worker secret, never in a `NEXT_PUBLIC_` variable. The browser receives expiring credentials, not the shared secret. TURN service operation, traffic charges, quotas, and production credentials belong to the site operator. This implementation does not provision or deploy a TURN service.

The Cloudflare token used to administer a Worker is different from the token belonging to a TURN key. Provisioning a TURN key through the API requires account **Calls Write**; adding Worker secrets requires **Workers Scripts Write**.

For Cloudflare, create a Realtime TURN key using the [Cloudflare TURN setup](https://developers.cloudflare.com/realtime/turn/generate-credentials/), then set the Worker's `CALL_TURN_KEY_ID` and `CALL_TURN_API_TOKEN` bindings. For example, `npx wrangler secret put CALL_TURN_KEY_ID` and `npx wrangler secret put CALL_TURN_API_TOKEN` prompt for the values without putting them in source code. The Worker requests ten-minute credentials from Cloudflare and returns validated TURN endpoints, excluding port 53. A complete coturn configuration takes precedence when both providers are configured. A Cloudflare credential failure keeps relay-only calls blocked; only users who already allowed direct routing can continue with STUN.

The existing `serotine_db` D1 binding hosts new transient calling tables. They initialize additively through authenticated requests. `/api/calls` is separate from retained message events. No migration removes or rewrites existing conversations.

## Authentication and privacy

API requests use existing P-256 identity proofs, nonce replay checks, bounded payloads, and action rate limits. Call envelopes are encrypted to the peer and signed. They bind the unique call ID, both identity addresses, selected device sessions, signal ID, and expiry. Authenticated SDP establishes the WebRTC DTLS fingerprint, which remains pinned across ICE restarts. Media uses the browser's WebRTC DTLS-SRTP transport rather than passing audio/video through the text relay. See the [WebRTC connection guide](https://webrtc.org/getting-started/peer-connections) and [W3C WebRTC specification](https://www.w3.org/TR/webrtc/).

The signaling operator can observe call participants, timing, short-lived calling availability/contact permissions, and the history-suppression flag. Room admission also sends the signed group/community membership proof to the operator, including its roster and settings, so the server can enforce access. A TURN operator can observe routing metadata and traffic volume. Neither transport records call media. Encryption cannot prevent another participant from making an external recording. Application logs must not include SDP, ICE payloads, media, or relay credentials.

Presence and media negotiation expire after 30 seconds; terminal call tombstones remain available for two minutes so other devices can observe cancellation and privacy corrections. Expired rows are rejected immediately and physically removed in bounded batches on subsequent authenticated calling requests. TURN credentials expire after ten minutes and are refreshed when reconnecting.

## Call history and backups

The conversation's **Call history** contains local display-only summaries: peer, voice/video type, direction, outcome, time, and connected duration. It contains no SDP, ICE addresses, session IDs, relay credentials, recordings, or transcripts. Summaries are included in full encrypted backups, but do not synchronize live across separate devices. The store retains up to 10,000 recent summaries per identity.

Individual call entries can be deleted locally. Deleting a conversation removes its summaries. Deletion markers survive full backup restore, so an older backup or a late call completion cannot restore deleted history. Imported summaries are validated as inert history and never recreate an active call.

Private calls create no persistent summary. Private mode does not impose the text-message expiry timer on the call's duration. Live signaling and credentials never enter the messaging event store or any backup.

Switching an ordinary call to private suppresses its summary on both participants. A late privacy correction removes an already-created summary and retains only its deletion marker to prevent an older backup restoring it. A call that is private from the outset creates neither a summary nor a deletion marker.

## Validation

Run `npm run test:ringing` to verify the real browser autoplay gate, synthesized audio, and sound cleanup without a calling server. Run `npm test`, `npm run typecheck`, and `npm run lint` for automated checks. `npm run test:calling` exercises direct browser WebRTC with synthetic devices and the local authenticated D1 relay; `npm run test:call-rooms` exercises three-person rooms and group/channel UI. Set `SEROTINE_CHROMIUM_PATH` if Chromium is installed outside Playwright's default cache. Browser suites start their own server and should run sequentially.

The default calling smoke requires a live media connection. Restricted runners that cannot gather ICE candidates can explicitly use `SEROTINE_CALL_SMOKE_SIGNALING_ONLY=1` to check signaling, permissions/capture cleanup, private history, and UI. That mode does **not** verify RTP transport or cross-network calling and must not be reported as doing so.

Before production rollout, verify microphone permissions, audio output, front/back cameras, backgrounding, and recovery on physical target devices. Verify a real TURN service and audio/video calls between devices on different networks. Local synthetic-device checks do not establish those results.
