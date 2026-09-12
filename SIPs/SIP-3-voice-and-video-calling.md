---
sip: 3
title: Voice and video calling
author: sodium-qed
status: Draft
created: 2026-09-12
---

# SIP-3: Voice and video calling

## Summary

Add live voice and video calls inside Serotine conversations. Start with one-to-one calls, then extend the design to existing private groups after reliability, privacy, and operating costs are understood. This is a proposal for discussion, not an implementation or an accepted commitment.

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

Use small conversation entries for completed or missed calls, with type, time, and duration where applicable. Store no recordings or transcripts. Define how these entries follow existing local deletion and backup rules; private-chat calls should leave no persistent history. Live invitations, connection details, and credentials must not be restored as active calls from backups or delayed synchronization.

### Private-group follow-up

Later, let current members start or explicitly join an ongoing voice/video call from an existing private group. Show who is present before joining and while connected. Re-check membership when joining or reconnecting and stop delivering future media to removed members. A group call's participant limit should be established through testing, independently of the text-group size.

Public voice channels, screen sharing, recording, and livestreaming are outside the initial scope. Public-community calling would need a separate design coordinated with SIP-1.

## Security & Privacy

Authenticate call invitations, acceptance, and negotiation against the existing conversation identities. Bind them to a unique call ID, intended participants, expiry, and selected device sessions; reject forged, stale, duplicate, or mismatched events. Protect negotiation contents with encryption and bind the negotiated media keys to the authenticated participants.

Require end-to-end encrypted media. Messaging encryption alone does not establish this guarantee for a new media path. Any later group media service needs its own reviewed encryption and membership design before claiming the same protection.

Direct connections can expose participants' network addresses to each other. A relay-only mode can limit this exposure, but the relay operator still sees connection metadata and carries the traffic. The default connection policy, operator, and budget remain decisions before implementation. If a user selects relay-only privacy, a failed relay must not silently fall back to a direct connection. These tradeoffs follow the [WebRTC specification's transport-policy and privacy provisions](https://www.w3.org/TR/webrtc/).

Do not log media, raw negotiation payloads, or reusable relay credentials. Use short-lived relay credentials and bounded invitation lifetimes. Explain that encryption cannot prevent another participant from externally recording a call, and that call timing and routing metadata may remain visible to infrastructure operators.

## Compatibility

Negotiate calling support before ringing. For older clients, show that calling is unavailable or unconfirmed instead of implying that the recipient declined. Unsupported calling events must not break ordinary messaging, attachments, or recorded voice messages. Self-conversations do not offer call buttons.

Private mode keeps its existing text-expiry meaning; it does not silently turn a message timer into a call-duration limit. Before enabling calls there, define their interaction with private-history destruction and ensure call history and signaling do not leak into backups.

## Alternatives

External meeting links are simpler but move the conversation to another service. Audio-only calling would be a smaller first milestone while retaining video as the next step. Launching large group calls immediately would expand infrastructure and encryption work before direct calling is reliable.

## Open Questions

- Should relay-only routing be the default, and who operates and pays for it?
- What invite timeout, reconnect window, and browser/device support matrix should the first release use?
- How should call history synchronize between linked devices while respecting private mode and local deletion?
- What group size and media architecture meet the privacy and performance requirements?
- Should closed-app notifications and device handoff receive later proposals?

## Implementation Notes

Evaluate WebRTC for media and a short-lived authenticated signaling path integrated with Serotine's identities. WebRTC leaves signaling to the application and commonly uses STUN/TURN for connectivity; see the [official peer-connection guide](https://webrtc.org/getting-started/peer-connections). The retained text-event relay should not carry continuous audio/video, and an old text event must never revive an expired call.

Before accepting an implementation, verify: two real devices can place and answer audio/video calls across different networks; blocked or stale invitations cannot ring; permission denial leaves chat usable; only one linked device wins an answer; mute/camera choices survive reconnection; ending or failing releases capture; relay-only policy survives network failures; older clients remain usable; and private calls leave no persistent local or backup history. Group calling needs additional membership-change and load checks before rollout.
