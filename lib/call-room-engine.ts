import { CallTransportError, createCallTransport } from "./call-transport"
import { callRoomId, createCallRoomTransport, type CallRoomTarget } from "./call-room-transport"
import type { CallRoomSignal, CallRoomState } from "./call-room-protocol"
import type { CallSignalPayload } from "./call-protocol"
import type { CallMode, CallSettings } from "./call-types"
import type { CallRoomController, CallRoomEngineOptions, CallRoomParticipantSnapshot, CallRoomSnapshot } from "./call-room-types"
import { canJoinCommunityVoiceChannel } from "./community-protocol"

type RoomTransport = ReturnType<typeof createCallRoomTransport>
type RoomPayload = Exclude<CallSignalPayload, { kind: "invite" | "accept" }>
type Member = CallRoomState["participants"][number]
interface Peer {
  member: Member
  pc: RTCPeerConnection
  audioSender: RTCRtpSender
  videoSender: RTCRtpSender
  snapshot: CallRoomParticipantSnapshot
  queue: Promise<void>
  pendingIce: RTCIceCandidateInit[]
  fingerprint: string | null
  deadline: ReturnType<typeof setTimeout> | null
  restarted: boolean
  closed: boolean
}
export interface CallRoomEngineDependencies {
  transport?: RoomTransport
  createTransport?: () => RoomTransport
  configurationTransport?: Pick<ReturnType<typeof createCallTransport>, "configuration">
  mediaDevices?: Pick<MediaDevices, "getUserMedia" | "enumerateDevices">
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection
  createMediaStream?: (tracks?: MediaStreamTrack[]) => MediaStream
  now?: () => number
  pollIntervalMs?: number
  prepareTimeoutMs?: number
  connectTimeoutMs?: number
  reconnectTimeoutMs?: number
}
const TERMINAL = new Set(["idle", "ended", "failed"])
const stopStream = (stream: MediaStream | null) => stream?.getTracks().forEach(track => track.stop())
const message = (error: unknown) => error instanceof Error ? error.message : "Calling is temporarily unavailable. Try again."
const captureMessage = (error: unknown) => error instanceof Error && /NotAllowed|Permission|Security/i.test(`${error.name} ${error.message}`)
  ? "Microphone or camera access was denied. Allow access in your browser's site settings, then try again."
  : error instanceof Error && /NotFound|NotReadable|Overconstrained/i.test(`${error.name} ${error.message}`)
    ? "That microphone or camera is unavailable. Choose another device."
    : message(error)
const label = (target: CallRoomTarget) => target.kind === "group" ? target.group.name
  : `${target.community.name} · ${target.community.channels.find(channel => channel.id === target.channelId)?.name ?? "Voice channel"}`

/** Memory-only, consent-first mesh calling. A room has at most eight identities. */
export class CallRoomEngine implements CallRoomController {
  private transport: RoomTransport | null = null
  private readonly configurationTransport: Pick<ReturnType<typeof createCallTransport>, "configuration">
  private readonly mediaDevices: CallRoomEngineDependencies["mediaDevices"]
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private readonly initial: CallRoomSnapshot
  private snapshot: CallRoomSnapshot
  private disposed = false
  private generation = 0
  private joined = false
  private joining = false
  private cursor = 0
  private readonly peers = new Map<string, Peer>()
  private readonly seen = new Set<string>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  private leaseTimer: ReturnType<typeof setTimeout> | null = null
  private connectionPolicy: RTCIceTransportPolicy = "relay"
  private configuration: RTCConfiguration = { iceServers: [], iceTransportPolicy: "relay" }
  private configurationExpiresAt = 0
  private mediaGeneration = { audio: 0, video: 0 }
  private mediaQueue: Record<"audio" | "video", Promise<void>> = { audio: Promise.resolve(), video: Promise.resolve() }
  private readonly pendingCapture = new Set<MediaStream>()

