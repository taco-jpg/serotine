---
sip: 3
title: Voice and video calling
author: sodium-qed
status: Accepted
created: 2026-09-12
updated: 2026-09-14
---

# SIP-3: Voice and video calling

## Summary

Serotine's live voice/video calling implementation now includes one-to-one calls, private-group calls, and community voice channels. The implementation is merged, but this SIP remains Accepted while production TURN and real audio/video transport across physical devices on different networks still require verification.

## Implementation status

[PR #58](https://github.com/taco-jpg/serotine/pull/58) implemented direct calling; [PR #59](https://github.com/taco-jpg/serotine/pull/59) added routing recovery, Cloudflare TURN credential support, group calls, and community voice channels. Automated checks and browser signaling/capture/UI checks are documented in those PRs. The restricted browser runner did not establish RTP media connectivity, so these results do not establish reliable live calling. The [calling implementation notes](https://github.com/taco-jpg/serotine/blob/main/docs/SIP-3-calling.md) retain the production rollout requirements. Status reviewed on 2026-09-14.

## Motivation

Text, attachments, and recorded voice messages do not replace a live conversation. Calling would let people talk, explain something, or spend time together without leaving Serotine or exchanging another account. It should use their existing contacts and preserve room for the conversation.

The [current application README](https://github.com/taco-jpg/serotine/blob/main/README.md) describes device-local identities, encrypted messaging, linked devices, and open-tab notifications. Calling should fit those behaviors rather than assume phone numbers, a new account system, or closed-app push delivery.

## Proposal

### Start and answer a call

Add **Voice call** and **Video call** actions to an eligible direct conversation's header. The recipient sees the caller using their local contact label, the call type, and clear accept/decline controls. They can answer a video invitation with audio only. Sending an invitation never activates the recipient's microphone or camera.

Request microphone access only when the user starts or accepts a call. Request camera access only after an explicit video action. Show the local camera preview and intended microphone state before connecting; a voice call starts with the camera off. Neither side transmits media before acceptance. Permission denial should explain how to retry or continue with a supported option.

Allow calls only between accepted contacts. Blocked senders and unaccepted message requests cannot ring. Respect archived and muted conversations' notification behavior, and provide a setting to silence all incoming calls without disabling messaging. Rate-limit repeated invitations.

### During a call

Keep a compact call bar visible while the user reads or sends messages. Include microphone mute, camera on/off, duration, connection status, and a prominent end-call button. Video can expand into a larger view or collapse back to the conversation. Support keyboard operation, labeled controls, and touch targets that remain usable on narrow screens. Show mute and camera states without relying on color alone.

Let users choose available microphones/cameras and switch the phone camera where supported. Turning the camera off stops camera capture; ending, cancelling, or failing a call releases all media devices. Recovering a connection must preserve mute and camera choices. Camera failure should allow the call to continue with audio.

Show distinct ringing, connecting, connected, reconnecting, declined, unanswered, busy, and failed states. The caller can cancel ringing, which dismisses the invitation on receiving clients. Invites expire after a short timeout. A disconnect gets a bounded reconnection attempt followed by a clear retry action; it must not ring indefinitely or silently start another call.

### Devices and call history

Permit one active call per identity in the first version. When multiple linked devices or tabs receive an invitation, accepting on one claims the call and stops ringing elsewhere. Simultaneous answers and simultaneous outgoing calls need a deterministic resolution. Switching identities ends the local call.

Initially, both participants need Serotine open and running. Do not promise reliable ringing when a browser is closed or suspended. Explain interruptions on mobile and preserve the conversation when calling fails.

The conversation's Call history stores local summaries of completed or missed direct calls, with type, time, outcome, and duration where applicable. Summaries are included in encrypted full backups but do not synchronize live across devices. Local deletion markers survive restore. Store no recordings or transcripts; private calls leave no persistent summaries. Live invitations, connection details, and credentials are excluded from backups and must never be restored as active calls.

### Private groups and community voice channels

Current members can start or explicitly join an ongoing voice/video call from an existing private group. Starting a room does not ring every member. Community administrators can also create audio-only Voice channels; moderator-restricted channels admit administrators and moderators. Participants review their devices before joining and can see who is present. Rooms use pairwise encrypted WebRTC connections with an eight-participant cap, independently of the text-group size. Signed membership governs admission and signaling; membership changes, deletion, and departures revoke room access as updates are processed.

Community voice channels extend the invitation-based communities in [SIP-1](SIP-1-public-communities-and-channels.md); they are not a public discovery service. Screen sharing, recording, and livestreaming remain outside the implemented scope. Physical-device, cross-network, and room-load validation remain rollout work.

## Security & Privacy

Authenticate call invitations, acceptance, and negotiation against the existing conversation identities. Bind them to a unique call ID, intended participants, expiry, and selected device sessions; reject forged, stale, duplicate, or mismatched events. Protect negotiation contents with encryption and bind the negotiated media keys to the authenticated participants.

Require end-to-end encrypted media. Messaging encryption alone does not establish this guarantee for a new media path. Any later group media service needs its own reviewed encryption and membership design before claiming the same protection.

Direct connections can expose participants' network addresses to each other. Relay-only is the default and limits this exposure, but the relay operator still sees connection metadata and carries the traffic. The site operator supplies and pays for TURN; coturn-compatible and Cloudflare Realtime credentials are supported. Missing TURN blocks relay-only setup. Allowing direct connections requires explicit opt-in and cannot override a relay-only invitation from the other participant. These tradeoffs follow the [WebRTC specification's transport-policy and privacy provisions](https://www.w3.org/TR/webrtc/).

Do not log media, raw negotiation payloads, or reusable relay credentials. Use short-lived relay credentials and bounded invitation lifetimes. Explain that encryption cannot prevent another participant from externally recording a call, and that call timing and routing metadata may remain visible to infrastructure operators.

## Compatibility

Negotiate calling support before ringing. For older clients, show that calling is unavailable or unconfirmed instead of implying that the recipient declined. Unsupported calling events must not break ordinary messaging, attachments, or recorded voice messages. Self-conversations do not offer call buttons.

Private mode keeps its existing text-expiry meaning; it does not turn a message timer into a call-duration limit. Private calls suppress persistent summaries. Switching an ordinary call to private also removes any completed summary when the privacy correction arrives, retaining only a deletion marker where necessary to prevent restoration. Signaling never enters message history or backups.

## Alternatives

External meeting links are simpler but move the conversation to another service. Audio-only calling would be a smaller first milestone while retaining video as the next step. Launching large group calls immediately would expand infrastructure and encryption work before direct calling is reliable.

## Remaining rollout checks and follow-ups

- Verify a working production TURN service and real audio/video calls between physical devices on different networks; include permission denial, audio output, cameras, backgrounding, reconnection, and capture cleanup.
- Validate group/community membership changes and the eight-participant mesh limit on target devices and networks.
- The implementation uses a 40-second invitation expiry, 30-second setup deadline, and 15-second reconnection window. Confirm these work acceptably across the supported browser/device matrix.
- Closed-app notifications, device handoff, and live cross-device history synchronization remain follow-up design work.

## Implementation Notes

The implementation uses WebRTC media with separate, short-lived authenticated and encrypted signaling integrated with Serotine identities. Signed SDP pins each peer's DTLS fingerprint. WebRTC leaves signaling to the application and commonly uses STUN/TURN for connectivity; see the [official peer-connection guide](https://webrtc.org/getting-started/peer-connections). The retained text-event relay does not carry continuous audio/video, and an old text event must never revive an expired call.

Before marking this SIP Final and completing production rollout, verify: two real devices can place and answer audio/video calls across different networks; blocked or stale invitations cannot ring; permission denial leaves chat usable; only one linked device wins an answer; mute/camera choices survive reconnection; ending or failing releases capture; relay-only policy survives network failures; older clients remain usable; and private calls leave no persistent local or backup history. Group calling needs additional membership-change and load checks before rollout.
