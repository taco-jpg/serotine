import { decryptFromPeer, encryptForPeer, importKey } from "./crypto"
import { directIceConfiguration, DIRECT_SIGNAL_TTL, signDirectSignal, validDirectSignal, validDirectSdp, verifiedDirectPair, type DirectSignal, type DirectStatus } from "./direct-protocol"
import type { Identity } from "./identity"
import type { MessagingEvent } from "./messaging-types"

interface Dependencies {
  signal: (signal: DirectSignal) => Promise<void>
  event: (event: MessagingEvent) => Promise<void>
  allowed: (peer: string) => boolean
  changed: () => void
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection
  iceServers?: RTCIceServer[]
}
interface Connection {
  peer: string; session: string; pc: RTCPeerConnection; channel?: RTCDataChannel; status: DirectStatus
  timer?: ReturnType<typeof setTimeout>; monitor?: ReturnType<typeof setInterval>; receiving: Promise<void>; wire: Promise<void>; queuedBytes: number; sending: boolean
  assembly?: { id: string; count: number; pieces: string[]; bytes: number }
  pending?: { id: string; resolve: () => void; reject: (error: Error) => void }
}
const fail = (reason = "The direct connection is unavailable. Reconnect while both people have Force P2P enabled.") => new Error(reason)

/** No message relay or file-storage dependency exists in this transport. */
export class DirectTransport {
  private connections = new Map<string, Connection>()
  private disposed = false
  private seen = new Set<string>()
  constructor(private identity: Identity, private dependencies: Dependencies) {}
  status(peer: string): DirectStatus { return this.connections.get(peer)?.status ?? { state: "idle", reason: "Peer unavailable. Both people must enable Force P2P and connect." } }
  private active(c: Connection) { return !this.disposed && this.connections.get(c.peer) === c && this.dependencies.allowed(c.peer) }
  private state(c: Connection, state: DirectStatus["state"], reason: string) { c.status = { state, reason }; this.dependencies.changed() }
  private stop(c: Connection, reason: string, state: DirectStatus["state"] = "failed") {
    clearTimeout(c.timer); clearInterval(c.monitor)
    c.pending?.reject(fail(reason)); c.pending = undefined; c.assembly = undefined
    c.channel?.close(); c.pc.close(); this.state(c, state, reason)
  }
  private async route(c: Connection) {
    if (!this.active(c) || c.channel?.readyState !== "open" || c.pc.connectionState !== "connected") throw fail()
    const stats = await c.pc.getStats()
    if (!this.active(c) || c.channel?.readyState !== "open" || c.pc.connectionState !== "connected" || !verifiedDirectPair(stats)) throw fail("A direct candidate pair could not be verified. Sending is blocked; TURN and relay fallback are disabled.")
  }
  private make(peer: string, session: string) {
    if (!this.dependencies.allowed(peer) || this.disposed) throw fail("Force P2P is available only for accepted contacts who enabled it.")
    const old = this.connections.get(peer); if (old) this.stop(old, "Starting a new direct connection.")
    const configuration = directIceConfiguration(this.dependencies.iceServers)
    const pc = this.dependencies.createPeerConnection?.(configuration) ?? new RTCPeerConnection(configuration)
    const c: Connection = { peer, session, pc, status: { state: "connecting", reason: "Connecting directly…" }, receiving: Promise.resolve(), wire: Promise.resolve(), queuedBytes: 0, sending: false }
    this.connections.set(peer, c)
    c.timer = setTimeout(() => this.stop(c, "Peer unavailable or direct path blocked. Both people must enable Force P2P and stay online.", "unavailable"), 25_000)
    pc.ondatachannel = event => { if (c.channel || event.channel.label !== "serotine-direct-v1") { event.channel.close(); return }; this.attach(c, event.channel) }
    pc.onconnectionstatechange = () => {
      if (!this.active(c)) return
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) this.stop(c, "Direct connection lost. Delivery is unconfirmed until a direct retry succeeds.")
    }
    pc.onicecandidate = event => { if (event.candidate && event.candidate.type === "relay") this.stop(c, "A relay candidate was rejected. Force P2P never uses TURN.") }
    this.dependencies.changed(); return c
  }
  private attach(c: Connection, channel: RTCDataChannel) {
    c.channel = channel; channel.bufferedAmountLowThreshold = 32 * 1024
    channel.onopen = () => { void this.route(c).then(() => {
      if (!this.active(c)) return
      clearTimeout(c.timer); this.state(c, "connected", "Connected directly")
      c.monitor = setInterval(() => { void this.route(c).catch(error => this.stop(c, error.message)) }, 1000)
    }).catch(error => this.stop(c, error.message)) }
    channel.onclose = () => { if (this.active(c) && c.status.state === "connected") this.stop(c, "Direct channel closed. Retry directly after reconnecting.") }
    channel.onerror = () => this.stop(c, "The direct data channel failed. No relay fallback was attempted.")
    channel.onmessage = message => {
      if (typeof message.data !== "string" || message.data.length > 16384 || c.queuedBytes + message.data.length > 128000) { this.stop(c, "Oversized direct frame rejected."); return }
      c.queuedBytes += message.data.length
      // Browser message processing is serialized, with bounded assembly below.
      c.receiving = c.receiving.then(() => this.receive(c, message.data)).catch(error => this.stop(c, error instanceof Error ? error.message : "Invalid direct packet.")).finally(() => { c.queuedBytes -= message.data.length })
    }
  }
  private async gathered(c: Connection) {
    if (c.pc.iceGatheringState === "complete") return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { c.pc.removeEventListener("icegatheringstatechange", listener); reject(fail("Direct setup timed out while gathering network candidates.")) }, 8000)
      const listener = () => { if (c.pc.iceGatheringState === "complete") { clearTimeout(timer); c.pc.removeEventListener("icegatheringstatechange", listener); resolve() } }
      c.pc.addEventListener("icegatheringstatechange", listener); listener()
    })
  }
  private async signal(c: Connection, kind: DirectSignal["kind"]) {
    if (!this.active(c)) throw fail()
    const sdp = c.pc.localDescription?.sdp
    if (kind !== "close" && !validDirectSdp(sdp)) throw fail("Unsupported or relay-containing direct session description.")
    const now = Date.now()
    const signal = await signDirectSignal({ version: 1, policy: "direct-only", sender: this.identity.publicKey, recipient: c.peer, session: c.session, kind, timestamp: now, expiresAt: now + DIRECT_SIGNAL_TTL, ...(kind === "close" ? {} : { sdp }) }, this.identity)
    if (!this.active(c)) throw fail()
    await this.dependencies.signal(signal)
  }
  connect = async (peer: string) => {
    const c = this.make(peer, crypto.randomUUID())
    try {
      this.attach(c, c.pc.createDataChannel("serotine-direct-v1", { ordered: true }))
      await c.pc.setLocalDescription(await c.pc.createOffer()); await this.gathered(c); await this.signal(c, "offer")
    } catch (error) { this.stop(c, error instanceof Error ? error.message : "Direct setup failed."); throw error }
  }
  receiveSignal = async (signal: DirectSignal) => {
    if (this.disposed || signal.recipient !== this.identity.publicKey || !this.dependencies.allowed(signal.sender) || !await validDirectSignal(signal)) return
    const key = `${signal.sender}:${signal.session}:${signal.kind}`
    if (this.seen.has(key)) return
    if (this.seen.size > 2000) this.seen.clear()
    this.seen.add(key)
    let c = this.connections.get(signal.sender)
    if (signal.kind === "close") { if (c?.session === signal.session) this.stop(c, "The other person closed the direct connection.", "unavailable"); return }
    if (signal.kind === "answer") {
      if (!c || c.session !== signal.session || c.pc.signalingState !== "have-local-offer") return
      await c.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp }); return
    }
    // Crossed offers use one deterministic initiator; never combine sessions.
    if (c?.status.state === "connecting" && this.identity.publicKey < signal.sender) return
    c = this.make(signal.sender, signal.session)
    try {
      await c.pc.setRemoteDescription({ type: "offer", sdp: signal.sdp })
      await c.pc.setLocalDescription(await c.pc.createAnswer()); await this.gathered(c); await this.signal(c, "answer")
    } catch (error) { this.stop(c, error instanceof Error ? error.message : "Invalid direct setup.") }
  }
  private async frame(c: Connection, frame: object) {
    const wire = JSON.stringify(frame), limit = Math.min(16384, c.pc.sctp?.maxMessageSize || 16384)
    if (new TextEncoder().encode(wire).byteLength > limit) throw fail("The peer's data-channel message limit is too small.")
    const deadline = Date.now() + 10_000
    while (c.channel && c.channel.bufferedAmount > 64 * 1024) {
      if (!this.active(c) || Date.now() > deadline) throw fail("Direct transfer stalled. Reconnect and retry directly.")
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await this.route(c)
    c.channel!.send(wire)
  }
  private async encrypted(c: Connection, id: string, value: object) {
    const key = await importKey(this.identity.privateKey, "encryption", "private")
    const encrypted = await encryptForPeer(JSON.stringify({ session: c.session, ...value }), key, c.peer)
    const size = Math.min(8000, Math.floor((c.pc.sctp?.maxMessageSize || 16384) / 2))
    if (size < 512 || encrypted.length > 90000) throw fail("This direct event exceeds the supported bound.")
    const count = Math.ceil(encrypted.length / size)
    const send = c.wire.then(async () => { for (let index = 0; index < count; index++) await this.frame(c, { id, index, count, data: encrypted.slice(index * size, (index + 1) * size) }) })
    c.wire = send.catch(() => {}); await send
  }
  private async receive(c: Connection, raw: string) {
    await this.route(c)
    const frame = JSON.parse(raw) as { id: string; index: number; count: number; data: string }
    if (typeof frame.id !== "string" || frame.id.length > 100 || !Number.isInteger(frame.count) || frame.count < 1 || frame.count > 180
      || !Number.isInteger(frame.index) || frame.index < 0 || frame.index >= frame.count || typeof frame.data !== "string" || frame.data.length > 8000 || Object.keys(frame).length !== 4) throw fail("Invalid direct frame.")
    if (!c.assembly) c.assembly = { id: frame.id, count: frame.count, pieces: [], bytes: 0 }
    const a = c.assembly
    if (a.id !== frame.id || a.count !== frame.count || frame.index !== a.pieces.length || a.bytes + frame.data.length > 90000) throw fail("Interleaved or oversized direct event rejected.")
    a.pieces.push(frame.data); a.bytes += frame.data.length
    if (a.pieces.length !== a.count) return
    c.assembly = undefined
    const key = await importKey(this.identity.privateKey, "encryption", "private")
    const value = JSON.parse(await decryptFromPeer(a.pieces.join(""), key, c.peer)) as { session: string; event?: MessagingEvent; ack?: string }
    if (value.session !== c.session || !this.active(c)) throw fail("The direct event belongs to another session.")
    if (value.ack) { if (c.pending?.id === value.ack) { c.pending.resolve(); c.pending = undefined }; return }
    const event = value.event
    if (!event || event.author !== c.peer || event.conversationId !== this.identity.publicKey || event.route !== "direct-only") throw fail("The direct event's identity or route is invalid.")
    await this.dependencies.event(event)
    await this.encrypted(c, crypto.randomUUID(), { ack: event.id })
  }
  send = async (peer: string, event: MessagingEvent) => {
    const c = this.connections.get(peer)
    if (!c || c.sending) throw fail(c?.sending ? "Wait for the current direct transfer to finish." : undefined)
    // Reserve synchronously: two callers must not both pass before getStats resolves.
    c.sending = true
    try { await this.route(c) } catch (error) { c.sending = false; throw error }
    let timer: ReturnType<typeof setTimeout> | undefined
    const ack = new Promise<void>((resolve, reject) => { c.pending = { id: event.id, resolve, reject }; timer = setTimeout(() => { c.pending = undefined; reject(fail("Delivery is unconfirmed. Reconnect and retry directly with the same message ID.")) }, 15_000) })
    // Attach a rejection handler before encryption can fail.
    void ack.catch(() => {})
    try { await this.encrypted(c, event.id, { event }); await ack }
    finally { clearTimeout(timer); c.pending = undefined; c.sending = false }
  }
  disconnect(peer: string) { const c = this.connections.get(peer); if (c) { void this.signal(c, "close").catch(() => {}); this.stop(c, "Direct connection closed.", "idle") } }
  dispose() { this.disposed = true; for (const c of this.connections.values()) this.stop(c, "This identity is no longer active.", "idle"); this.connections.clear() }
}
