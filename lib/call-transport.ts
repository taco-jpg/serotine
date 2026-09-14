import type { Identity } from "./identity"
import { decryptFromPeer, encryptForPeer, importKey } from "./crypto"
import { createRequestProof, verifyRequestProof } from "./request-auth"
import { CALL_CLOCK_SKEW_MS, CALL_INVITE_TTL_MS, CALL_PAGE_SIZE, CALL_SIGNAL_TTL_MS, isCallId, isCallObject, isCallPayload,
  isCallSession, isEncryptedCallSignal, type CallConfiguration, type CallEndReason, type CallRoutingPolicy,
  type CallSession, type CallSignal, type CallSignalPayload, type EncryptedCallSignal } from "./call-protocol"
import type { RequestProof } from "./protocol"

import { createCallSocket, CallTransportError } from "./call-socket"
import { callIceConfiguration } from "./call-ice"
export { CallTransportError } from "./call-socket"
const UNEXPECTED = "The calling service returned an unexpected response. Reload Serotine and retry."

/** One memory-only device session per engine. No signaling or credentials enter storage/backups. */
export function createCallTransport(identity: Identity, sessionId = crypto.randomUUID()) {
  if (!isCallId(sessionId)) throw new CallTransportError("Invalid calling device session.")
  const key = importKey(identity.privateKey, "encryption", "private")
  const seen = new Map<string, number>()

  const socket = createCallSocket(identity, sessionId)
  const request = socket.request
  const now = () => socket.now?.() ?? Date.now()

  async function seal(callId: string, peer: string, targetSession: string | null, payload: CallSignalPayload): Promise<EncryptedCallSignal> {
    if (!isCallPayload(payload)) throw new CallTransportError("Invalid call negotiation.")
    const envelope: CallSignal = { id: crypto.randomUUID(), callId, sender: identity.publicKey, recipient: peer,
      senderSession: sessionId, targetSession, expiresAt: now() + (payload.kind === "invite" ? CALL_INVITE_TTL_MS : CALL_SIGNAL_TTL_MS), payload }
    const proof = await createRequestProof("call:envelope", envelope, identity.privateKey, identity.publicKey, now())
    const encryptedData = await encryptForPeer(JSON.stringify({ envelope, proof }), await key, peer)
    const { payload: _payload, ...routing } = envelope
    return { ...routing, encryptedData }
  }

  async function open(wire: EncryptedCallSignal, sessions: CallSession[]): Promise<CallSignal | null> {
    try {
      const time = now()
      if (wire.recipient !== identity.publicKey || (wire.targetSession !== null && wire.targetSession !== sessionId)
        || wire.expiresAt <= time || wire.expiresAt > time + CALL_INVITE_TTL_MS + CALL_CLOCK_SKEW_MS || seen.has(wire.id)) return null
      const decoded: unknown = JSON.parse(await decryptFromPeer(wire.encryptedData, await key, wire.sender))
      if (!isCallObject(decoded) || !isCallObject(decoded.envelope) || !isCallObject(decoded.proof)) return null
      const envelope = decoded.envelope
      for (const field of ["id", "callId", "sender", "recipient", "senderSession", "targetSession", "expiresAt"] as const) {
        if (envelope[field] !== wire[field]) return null
      }
      if (!isCallPayload(envelope.payload) || decoded.proof.publicKey !== wire.sender
        || !await verifyRequestProof("call:envelope", envelope, decoded.proof as unknown as RequestProof)) return null
      const session = sessions.find(item => item.callId === wire.callId)
      if (!session || session.status === "ended" || session.expiresAt <= time) return null
      if (envelope.payload.kind === "invite") {
        if (session.status !== "ringing" || wire.targetSession !== null || session.caller !== wire.sender
          || session.recipient !== wire.recipient || session.callerSession !== wire.senderSession || wire.expiresAt !== session.inviteExpiresAt) return null
      } else {
        if (session.status !== "active" || wire.targetSession === null) return null
        const callerSending = session.caller === wire.sender && session.callerSession === wire.senderSession
          && session.recipient === wire.recipient && session.recipientSession === wire.targetSession
        const recipientSending = session.recipient === wire.sender && session.recipientSession === wire.senderSession
          && session.caller === wire.recipient && session.callerSession === wire.targetSession
        if (!callerSending && !recipientSending) return null
        if (envelope.payload.kind === "accept" && !recipientSending) return null
      }
      seen.set(wire.id, wire.expiresAt)
      return envelope as unknown as CallSignal
    } catch { return null }
  }
  function resultSession(result: Record<string, unknown>, callId: string) {
    if (!isCallSession(result.session) || result.session.callId !== callId
      || (result.session.caller !== identity.publicKey && result.session.recipient !== identity.publicKey)) throw new CallTransportError(UNEXPECTED)
    return result.session
  }

  return {
    sessionId,
    now,
    subscribe: socket.subscribe,
    dispose: socket.dispose,
    async heartbeat(acceptedPeers: string[], incomingPeers = acceptedPeers): Promise<void> {
      const peers = [...new Set(acceptedPeers)].filter(peer => peer !== identity.publicKey).slice(0, 500)
      await request("call:heartbeat", { sessionId, peers, incomingPeers: [...new Set(incomingPeers)].filter(peer => peers.includes(peer)) })
    },
    async capability(peer: string): Promise<{ available: boolean; busy: boolean }> {
      const result = await request("call:capability", { sessionId, peer })
      if (typeof result.available !== "boolean" || typeof result.busy !== "boolean") throw new CallTransportError(UNEXPECTED)
      return { available: result.available, busy: result.busy }
    },
    async invite(peer: string, callId: string, payload: Extract<CallSignalPayload, { kind: "invite" }>): Promise<CallSession> {
      const signal = await seal(callId, peer, null, payload)
      const session = resultSession(await request("call:invite", { sessionId, signal, noHistory: payload.private }), callId)
      if (session.caller !== identity.publicKey || session.callerSession !== sessionId || session.recipient !== peer) throw new CallTransportError(UNEXPECTED)
      return session
    },
    async claim(callId: string, noHistory = false): Promise<CallSession> {
      const session = resultSession(await request("call:claim", { sessionId, callId, noHistory }), callId)
      if (session.recipient !== identity.publicKey || session.recipientSession !== sessionId) throw new CallTransportError(UNEXPECTED)
      return session
    },
    async send(callId: string, peer: string, targetSession: string, payload: Exclude<CallSignalPayload, { kind: "invite" }>): Promise<void> {
      const signal = await seal(callId, peer, targetSession, payload)
      await request("call:send", { sessionId, signal, noHistory: "private" in payload && payload.private })
    },
    async poll(after = 0): Promise<{ signals: CallSignal[]; sessions: CallSession[]; nextCursor: number; hasMore?: boolean }> {
      const result = await request("call:poll", { sessionId, after })
      if (!Array.isArray(result.sessions) || result.sessions.length > 32 || !result.sessions.every(isCallSession)
        || !Array.isArray(result.signals) || result.signals.length > CALL_PAGE_SIZE || !result.signals.every(isEncryptedCallSignal)
        || !Number.isSafeInteger(result.nextCursor) || Number(result.nextCursor) < after
        || result.sessions.some(session => session.caller !== identity.publicKey && session.recipient !== identity.publicKey)) throw new CallTransportError(UNEXPECTED)
      let last = after
      for (const signal of result.signals) {
        if (!Number.isSafeInteger(signal.sequence) || Number(signal.sequence) <= last) throw new CallTransportError(UNEXPECTED)
        last = Number(signal.sequence)
      }
      if (last !== result.nextCursor) throw new CallTransportError(UNEXPECTED)
      for (const [id, expiry] of seen) if (expiry <= now()) seen.delete(id)
      const decoded = await Promise.all(result.signals.map(signal => open(signal, result.sessions as CallSession[])))
      return { signals: decoded.filter((signal): signal is CallSignal => signal !== null), sessions: result.sessions, nextCursor: last, hasMore: result.signals.length === CALL_PAGE_SIZE }
    },
    async finish(callId: string, reason: CallEndReason, noHistory = false): Promise<CallSession> {
      return resultSession(await request("call:finish", { sessionId, callId, reason, noHistory }), callId)
    },
    async configuration(policy: CallRoutingPolicy): Promise<CallConfiguration> {
      const result = await request("call:configuration", { sessionId, policy })
      if (!Array.isArray(result.iceServers) || !Number.isSafeInteger(result.expiresAt) || typeof result.relayAvailable !== "boolean") throw new CallTransportError(UNEXPECTED)
      const configuration = callIceConfiguration(result.iceServers as RTCIceServer[])
      if (result.relayAvailable !== configuration.iceServers!.some(server => !!server.credential)) throw new CallTransportError(UNEXPECTED)
      const turnStatus = result.turnStatus === "ready" || result.turnStatus === "not-configured" || result.turnStatus === "unavailable" ? result.turnStatus : undefined
      return { relayAvailable: result.relayAvailable, iceServers: configuration.iceServers!, expiresAt: Number(result.expiresAt), turnStatus }
    },
  }
}
export type CallTransport = ReturnType<typeof createCallTransport>
