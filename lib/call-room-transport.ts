import type { Identity } from "./identity"
import type { RequestProof } from "./protocol"
import { decryptFromPeer, encryptForPeer, importKey } from "./crypto"
import { createRequestProof, verifyRequestProof } from "./request-auth"
import { CALL_PAGE_SIZE, CALL_SIGNAL_TTL_MS, isCallId, isCallObject, type CallRoutingPolicy } from "./call-protocol"
import { CallTransportError } from "./call-transport"
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
  async function request(action: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const proof = await createRequestProof(action, data, identity.privateKey, identity.publicKey)
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new CallTransportError("The calling service took too long to respond. Retry the call.")) }, 10_000) })
    try {
      return await Promise.race([timeout, (async () => {
        const response = await fetch("/api/calls", { method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store",
          referrerPolicy: "strict-origin", headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ version: 1, action, data, proof }), signal: controller.signal })
        if (response.status === 404) throw new CallTransportError("Group calling is not available on this server yet.")
        if (response.status >= 500) throw new CallTransportError("Calling is temporarily unavailable. Your conversation is still available.")
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new CallTransportError(UNEXPECTED)
        const result: unknown = await response.json()
        if (!isCallObject(result)) throw new CallTransportError(UNEXPECTED)
        if (result.success === false) {
          if (typeof result.error !== "string" || result.error.length > 500 || /[<>]/.test(result.error) || [...result.error].some(c => c.charCodeAt(0) < 32)) throw new CallTransportError(UNEXPECTED)
          throw new CallTransportError(result.error)
        }
        if (!response.ok || result.success !== true) throw new CallTransportError(UNEXPECTED)
        return result
      })()])
    } catch (error) {
      if (error instanceof CallTransportError) throw error
      throw new CallTransportError("Could not reach the calling service. Check your connection and retry.")
    } finally { clearTimeout(timer); controller.abort() }
  }
  function room(result: Record<string, unknown>, target: CallRoomTarget): CallRoomState {
    const members = target.kind === "group" ? target.group.members : target.community.members.filter(p => canJoinCommunityVoiceChannel(target.community, p, target.channelId))
    if (!isCallRoomState(result.room) || result.room.roomId !== callRoomId(target) || result.room.participants.some(p => !members.includes(p.publicKey))) throw new CallTransportError(UNEXPECTED)
    return result.room
  }
  async function open(wire: EncryptedCallRoomSignal, state: CallRoomState): Promise<CallRoomSignal | null> {
    try {
      const now = Date.now()
      if (wire.roomId !== state.roomId || wire.recipient !== identity.publicKey || wire.targetSession !== sessionId || wire.expiresAt <= now
        || wire.expiresAt > now + CALL_SIGNAL_TTL_MS || seen.has(wire.id)
        || !state.participants.some(p => p.publicKey === wire.sender && p.sessionId === wire.senderSession && p.expiresAt > now)
        || !state.participants.some(p => p.publicKey === identity.publicKey && p.sessionId === sessionId && p.expiresAt > now)) return null
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
    async join(target: CallRoomTarget, mode: "voice" | "video", policy: CallRoutingPolicy): Promise<CallRoomState> {
      if (target.kind === "channel" && mode !== "voice") throw new CallTransportError("Voice channels support microphone audio. Start a group video call to use a camera.")
      const state = room(await request("room:join", { sessionId, target, mode, policy }), target)
      if (!state.participants.some(p => p.publicKey === identity.publicKey && p.sessionId === sessionId && p.mode === mode && p.policy === policy)) throw new CallTransportError(UNEXPECTED)
      return state
    },
    async status(target: CallRoomTarget): Promise<CallRoomState> { return room(await request("room:status", { sessionId, target }), target) },
    async poll(target: CallRoomTarget, after = 0): Promise<{ room: CallRoomState; signals: CallRoomSignal[]; nextCursor: number }> {
      const result = await request("room:poll", { sessionId, target, after })
      const state = room(result, target)
      if (!Array.isArray(result.signals) || result.signals.length > CALL_PAGE_SIZE || !result.signals.every(isEncryptedCallRoomSignal)
        || !Number.isSafeInteger(result.nextCursor) || Number(result.nextCursor) < after) throw new CallTransportError(UNEXPECTED)
      let last = after
      for (const signal of result.signals) { if (!Number.isSafeInteger(signal.sequence) || Number(signal.sequence) <= last) throw new CallTransportError(UNEXPECTED); last = Number(signal.sequence) }
      if (result.nextCursor !== last) throw new CallTransportError(UNEXPECTED)
      for (const [id, expires] of seen) if (expires <= Date.now()) seen.delete(id)
      const decoded = await Promise.all(result.signals.map(signal => open(signal, state)))
      return { room: state, signals: decoded.filter((signal): signal is CallRoomSignal => signal !== null), nextCursor: last }
    },
    async send(roomId: string, peer: string, targetSession: string, payload: CallRoomPayload): Promise<void> {
      if (!isCallRoomPayload(payload)) throw new CallTransportError("Invalid room negotiation.")
      const envelope: CallRoomSignal = { id: crypto.randomUUID(), roomId, sender: identity.publicKey, recipient: peer, senderSession: sessionId,
        targetSession, expiresAt: Date.now() + CALL_SIGNAL_TTL_MS, payload }
      const proof = await createRequestProof("room:envelope", envelope, identity.privateKey, identity.publicKey)
      const encryptedData = await encryptForPeer(JSON.stringify({ envelope, proof }), await key, peer)
      const { payload: _payload, ...routing } = envelope
      await request("room:send", { sessionId, signal: { ...routing, encryptedData } })
    },
    async leave(roomId: string): Promise<void> { await request("room:leave", { sessionId, roomId }) },
  }
}
export type CallRoomTransport = ReturnType<typeof createCallRoomTransport>
