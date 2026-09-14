import type { Identity } from "./identity"
import type { RequestProof } from "./protocol"
import { decryptFromPeer, encryptForPeer, importKey } from "./crypto"
import { createRequestProof, verifyRequestProof } from "./request-auth"
import { CALL_CLOCK_SKEW_MS, CALL_PAGE_SIZE, CALL_SIGNAL_TTL_MS, isCallId, isCallObject, type CallRoutingPolicy } from "./call-protocol"
import { CallTransportError, createCallSocket } from "./call-socket"
import { canJoinCommunityVoiceChannel } from "./community-protocol"
import { callRoomId, isCallRoomState, isCallRoomPayload, isEncryptedCallRoomSignal,
  type CallRoomTarget, type CallRoomState, type CallRoomPayload, type CallRoomSignal, type EncryptedCallRoomSignal } from "./call-room-protocol"
export { callRoomId } from "./call-room-protocol"
export type { CallRoomTarget, CallRoomState, CallRoomPayload, CallRoomSignal } from "./call-room-protocol"

const UNEXPECTED = "The calling service returned an unexpected room response. Reload Serotine and retry."
/** Memory-only identity/device binding. Create a fresh transport for every join. */
export function createCallRoomTransport(identity: Identity, sessionId = crypto.randomUUID()) {
  if (!isCallId(sessionId)) throw new CallTransportError("Invalid calling device session.")
  const key = importKey(identity.privateKey, "encryption", "private")
  const seen = new Map<string, number>()
  const socket = createCallSocket(identity, sessionId)
  const request = socket.request
  const now = () => socket.now?.() ?? Date.now()
  function room(result: Record<string, unknown>, target: CallRoomTarget): CallRoomState {
    const members = target.kind === "group" ? target.group.members : target.community.members.filter(p => canJoinCommunityVoiceChannel(target.community, p, target.channelId))
    if (!isCallRoomState(result.room) || result.room.roomId !== callRoomId(target) || result.room.participants.some(p => !members.includes(p.publicKey))) throw new CallTransportError(UNEXPECTED)
    return result.room
  }
  async function open(wire: EncryptedCallRoomSignal, state: CallRoomState): Promise<CallRoomSignal | null> {
    try {
      const time = now()
      if (wire.roomId !== state.roomId || wire.recipient !== identity.publicKey || wire.targetSession !== sessionId || wire.expiresAt <= time
        || wire.expiresAt > time + CALL_SIGNAL_TTL_MS + CALL_CLOCK_SKEW_MS || seen.has(wire.id)
        || !state.participants.some(p => p.publicKey === wire.sender && p.sessionId === wire.senderSession && p.expiresAt > time)
        || !state.participants.some(p => p.publicKey === identity.publicKey && p.sessionId === sessionId && p.expiresAt > time)) return null
      const decoded: unknown = JSON.parse(await decryptFromPeer(wire.encryptedData, await key, wire.sender))
      if (!isCallObject(decoded) || !isCallObject(decoded.envelope) || !isCallObject(decoded.proof)) return null
      const envelope = decoded.envelope
      for (const field of ["id", "roomId", "sender", "recipient", "senderSession", "targetSession", "expiresAt"] as const) if (wire[field] !== envelope[field]) return null
      if (!isCallRoomPayload(envelope.payload) || decoded.proof.publicKey !== wire.sender
        || !await verifyRequestProof("room:envelope", envelope, decoded.proof as unknown as RequestProof)) return null
      seen.set(wire.id, wire.expiresAt)
      return envelope as unknown as CallRoomSignal
    } catch { return null }
  }
  return {
    sessionId,
    now,
    subscribe: socket.subscribe,
    dispose: socket.dispose,
    async join(target: CallRoomTarget, mode: "voice" | "video", policy: CallRoutingPolicy): Promise<CallRoomState> {
      if (target.kind === "channel" && mode !== "voice") throw new CallTransportError("Voice channels support microphone audio. Start a group video call to use a camera.")
      const state = room(await request("room:join", { sessionId, target, mode, policy }), target)
      if (!state.participants.some(p => p.publicKey === identity.publicKey && p.sessionId === sessionId && p.mode === mode && p.policy === policy)) throw new CallTransportError(UNEXPECTED)
      return state
    },
    async status(target: CallRoomTarget): Promise<CallRoomState> { return room(await request("room:status", { sessionId, target }), target) },
    async poll(target: CallRoomTarget, after = 0): Promise<{ room: CallRoomState; signals: CallRoomSignal[]; nextCursor: number; hasMore?: boolean }> {
      const result = await request("room:poll", { sessionId, target, after })
      const state = room(result, target)
      if (!Array.isArray(result.signals) || result.signals.length > CALL_PAGE_SIZE || !result.signals.every(isEncryptedCallRoomSignal)
        || !Number.isSafeInteger(result.nextCursor) || Number(result.nextCursor) < after) throw new CallTransportError(UNEXPECTED)
      let last = after
      for (const signal of result.signals) { if (!Number.isSafeInteger(signal.sequence) || Number(signal.sequence) <= last) throw new CallTransportError(UNEXPECTED); last = Number(signal.sequence) }
      if (result.nextCursor !== last) throw new CallTransportError(UNEXPECTED)
      for (const [id, expires] of seen) if (expires <= now()) seen.delete(id)
      const decoded = await Promise.all(result.signals.map(signal => open(signal, state)))
      return { room: state, signals: decoded.filter((signal): signal is CallRoomSignal => signal !== null), nextCursor: last, hasMore: result.signals.length === CALL_PAGE_SIZE }
    },
    async send(roomId: string, peer: string, targetSession: string, payload: CallRoomPayload): Promise<void> {
      if (!isCallRoomPayload(payload)) throw new CallTransportError("Invalid room negotiation.")
      const envelope: CallRoomSignal = { id: crypto.randomUUID(), roomId, sender: identity.publicKey, recipient: peer, senderSession: sessionId,
        targetSession, expiresAt: now() + CALL_SIGNAL_TTL_MS, payload }
      const proof = await createRequestProof("room:envelope", envelope, identity.privateKey, identity.publicKey, now())
      const encryptedData = await encryptForPeer(JSON.stringify({ envelope, proof }), await key, peer)
      const { payload: _payload, ...routing } = envelope
      await request("room:send", { sessionId, signal: { ...routing, encryptedData } })
    },
    async leave(roomId: string): Promise<void> { await request("room:leave", { sessionId, roomId }) },
  }
}
export type CallRoomTransport = ReturnType<typeof createCallRoomTransport>