  constructor(private readonly options: CallRoomEngineOptions, private readonly dependencies: CallRoomEngineDependencies = {}) {
    this.configurationTransport = dependencies.configurationTransport ?? createCallTransport(options.identity)
    this.mediaDevices = dependencies.mediaDevices ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined)
    this.now = dependencies.now ?? Date.now
    this.initial = {
      phase: "idle", target: null, targetLabel: "", roomId: null, mode: "audio", localStream: null,
      participants: [], microphoneMuted: false, cameraEnabled: false, devices: [], microphoneId: "", cameraId: "",
      joinedAt: null, error: null, notice: null, relayAvailable: false,
      settings: { silenceIncoming: false, relayOnly: true, ...options.settings },
      supported: Boolean(this.mediaDevices?.getUserMedia && (dependencies.createPeerConnection || typeof RTCPeerConnection !== "undefined")),
    }
    this.snapshot = this.initial
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide)
      window.addEventListener("serotine:identity-changing", this.onIdentityChange)
    }
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  getServerSnapshot = () => this.initial
  private update(patch: Partial<CallRoomSnapshot>) {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach(listener => listener())
  }
  private live(generation: number) { return !this.disposed && generation === this.generation }
  private peerLive(peer: Peer, generation: number) { return this.live(generation) && !peer.closed && this.peers.get(peer.member.publicKey) === peer }
  private onPageHide = () => { void this.leave() }
  private onIdentityChange = () => { this.dispose() }
  private currentTarget(): CallRoomTarget {
    const previous = this.snapshot.target
    const current = previous && this.options.getTarget(previous)
    if (!current || callRoomId(current) !== this.snapshot.roomId) throw new Error("You no longer have access to this call room.")
    const ownKey = this.options.identity.publicKey
    const allowed = this.allowedMember(current, ownKey)
    if (!allowed) throw new Error("You no longer have access to this call room.")
    return current
  }
  private allowedMember(target: CallRoomTarget, publicKey: string) {
    return target.kind === "group" ? target.group.members.includes(publicKey)
      : canJoinCommunityVoiceChannel(target.community, publicKey, target.channelId)
  }
  private schedule(generation: number) {
    if (!this.live(generation) || TERMINAL.has(this.snapshot.phase)) return
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => { this.pollTimer = null; void this.tick(generation) }, this.dependencies.pollIntervalMs ?? 1_200)
  }
  private async tick(generation = this.generation) {
    if (!this.live(generation) || TERMINAL.has(this.snapshot.phase)) return
    const transport = this.transport
    try {
      const target = this.currentTarget()
      if (this.options.isBusy?.()) throw new Error("This room call ended because another call is active.")
      if (this.joined && transport) {
        const response = await transport.poll(target, this.cursor)
        if (!this.live(generation) || transport !== this.transport) return
        // Re-check live local governance after the network wait, before adding any peer.
        this.currentTarget()
        this.cursor = response.nextCursor
        await this.reconcile(response.room, generation)
        if (!this.live(generation)) return
        await Promise.all(response.signals.map(signal => this.receive(signal, generation)))
      }
    } catch (error) {
      if (this.live(generation)) await this.finish("failed", message(error))
    } finally { this.schedule(generation) }
  }

  async prepare(target: CallRoomTarget, mode: CallMode) {
    if (this.disposed || !TERMINAL.has(this.snapshot.phase)) return
    if (!this.snapshot.supported || this.options.isBusy?.()) {
      this.update({ phase: "failed", error: !this.snapshot.supported ? "Calling needs a supported browser over HTTPS." : "Leave the current call before joining another one." }); return
    }
    this.cleanup()
    const generation = ++this.generation
    this.transport = this.dependencies.createTransport?.() ?? this.dependencies.transport ?? createCallRoomTransport(this.options.identity)
    this.cursor = 0
    this.seen.clear()
    this.joining = false
    this.joined = false
    this.connectionPolicy = this.snapshot.settings.relayOnly ? "relay" : "all"
    this.update({ phase: "preparing", target, targetLabel: label(target), roomId: callRoomId(target), mode: target.kind === "channel" ? "audio" : mode, localStream: null,
      participants: [], microphoneMuted: false, cameraEnabled: false, joinedAt: null, error: null, notice: null })
    this.deadline = setTimeout(() => { if (this.live(generation)) void this.finish("failed", "Call preparation timed out. Try again when you are ready.") }, this.dependencies.prepareTimeoutMs ?? 120_000)
    this.schedule(generation)
    await this.prepareMedia(generation)
  }
  async retryPreparation(allowDirect = false) {
    if (this.disposed || this.snapshot.phase !== "routing") return
    if (allowDirect) this.updateSettings({ relayOnly: false })
    this.connectionPolicy = this.snapshot.settings.relayOnly ? "relay" : "all"
    this.update({ phase: "preparing", error: null })
    await this.prepareMedia(this.generation)
  }
  private async prepareMedia(generation: number) {
    try {
      this.currentTarget()
      if (this.options.isBusy?.()) throw new Error("Leave the current call before joining another one.")
      await this.refreshConfiguration(generation)
      if (!this.live(generation)) return
      this.currentTarget()
      const audio = await this.mediaDevices!.getUserMedia({ audio: this.snapshot.microphoneId ? { deviceId: { exact: this.snapshot.microphoneId } } : true, video: false })
      if (!this.live(generation)) { stopStream(audio); return }
      if (!audio.getAudioTracks().length) { stopStream(audio); throw new Error("No microphone was available.") }
      this.update({ localStream: audio })
      this.currentTarget()
      this.watchTrack(audio.getAudioTracks()[0], generation)
      if (this.snapshot.mode === "video") {
        try { await this.replaceCapture("video", this.snapshot.cameraId) }
        catch (error) { if (this.live(generation)) this.update({ notice: `${captureMessage(error)} You can join with audio only.` }) }
      }
      if (!this.live(generation)) return
      this.currentTarget()
      await this.refreshDevices(generation)
      if (this.live(generation)) this.update({ phase: "preview" })
    } catch (error) {
      if (!this.live(generation)) return
      if (error instanceof CallTransportError && error.code === "relay-unavailable") this.update({ phase: "routing", relayAvailable: false, error: message(error) })
      else await this.finish("failed", captureMessage(error))
    }
  }
  async joinPreview() {
    const transport = this.transport
    if (this.disposed || this.snapshot.phase !== "preview" || this.joining || !transport) return
    const generation = this.generation
    const roomId = this.snapshot.roomId!
    this.joining = true
    try {
      this.currentTarget()
      if (this.options.isBusy?.()) throw new Error("Leave the current call before joining another one.")
      this.update({ phase: "joining" })
      if (this.configurationExpiresAt <= this.now() + 30_000) await this.refreshConfiguration(generation)
      if (!this.live(generation)) return
      const room = await transport.join(this.currentTarget(), this.snapshot.cameraEnabled ? "video" : "voice", this.connectionPolicy)
      if (!this.live(generation)) { await transport.leave(roomId).catch(() => {}); return }
      this.joined = true
      this.currentTarget()
      if (this.deadline) clearTimeout(this.deadline)
      this.deadline = null
      this.update({ phase: "joined", joinedAt: this.now() })
      await this.reconcile(room, generation)
      this.schedule(generation)
    } catch (error) { if (this.live(generation)) await this.finish("failed", message(error)) }
    finally { if (this.live(generation)) this.joining = false }
  }

  private async refreshConfiguration(generation: number) {
    const configuration = await this.configurationTransport.configuration(this.connectionPolicy)
    if (!this.live(generation)) return
    if (this.connectionPolicy === "relay" && !configuration.relayAvailable) throw new CallTransportError("Relay calling is not configured on this server. Enable direct connections in Call settings to continue; this shares your network address with other participants.", "relay-unavailable")
    this.configuration = { iceServers: configuration.iceServers, iceTransportPolicy: this.connectionPolicy, bundlePolicy: "max-bundle" }
    this.configurationExpiresAt = configuration.expiresAt
    this.update({ relayAvailable: configuration.relayAvailable })
  }
  private async reconcile(room: CallRoomState, generation: number) {
    if (!this.live(generation)) return
    if (room.roomId !== this.snapshot.roomId || room.participants.length > 8 || new Set(room.participants.map(member => member.publicKey)).size !== room.participants.length) throw new Error("The call room returned an invalid participant list.")
    const own = room.participants.find(member => member.publicKey === this.options.identity.publicKey)
    if (!own || own.sessionId !== this.transport!.sessionId || own.expiresAt <= this.now() || own.policy !== this.connectionPolicy) throw new Error("Your call session ended or was opened on another device. Join again to continue.")
    if (this.leaseTimer) clearTimeout(this.leaseTimer)
    this.leaseTimer = setTimeout(() => { if (this.live(generation)) void this.finish("failed", "Your call session expired. Join again to continue.") }, Math.max(0, own.expiresAt - this.now()))
    const target = this.currentTarget()
    const members = room.participants.filter(member => member.publicKey !== this.options.identity.publicKey && member.expiresAt > this.now() && this.allowedMember(target, member.publicKey))
    for (const [key, peer] of this.peers) {
      if (!members.some(member => member.publicKey === key && member.sessionId === peer.member.sessionId)) { this.closePeer(peer); this.peers.delete(key) }
    }
    if (members.some(member => member.policy !== this.connectionPolicy)) throw new Error("This call uses a different connection privacy setting. Leave and choose the matching setting before rejoining.")
    if (members.some(member => !this.peers.has(member.publicKey)) && this.configurationExpiresAt <= this.now() + 30_000) await this.refreshConfiguration(generation)
    if (!this.live(generation)) return
    const latest = this.currentTarget()
    for (const [key, peer] of this.peers) {
      if (!this.allowedMember(latest, key)) { this.closePeer(peer); this.peers.delete(key) }
    }
    const offers: Promise<void>[] = []
    for (const member of members) {
      if (!this.allowedMember(latest, member.publicKey)) continue
      const existing = this.peers.get(member.publicKey)
      if (existing) { existing.member = member; continue }
      const peer = this.createPeer(member, generation)
      if (this.isOfferer(peer)) offers.push(this.enqueue(peer, generation, () => this.offer(peer, generation)))
    }
    this.publishPeers()
    await Promise.all(offers)
  }
  private isOfferer(peer: Peer) { return this.options.identity.publicKey < peer.member.publicKey }
  private publishPeers() { this.update({ participants: [...this.peers.values()].map(peer => peer.snapshot) }) }
  private updatePeer(peer: Peer, patch: Partial<CallRoomParticipantSnapshot>) { peer.snapshot = { ...peer.snapshot, ...patch }; this.publishPeers() }
  private createPeer(member: Member, generation: number) {
    const pc = this.dependencies.createPeerConnection?.(this.configuration) ?? new RTCPeerConnection(this.configuration)
    const stream = this.snapshot.localStream!
    const peer: Peer = {
      member, pc, audioSender: pc.addTransceiver(stream.getAudioTracks()[0] ?? "audio", { direction: "sendrecv", streams: [stream] }).sender,
      videoSender: pc.addTransceiver(stream.getVideoTracks()[0] ?? "video", { direction: this.snapshot.target?.kind === "channel" ? "inactive" : "sendrecv", streams: [stream] }).sender,
      snapshot: { publicKey: member.publicKey, sessionId: member.sessionId, label: this.options.getPeerLabel?.(member.publicKey) || `${member.publicKey.slice(0, 10)}…`,
        phase: "connecting", stream: null, microphoneMuted: false, cameraEnabled: this.snapshot.target?.kind !== "channel" && member.mode === "video", error: null },
      queue: Promise.resolve(), pendingIce: [], fingerprint: null, deadline: null, restarted: false, closed: false,
    }
    this.peers.set(member.publicKey, peer)
    pc.onicecandidate = event => {
      if (event.candidate && this.peerLive(peer, generation)) void this.sendCandidate(peer, event.candidate.toJSON(), generation)
    }
    pc.ontrack = event => {
      if (!this.peerLive(peer, generation)) { event.track.stop(); return }
      if (this.snapshot.target?.kind === "channel" && event.track.kind === "video") { event.track.stop(); return }
      const remote = peer.snapshot.stream ?? this.newStream()
      if (!remote.getTracks().includes(event.track)) remote.addTrack(event.track)
      this.updatePeer(peer, { stream: remote })
    }
    pc.onconnectionstatechange = () => {
      if (!this.peerLive(peer, generation)) return
      if (pc.connectionState === "connected") {
        if (peer.deadline) clearTimeout(peer.deadline)
        peer.deadline = null
        this.updatePeer(peer, { phase: "connected", error: null })
        void this.send(peer, this.mediaState(), generation).catch(error => this.failPeer(peer, generation, message(error)))
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") this.reconnect(peer, generation)
      else if (pc.connectionState === "closed") this.failPeer(peer, generation, "This participant disconnected.")
    }
    this.peerDeadline(peer, generation, this.dependencies.connectTimeoutMs ?? 30_000)
    return peer
  }
  private peerDeadline(peer: Peer, generation: number, milliseconds: number) {
    if (peer.deadline) clearTimeout(peer.deadline)
    peer.deadline = setTimeout(() => this.failPeer(peer, generation, "Could not connect to this participant. A TURN relay may be needed for these networks."), milliseconds)
  }
  private async send(peer: Peer, payload: RoomPayload, generation: number) {
    if (!this.peerLive(peer, generation) || !this.joined || !this.transport || !this.snapshot.roomId) return
    await this.transport.send(this.snapshot.roomId, peer.member.publicKey, peer.member.sessionId, payload)
  }
  private async sendCandidate(peer: Peer, candidate: RTCIceCandidateInit, generation: number) {
    for (let attempt = 0; attempt < 3 && this.peerLive(peer, generation); attempt++) {
      try { await this.send(peer, { kind: "ice", candidate }, generation); return }
      catch (error) {
        if (attempt === 2) { this.failPeer(peer, generation, message(error)); return }
        await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
      }
    }
  }
  private enqueue(peer: Peer, generation: number, operation: () => Promise<void>) {
    const queued = peer.queue.then(async () => { if (this.peerLive(peer, generation)) await operation() })
    peer.queue = queued.catch(error => this.failPeer(peer, generation, message(error)))
    return peer.queue
  }
  private async offer(peer: Peer, generation: number, restart = false) {
    if (!this.peerLive(peer, generation) || !this.isOfferer(peer)) return
    const description = await peer.pc.createOffer({ iceRestart: restart })
    if (!this.peerLive(peer, generation)) return
    await peer.pc.setLocalDescription(description)
    if (this.peerLive(peer, generation)) await this.send(peer, { kind: "offer", description: { type: "offer", sdp: peer.pc.localDescription!.sdp } }, generation)
  }
  private async receive(signal: CallRoomSignal, generation: number) {
    if (!this.live(generation) || signal.roomId !== this.snapshot.roomId || signal.expiresAt <= this.now() || this.seen.has(signal.id)
      || signal.recipient !== this.options.identity.publicKey || signal.targetSession !== this.transport?.sessionId) return
    const peer = this.peers.get(signal.sender)
    if (!peer || peer.member.sessionId !== signal.senderSession || !this.peerLive(peer, generation)) return
    this.seen.add(signal.id)
    if (this.seen.size > 4_000) this.seen.delete(this.seen.values().next().value!)
    await this.enqueue(peer, generation, async () => {
      const payload = signal.payload
      if (payload.kind === "offer" || payload.kind === "answer") {
        // Exactly one side offers for the entire peer session, including ICE recovery.
        if (payload.kind === "offer" && this.isOfferer(peer) || payload.kind === "answer" && !this.isOfferer(peer)) return
        this.authenticateDescription(peer, payload.description.sdp ?? "")
        await peer.pc.setRemoteDescription(payload.description)
        if (!this.peerLive(peer, generation)) return
        for (const candidate of peer.pendingIce.splice(0)) {
          await peer.pc.addIceCandidate(candidate)
          if (!this.peerLive(peer, generation)) return
        }
        if (payload.kind === "offer") {
          if (this.configurationExpiresAt <= this.now() + 30_000) {
            await this.refreshConfiguration(generation)
            if (!this.peerLive(peer, generation)) return
            peer.pc.setConfiguration(this.configuration)
          }
          const description = await peer.pc.createAnswer()
          if (!this.peerLive(peer, generation)) return
          await peer.pc.setLocalDescription(description)
          if (this.peerLive(peer, generation)) await this.send(peer, { kind: "answer", description: { type: "answer", sdp: peer.pc.localDescription!.sdp } }, generation)
        }
      } else if (payload.kind === "ice") {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(payload.candidate)
        else if (peer.pendingIce.length < 128) peer.pendingIce.push(payload.candidate)
      } else if (payload.kind === "restart") {
        if (this.isOfferer(peer)) this.reconnect(peer, generation)
      } else if (payload.kind === "media-state") this.updatePeer(peer, { microphoneMuted: payload.muted, cameraEnabled: this.snapshot.target?.kind !== "channel" && payload.camera })
    })
  }
  private authenticateDescription(peer: Peer, sdp: string) {
    const fingerprints = [...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm)].map(match => match[1].toUpperCase())
    if (!fingerprints.length || fingerprints.some(value => !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value) || value !== fingerprints[0])) throw new Error("This participant's media identity could not be verified.")
    if (peer.fingerprint && peer.fingerprint !== fingerprints[0]) throw new Error("This participant's media identity changed. They need to rejoin the call.")
    peer.fingerprint = fingerprints[0]
  }
  private reconnect(peer: Peer, generation: number) {
    if (!this.peerLive(peer, generation) || peer.snapshot.phase === "reconnecting") return
    if (peer.restarted) { this.failPeer(peer, generation, "This participant's connection was interrupted again. They need to rejoin the call."); return }
    peer.restarted = true
    this.updatePeer(peer, { phase: "reconnecting" })
    this.peerDeadline(peer, generation, this.dependencies.reconnectTimeoutMs ?? 15_000)
    void this.enqueue(peer, generation, async () => {
      await this.refreshConfiguration(generation)
      if (!this.peerLive(peer, generation)) return
      peer.pc.setConfiguration(this.configuration)
      if (this.isOfferer(peer)) await this.offer(peer, generation, true)
      else await this.send(peer, { kind: "restart" }, generation)
    })
  }
  private failPeer(peer: Peer, generation: number, error: string) {
    if (!this.peerLive(peer, generation)) return
    this.closePeer(peer)
    this.updatePeer(peer, { phase: "failed", stream: null, cameraEnabled: false, error })
  }
  private closePeer(peer: Peer) {
    peer.closed = true
    if (peer.deadline) clearTimeout(peer.deadline)
    peer.deadline = null
    peer.pendingIce = []
    peer.pc.onicecandidate = null
    peer.pc.ontrack = null
    peer.pc.onconnectionstatechange = null
    peer.pc.close()
    stopStream(peer.snapshot.stream)
  }

  private newStream(tracks: MediaStreamTrack[] = []) { return this.dependencies.createMediaStream?.(tracks) ?? new MediaStream(tracks) }
  private queueMedia(kind: "audio" | "video", operation: () => Promise<void>) {
    const queued = this.mediaQueue[kind].then(operation, operation)
    this.mediaQueue[kind] = queued.catch(() => {})
    return queued
  }
  private watchTrack(track: MediaStreamTrack, generation: number) {
    track.onended = () => {
      if (!this.live(generation) || !this.snapshot.localStream?.getTracks().includes(track)) return
      this.update(track.kind === "audio" ? { microphoneMuted: true, notice: "The microphone stopped. Choose another microphone to continue." }
        : { cameraEnabled: false, notice: "The camera stopped. Your audio can continue." })
      void this.sendMediaState()
    }
  }
  private async replaceCapture(kind: "audio" | "video", deviceId: string, facingMode?: string) {
    if (!this.snapshot.localStream || TERMINAL.has(this.snapshot.phase)) return
    if (kind === "video" && this.snapshot.target?.kind === "channel") return
    const generation = this.generation
    const mediaGeneration = ++this.mediaGeneration[kind]
    const constraints: MediaTrackConstraints | boolean = deviceId ? { deviceId: { exact: deviceId } } : facingMode ? { facingMode: { ideal: facingMode } } : true
    const stream = await this.mediaDevices!.getUserMedia({ audio: kind === "audio" ? constraints : false, video: kind === "video" ? constraints : false })
    if (!this.live(generation) || mediaGeneration !== this.mediaGeneration[kind]) { stopStream(stream); return }
    try { this.currentTarget() } catch (error) { stopStream(stream); await this.finish("failed", message(error)); return }
    const replacement = stream.getTracks().find(track => track.kind === kind)
    if (!replacement) { stopStream(stream); throw new Error(`No ${kind === "audio" ? "microphone" : "camera"} was available.`) }
    this.pendingCapture.add(stream)
    try {
      await this.queueMedia(kind, async () => {
        if (!this.live(generation) || mediaGeneration !== this.mediaGeneration[kind]) { stopStream(stream); return }
        try { this.currentTarget() } catch (error) { stopStream(stream); await this.finish("failed", message(error)); return }
        if (kind === "audio") replacement.enabled = !this.snapshot.microphoneMuted
        const changed = new Set<Peer>()
        try {
          // Include peers that arrived while an earlier replaceTrack awaited the browser.
          while (this.live(generation) && [...this.peers.values()].some(peer => !peer.closed && !changed.has(peer))) {
            const batch = [...this.peers.values()].filter(peer => !peer.closed && !changed.has(peer))
            const results = await Promise.allSettled(batch.map(async peer => { changed.add(peer); await (kind === "audio" ? peer.audioSender : peer.videoSender).replaceTrack(replacement) }))
            const failed = results.find(result => result.status === "rejected")
            if (failed?.status === "rejected") throw failed.reason
          }
          if (!this.live(generation) || mediaGeneration !== this.mediaGeneration[kind]) throw new Error("Capture was replaced.")
        } catch (error) {
          if (this.live(generation)) {
            const intended = this.snapshot.localStream?.getTracks().find(track => track.kind === kind) ?? null
            await Promise.allSettled([...changed].filter(peer => !peer.closed).map(peer => (kind === "audio" ? peer.audioSender : peer.videoSender).replaceTrack(intended)))
          }
          stopStream(stream)
          if (this.live(generation) && mediaGeneration === this.mediaGeneration[kind]) throw error
          return
        }
        if (kind === "audio") replacement.enabled = !this.snapshot.microphoneMuted
        const previous = this.snapshot.localStream!
        const keep = previous.getTracks().filter(track => track.kind !== kind)
        previous.getTracks().filter(track => track.kind === kind).forEach(track => track.stop())
        stream.getTracks().filter(track => track !== replacement).forEach(track => track.stop())
        this.watchTrack(replacement, generation)
        const localStream = this.newStream([...keep, replacement])
        this.update(kind === "audio" ? { localStream, microphoneId: replacement.getSettings().deviceId || deviceId, notice: null }
          : { localStream, cameraEnabled: true, cameraId: replacement.getSettings().deviceId || deviceId, mode: "video", notice: null })
      })
    } finally { this.pendingCapture.delete(stream) }
    await this.refreshDevices(generation)
    if (this.live(generation)) void this.sendMediaState()
  }
  toggleMicrophone() {
    if (!this.snapshot.localStream || TERMINAL.has(this.snapshot.phase)) return
    const microphoneMuted = !this.snapshot.microphoneMuted
    this.snapshot.localStream.getAudioTracks().forEach(track => { track.enabled = !microphoneMuted })
    this.update({ microphoneMuted })
    void this.sendMediaState()
  }
  async toggleCamera() {
    if (!this.snapshot.localStream || TERMINAL.has(this.snapshot.phase)) return
    const generation = this.generation
    if (this.snapshot.cameraEnabled) {
      this.mediaGeneration.video++
      const stream = this.snapshot.localStream
      stream.getVideoTracks().forEach(track => { track.stop(); stream.removeTrack(track) })
      this.update({ cameraEnabled: false, localStream: this.newStream(stream.getTracks()) })
      await this.queueMedia("video", async () => {
        if (!this.live(generation) || this.snapshot.cameraEnabled) return
        await Promise.allSettled([...this.peers.values()].filter(peer => !peer.closed).map(peer => peer.videoSender.replaceTrack(null)))
      })
      if (this.live(generation)) void this.sendMediaState()
    } else {
      try { await this.replaceCapture("video", this.snapshot.cameraId) }
      catch (error) { if (this.live(generation)) this.update({ notice: `${captureMessage(error)} Your audio can continue.` }) }
    }
  }
  async selectMicrophone(deviceId: string) {
    const generation = this.generation
    try { await this.replaceCapture("audio", deviceId) }
    catch (error) { if (this.live(generation)) this.update({ notice: captureMessage(error) }) }
  }
  async selectCamera(deviceId: string) {
    this.update({ cameraId: deviceId })
    if (!this.snapshot.cameraEnabled) return
    const generation = this.generation
    try { await this.replaceCapture("video", deviceId) }
    catch (error) { if (this.live(generation)) this.update({ notice: `${captureMessage(error)} Your audio can continue.` }) }
  }
  async switchCamera() {
    if (!this.snapshot.localStream || !this.snapshot.cameraEnabled) return
    const cameras = this.snapshot.devices.filter(device => device.kind === "videoinput")
    const current = this.snapshot.localStream.getVideoTracks()[0]?.getSettings()
    if (cameras.length > 1) {
      const index = cameras.findIndex(camera => camera.deviceId === (current?.deviceId || this.snapshot.cameraId))
      await this.selectCamera(cameras[(index + 1) % cameras.length].deviceId)
    } else {
      const generation = this.generation
      try { await this.replaceCapture("video", "", current?.facingMode === "environment" ? "user" : "environment") }
      catch (error) { if (this.live(generation)) this.update({ notice: `${captureMessage(error)} Your audio can continue.` }) }
    }
  }
  private async refreshDevices(generation: number) {
    try {
      const devices = await this.mediaDevices!.enumerateDevices()
      if (this.live(generation)) this.update({ devices: devices.filter(device => ["audioinput", "videoinput"].includes(device.kind)) })
    } catch { /* Capture remains usable when enumeration is restricted. */ }
  }
  private mediaState(): RoomPayload { return { kind: "media-state", muted: this.snapshot.microphoneMuted, camera: this.snapshot.cameraEnabled, private: true } }
  private async sendMediaState() {
    const generation = this.generation
    if (!this.joined) return
    await Promise.all([...this.peers.values()].map(peer => this.send(peer, this.mediaState(), generation).catch(error => this.failPeer(peer, generation, message(error)))))
  }
  updateSettings(settings: Partial<CallSettings>) {
    const next = { ...this.snapshot.settings, ...settings }
    this.update({ settings: next })
    this.options.onSettingsChange?.(next)
    if (next.relayOnly && this.connectionPolicy === "all" && !TERMINAL.has(this.snapshot.phase)) void this.finish("ended", "Rejoin the call to use relay-only connections.")
  }
  async leave() { await this.finish("ended") }
  dismiss() {
    if (!TERMINAL.has(this.snapshot.phase)) return
    this.update({ phase: "idle", target: null, targetLabel: "", roomId: null, error: null, notice: null })
  }
  private async finish(phase: "ended" | "failed", error?: string) {
    if (TERMINAL.has(this.snapshot.phase)) return
    const transport = this.transport
    const roomId = this.snapshot.roomId
    const notify = this.joined || this.joining
    this.generation++
    this.cleanup()
    this.joined = false
    this.joining = false
    this.transport = null
    this.update({ phase, error: error ?? null, localStream: null, participants: [], cameraEnabled: false })
    if (notify && transport && roomId) await transport.leave(roomId).catch(() => {})
  }
  private cleanup() {
    for (const timer of [this.pollTimer, this.deadline, this.leaseTimer]) if (timer) clearTimeout(timer)
    this.pollTimer = null; this.deadline = null; this.leaseTimer = null
    this.mediaGeneration.audio++; this.mediaGeneration.video++
    this.mediaQueue = { audio: Promise.resolve(), video: Promise.resolve() }
    this.pendingCapture.forEach(stopStream); this.pendingCapture.clear()
    this.peers.forEach(peer => this.closePeer(peer)); this.peers.clear()
    stopStream(this.snapshot.localStream)
  }
  dispose() {
    if (this.disposed) return
    void this.leave()
    this.disposed = true
    this.generation++
    this.cleanup()
    this.listeners.clear()
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide)
      window.removeEventListener("serotine:identity-changing", this.onIdentityChange)
    }
  }
}
