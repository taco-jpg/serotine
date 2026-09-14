# SIP 3: direct voice and video calls

This implements the initial one-to-one stage of [SIP 3](https://github.com/taco-jpg/serotine/blob/SIP/SIPs/SIP-3-voice-and-video-calling.md). Private-group calls, community voice rooms, screen sharing, recording, device handoff, and closed-app push notifications remain follow-up work.

## Calling

Open an accepted contact's conversation and choose **Voice call** or **Video call** from the phone menu. Both people need a current Serotine tab open. Self chats, private groups, communities, blocked contacts, and unaccepted requests cannot place calls.

Starting a call opens a local preparation view. The microphone is requested after an explicit start/answer action; the camera requires a video action. Review the preview and microphone state before connecting. An incoming invitation alone never requests device access. A video invitation can be answered with audio only. No peer connection transmits media until the invitation is accepted.

The call bar remains visible across conversations. It includes connection state, duration, microphone and camera controls, device choices, and an end button. Video expands into a larger view. Camera-off releases camera capture. Ending, cancelling, timeout, identity change, and page exit release local media. A late permission response after cancellation also releases its tracks. Camera failure leaves audio available.

Invitations expire after 40 seconds. Connection setup has a 30-second deadline; interruption permits a bounded 15-second reconnection attempt, preserving media choices. A new call requires another explicit action. Browsers can suspend background tabs, especially on phones; suspended or closed browsers cannot reliably ring or maintain calls.

One live call reserves both participants' identities on the relay. A conditional database write selects the first incoming device that accepts. Other tabs/devices stop ringing on their next poll. Concurrent outgoing calls cannot reserve the same identity twice.

Incoming calls follow contact acceptance, block, mute, and archive preferences. **Call privacy and notifications** also offers a device-local silence switch. Calling preferences do not change messaging or appearance preferences.

## Routing and server setup

Relay-only is the default. It uses WebRTC's `iceTransportPolicy: "relay"` and refuses setup when TURN is unavailable; it never silently falls back to a direct route. Users can explicitly select direct connections, which may reveal their network address to the other participant. Direct connectivity depends on each network's firewall/NAT and is not guaranteed.

The Cloudflare Worker can issue short-lived coturn-compatible REST credentials using these runtime bindings:

| Binding | Purpose |
| --- | --- |
| `CALL_TURN_URLS` | Comma-separated `turn:`/`turns:` endpoints operated by the site owner. |
| `CALL_TURN_SECRET` | Server-only shared REST-authentication secret matching the TURN server; at least 24 characters. |
| `CALL_STUN_URLS` | Optional comma-separated STUN endpoints for explicitly selected direct connections; defaults to Google's STUN endpoint. |

Keep the shared TURN secret in a Worker secret, never in a `NEXT_PUBLIC_` variable. The browser receives expiring credentials, not the shared secret. TURN service operation, traffic charges, quotas, and production credentials belong to the site operator. This implementation does not provision or deploy a TURN service.

The existing `serotine_db` D1 binding hosts new transient calling tables. They initialize additively through authenticated requests. `/api/calls` is separate from retained message events. No migration removes or rewrites existing conversations.

## Authentication and privacy

API requests use existing P-256 identity proofs, nonce replay checks, bounded payloads, and action rate limits. Call envelopes are encrypted to the peer and signed. They bind the unique call ID, both identity addresses, selected device sessions, signal ID, and expiry. Authenticated SDP establishes the WebRTC DTLS fingerprint, which remains pinned across ICE restarts. Media uses the browser's WebRTC DTLS-SRTP transport rather than passing audio/video through the text relay. See the [WebRTC connection guide](https://webrtc.org/getting-started/peer-connections) and [W3C WebRTC specification](https://www.w3.org/TR/webrtc/).

The signaling operator can observe call participants, timing, short-lived calling availability/contact permissions, and the history-suppression flag. A TURN operator can observe routing metadata and traffic volume. Neither transport records call media. Encryption cannot prevent another participant from making an external recording. Application logs must not include SDP, ICE payloads, media, or relay credentials.

Presence and media negotiation expire after 30 seconds; terminal call tombstones remain available for two minutes so other devices can observe cancellation and privacy corrections. Expired rows are rejected immediately and physically removed in bounded batches on subsequent authenticated calling requests. TURN credentials expire after ten minutes and are refreshed when reconnecting.

## Call history and backups

The conversation's **Call history** contains local display-only summaries: peer, voice/video type, direction, outcome, time, and connected duration. It contains no SDP, ICE addresses, session IDs, relay credentials, recordings, or transcripts. Summaries are included in full encrypted backups, but do not synchronize live across separate devices. The store retains up to 10,000 recent summaries per identity.

Individual call entries can be deleted locally. Deleting a conversation removes its summaries. Deletion markers survive full backup restore, so an older backup or a late call completion cannot restore deleted history. Imported summaries are validated as inert history and never recreate an active call.

Private calls create no persistent summary. Private mode does not impose the text-message expiry timer on the call's duration. Live signaling and credentials never enter the messaging event store or any backup.

Switching an ordinary call to private suppresses its summary on both participants. A late privacy correction removes an already-created summary and retains only its deletion marker to prevent an older backup restoring it. A call that is private from the outset creates neither a summary nor a deletion marker.

## Validation

Run `npm test`, `npm run typecheck`, and `npm run lint` for automated checks. `npm run test:calling` exercises real browser WebRTC with synthetic devices and the local authenticated D1 relay. Set `SEROTINE_CHROMIUM_PATH` if Chromium is installed outside Playwright's default cache. Browser suites start their own server and should run sequentially.

The default calling smoke requires a live media connection. Restricted runners that cannot gather ICE candidates can explicitly use `SEROTINE_CALL_SMOKE_SIGNALING_ONLY=1` to check signaling, permissions/capture cleanup, private history, and UI. That mode does **not** verify RTP transport or cross-network calling and must not be reported as doing so.

Before production rollout, verify microphone permissions, audio output, front/back cameras, backgrounding, and recovery on physical target devices. Verify a real TURN service and audio/video calls between devices on different networks. Local synthetic-device checks do not establish those results.
