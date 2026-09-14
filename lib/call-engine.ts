import { CallTransportError, createCallTransport } from "./call-transport"
import type { CallSession, CallSignal, CallSignalPayload } from "./call-protocol"
import { loadContacts, shortAddress } from "./identity"
import type { CallController, CallEngineOptions, CallMode, CallPhase, CallSettings, CallSnapshot, CompletedCall } from "./call-types"

type Transport = ReturnType<typeof createCallTransport>
export interface CallEngineDependencies {
  transport?: Transport
  mediaDevices?: Pick<MediaDevices, "getUserMedia" | "enumerateDevices">
  createPeerConnection?: (configuration: RTCConfiguration) => RTCPeerConnection
  createMediaStream?: (tracks?: MediaStreamTrack[]) => MediaStream
  contacts?: () => string[]
  now?: () => number
  pollIntervalMs?: number
  prepareTimeoutMs?: number
  connectTimeoutMs?: number
  reconnectTimeoutMs?: number
  signalRetryDelayMs?: number
}

const FINAL_PHASES = new Set<CallPhase>(["idle", "ended", "declined", "unanswered", "busy", "failed"])
const stopStream = (stream: MediaStream | null) => stream?.getTracks().forEach(track => track.stop())
const descriptionError = (error: unknown) => error instanceof Error ? error.message : "Calling is temporarily unavailable. Try again."
const mediaError = (error: unknown) => error instanceof Error && /NotAllowed|Permission|Security/i.test(`${error.name} ${error.message}`)
  ? "Microphone or camera access was denied. Allow access in your browser's site settings, then try again."
  : error instanceof Error && /NotFound|NotReadable|Overconstrained/i.test(`${error.name} ${error.message}`)
    ? "That microphone or camera is unavailable. Check the device or choose another one."
    : descriptionError(error)
const wireMode = (mode: CallMode) => mode === "audio" ? "voice" as const : "video" as const
const uiMode = (mode: string) => mode === "video" ? "video" as const : "audio" as const

/** Owns capture, one peer connection, and ephemeral signaling for one identity. */
export class CallEngine implements CallController {
  private readonly transport: Transport
  private readonly mediaDevices: CallEngineDependencies["mediaDevices"]
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private readonly initial: CallSnapshot
  private snapshot: CallSnapshot
  private disposed = false
  private running = false
  private generation = 0
  private mediaGeneration = { audio: 0, video: 0 }
  private mediaQueue: Record<"audio" | "video", Promise<void>> = { audio: Promise.resolve(), video: Promise.resolve() }
  private pendingCapture = new Set<MediaStream>()
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private deadline: ReturnType<typeof setTimeout> | null = null
  private heartbeatAt = 0
  private cursor = 0
  private session: CallSession | null = null
  private sessions = new Map<string, CallSession>()
  private peerSession: string | null = null
  private pc: RTCPeerConnection | null = null
  private audioSender: RTCRtpSender | null = null
  private videoSender: RTCRtpSender | null = null
  private pendingIce: RTCIceCandidateInit[] = []
  private seen = new Set<string>()
  private startedAt = 0
  private privateCall = false
  private published = false
  private accepted = false
  private recorded = false
  private recentCompleted = new Map<string, CompletedCall>()
  private connectionPolicy: RTCIceTransportPolicy = "relay"
  private configuration: RTCConfiguration = { iceServers: [], iceTransportPolicy: "relay" }
  private remoteFingerprint: string | null = null
  private reconnectAttempted = false
  private connectingPreview = false
  private localCandidateCount = 0
  private remoteCandidateCount = 0
  private iceServerFailed = false

  constructor(private readonly options: CallEngineOptions, private readonly dependencies: CallEngineDependencies = {}) {
    this.transport = dependencies.transport ?? createCallTransport(options.identity)
    this.mediaDevices = dependencies.mediaDevices ?? (typeof navigator !== "undefined" ? navigator.mediaDevices : undefined)
    this.now = dependencies.now ?? Date.now
    this.initial = {
      phase: "idle", callId: null, peer: null, peerLabel: "", direction: null, mode: "audio",
      microphoneMuted: false, cameraEnabled: false, remoteMicrophoneMuted: false, remoteCameraEnabled: false,
      localStream: null, remoteStream: null, connectedAt: null, error: null, notice: null,
      devices: [], microphoneId: "", cameraId: "", settings: { silenceIncoming: false, relayOnly: true, ...options.settings },
      relayAvailable: false, relayRequiredByPeer: false, supported: Boolean(this.mediaDevices?.getUserMedia && (dependencies.createPeerConnection || typeof RTCPeerConnection !== "undefined")),
    }
    this.snapshot = this.initial
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  getServerSnapshot = () => this.initial
  private update(patch: Partial<CallSnapshot>) {
    if (this.disposed) return
    this.snapshot = { ...this.snapshot, ...patch }
    this.listeners.forEach(listener => listener())
  }
  private live(generation: number) { return !this.disposed && generation === this.generation }
  private eligible(peer: string, incoming = false) {
    const policy = this.options.getPeerPolicy(peer)
    return peer !== this.options.identity.publicKey && policy.accepted && !policy.blocked
      && (!incoming || (!this.snapshot.settings.silenceIncoming && !policy.archived && !policy.muted))
  }
  private contacts() {
    const peers = this.options.getPeers?.() ?? this.dependencies.contacts?.() ?? loadContacts(this.options.identity.publicKey).map(contact => contact.pub)
    return peers.filter(peer => this.eligible(peer))
  }
  private timer(milliseconds: number, phase: "unanswered" | "failed", message?: string | (() => string)) {
    if (this.deadline) clearTimeout(this.deadline)
    const generation = this.generation
    this.deadline = setTimeout(() => {
      if (this.live(generation)) void this.finish(phase, typeof message === "function" ? message() : message)
    }, Math.max(0, milliseconds))
  }

  async start() {
    if (this.running || this.disposed) return
    this.running = true
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", this.onPageHide)
      window.addEventListener("serotine:identity-changing", this.onIdentityChange)
    }
    if (!this.snapshot.supported) return
    try {
      const configuration = await this.transport.configuration("relay")
      this.update({ relayAvailable: configuration.relayAvailable })
    } catch { /* Preflight reports configuration errors with a retry action. */ }
    if (!this.disposed) await this.tick()
  }
  private onPageHide = () => { void this.end() }
  private onIdentityChange = () => { this.dispose() }

  private async tick() {
    if (this.disposed || !this.running) return
    try {
      const peer = this.snapshot.peer
      if (peer && !FINAL_PHASES.has(this.snapshot.phase)) {
        if (!this.privateCall && this.options.getPeerPolicy(peer).private) { this.privateCall = true; await this.sendMediaState() }
        const awaitingIncomingConsent = this.snapshot.direction === "incoming" && ["incoming", "routing", "preparing", "preview"].includes(this.snapshot.phase)
        if (!this.eligible(peer, awaitingIncomingConsent)) await this.finish("ended", "Calling stopped because this contact is no longer available.")
      }
      if (this.now() - this.heartbeatAt >= 8_000 || !this.heartbeatAt) {
        const peers = this.contacts()
        await this.transport.heartbeat(peers, peers.filter(peer => this.eligible(peer, true)))
        this.heartbeatAt = this.now()
      }
      const response = await this.transport.poll(this.cursor)
      if (this.disposed) return
      this.cursor = response.nextCursor
      this.sessions = new Map(response.sessions.map(session => [session.callId, session]))
      for (const session of response.sessions) {
        const completed = this.recentCompleted.get(session.callId)
        if (session.noHistory && completed && !completed.private) {
          try { await this.options.onCompleted?.({ ...completed, private: true }); this.recentCompleted.delete(session.callId) } catch { /* Retry on a later poll. */ }
        }
      }
      // The server selects the winning session before any media is negotiated.
      if (this.session && !FINAL_PHASES.has(this.snapshot.phase)) {
        const active = response.sessions.find(item => item.callId === this.session!.callId)
        if (active) {
          this.session = active
          this.privateCall ||= active.noHistory
          if (active.status !== "ended" && this.snapshot.direction === "incoming" && active.recipientSession && active.recipientSession !== this.transport.sessionId) {
            await this.finish("ended", "This call was answered on another device.", false, false)
          }
        }
      }
      for (const signal of response.signals) await this.receive(signal)
      if (this.session?.status === "ended" && !FINAL_PHASES.has(this.snapshot.phase)) await this.finish(this.terminalReason(this.session.reason), undefined, false)
    } catch {
      // The call's invitation/connect/reconnect deadline always bounds failures.
      if (this.pc && this.snapshot.phase === "connected") this.beginReconnect()
    } finally {
      if (!this.disposed && this.running) this.pollTimer = setTimeout(() => { void this.tick() }, this.dependencies.pollIntervalMs ?? 1_200)
    }
  }

  async availability(peer: string) {
    if (!this.snapshot.supported || !this.eligible(peer) || this.disposed) return "unavailable" as const
    try { return (await this.transport.capability(peer)).available ? "available" as const : "unavailable" as const }
    catch { return "unavailable" as const }
  }

  private reset(peer: string, mode: CallMode, direction: "incoming" | "outgoing", callId: string) {
    this.cleanup()
    this.generation++
    this.startedAt = this.now()
    this.privateCall = Boolean(this.options.getPeerPolicy(peer).private)
    this.published = false
    this.accepted = false
    this.recorded = false
    this.peerSession = null
    this.session = null
    this.remoteFingerprint = null
    this.reconnectAttempted = false
    this.connectingPreview = false
    this.localCandidateCount = 0
    this.remoteCandidateCount = 0
    this.iceServerFailed = false
    this.update({ phase: direction === "incoming" ? "incoming" : "preparing", callId, peer, direction, mode,
      peerLabel: this.options.getPeerPolicy(peer).label || shortAddress(peer), microphoneMuted: false, cameraEnabled: false,
      remoteMicrophoneMuted: false, remoteCameraEnabled: mode === "video", localStream: null, remoteStream: null,
      connectedAt: null, error: null, notice: null, relayRequiredByPeer: false })
  }

  async prepareOutgoing(peer: string, mode: CallMode) {
    if (this.disposed || !FINAL_PHASES.has(this.snapshot.phase)) return
    if (this.options.isBusy?.()) { this.update({ phase: "failed", error: "Leave your current group call or voice channel before starting another call." }); return }
    if (!this.snapshot.supported || !this.eligible(peer)) {
      this.update({ phase: "failed", error: "Calling is available only for accepted contacts in a supported browser over HTTPS." }); return
    }
    this.reset(peer, mode, "outgoing", crypto.randomUUID())
    const generation = this.generation
    this.timer(this.dependencies.prepareTimeoutMs ?? 120_000, "failed", "Call preparation timed out. Try again when you are ready.")
    try {
      const capability = await this.transport.capability(peer)
      if (!this.live(generation)) return
      if (!capability.available) throw new Error("Calling is unavailable or unconfirmed. Your contact needs Serotine open in a current browser.")
      if (capability.busy) { await this.finish("busy"); return }
      await this.prepareMedia(mode, generation)
    } catch (error) { await this.preparationFailed(error, generation) }
  }

  async prepareIncoming(mode: CallMode) {
    if (this.disposed || !["incoming", "preview"].includes(this.snapshot.phase) || this.snapshot.direction !== "incoming" || !this.snapshot.peer) return
    if (!this.eligible(this.snapshot.peer, true)) { await this.decline(); return }
    if (this.options.isBusy?.()) { await this.finish("busy", "Leave your current group call or voice channel before answering another call."); return }
    if (mode === "video" && this.snapshot.mode !== "video") return
    const generation = this.generation
    this.update({ phase: "preparing", mode, error: null })
    try { await this.prepareMedia(mode, generation) }
    catch (error) { await this.preparationFailed(error, generation) }
  }

  private async preparationFailed(error: unknown, generation: number) {
    if (!this.live(generation)) return
    if (error instanceof CallTransportError && error.code === "relay-unavailable") {
      this.update({ phase: "routing", relayAvailable: false, error: descriptionError(error) })
    } else await this.finish("failed", mediaError(error))
  }

  async retryPreparation(allowDirect = false) {
    if (this.disposed || this.snapshot.phase !== "routing" || !this.snapshot.peer || this.options.isBusy?.()) return
    if (!this.eligible(this.snapshot.peer, this.snapshot.direction === "incoming")) { await this.finish("ended"); return }
    if (allowDirect) {
      if (this.snapshot.relayRequiredByPeer) return
      this.updateSettings({ relayOnly: false })
    }
    const generation = this.generation
    this.update({ phase: "preparing", error: null })
    try { await this.prepareMedia(this.snapshot.mode, generation) }
    catch (error) { await this.preparationFailed(error, generation) }
  }

  private async prepareMedia(mode: CallMode, generation: number) {
    const requestedPolicy = this.snapshot.settings.relayOnly || this.connectionPolicy === "relay" && this.snapshot.direction === "incoming" ? "relay" : "all"
    const configuration = await this.transport.configuration(requestedPolicy)
    if (!this.live(generation)) return
    this.update({ relayAvailable: configuration.relayAvailable })
    if (requestedPolicy === "relay" && !configuration.relayAvailable) throw new CallTransportError("Relay-only calling needs a configured TURN relay. You can explicitly allow a direct connection, but some networks require a relay.", "relay-unavailable")
    this.connectionPolicy = requestedPolicy
    this.configuration = { iceServers: configuration.iceServers, iceTransportPolicy: requestedPolicy, bundlePolicy: "max-bundle" }
    const audio = await this.mediaDevices!.getUserMedia({ audio: this.snapshot.microphoneId ? { deviceId: { exact: this.snapshot.microphoneId } } : true, video: false })
    if (!this.live(generation)) { stopStream(audio); return }
    stopStream(this.snapshot.localStream)
    this.update({ localStream: audio, mode, cameraEnabled: false })
    audio.getAudioTracks().forEach(track => {
      track.enabled = !this.snapshot.microphoneMuted
      track.onended = () => {
        if (!this.live(generation) || !this.snapshot.localStream?.getTracks().includes(track)) return
        this.update({ microphoneMuted: true, notice: "The microphone stopped. Choose another microphone to continue." })
        void this.sendMediaState()
      }
    })
    if (mode === "video") {
      try { await this.replaceCapture("video", this.snapshot.cameraId) }
      catch (error) { if (this.live(generation)) this.update({ notice: `${mediaError(error)} You can continue with audio only.`, cameraEnabled: false }) }
    }
    if (!this.live(generation)) return
    await this.refreshDevices()
    if (this.live(generation)) this.update({ phase: "preview" })
  }

  async connectPreview() {
    if (this.disposed || this.snapshot.phase !== "preview" || this.connectingPreview || !this.snapshot.peer || !this.snapshot.callId) return
    const generation = this.generation
    const peer = this.snapshot.peer
    const callId = this.snapshot.callId
    if (!this.eligible(peer, this.snapshot.direction === "incoming")) { await this.finish("ended"); return }
    this.privateCall ||= Boolean(this.options.getPeerPolicy(peer).private)
    this.connectingPreview = true
    try {
      if (this.snapshot.direction === "outgoing") {
        this.update({ phase: "ringing" })
        const session = await this.transport.invite(peer, callId, { kind: "invite", mode: wireMode(this.snapshot.mode), policy: this.connectionPolicy, private: this.privateCall })
        if (!this.live(generation)) { await this.transport.finish(callId, "cancelled").catch(() => {}); return }
        // Polling may have already delivered the recipient's acceptance while
        // this HTTP response was in flight. Preserve that newer session and timer.
        this.session ??= session
        this.privateCall ||= session.noHistory
        this.published = true
        if (!this.accepted) this.timer(session.inviteExpiresAt - this.now(), "unanswered")
      } else {
        const session = await this.transport.claim(callId, this.privateCall)
        if (!this.live(generation)) { await this.transport.finish(callId, "cancelled").catch(() => {}); return }
        if (session.recipientSession !== this.transport.sessionId) { await this.finish("ended", "This call was answered on another device.", false, false); return }
        this.session = session
        this.privateCall ||= session.noHistory
        this.peerSession = session.callerSession
        this.accepted = true
        this.update({ phase: "connecting" })
        this.createConnection()
        await this.send({ kind: "accept", mode: wireMode(this.snapshot.mode), private: this.privateCall })
        if (this.live(generation)) this.timer(this.dependencies.connectTimeoutMs ?? 30_000, "failed", () => this.connectionFailure())
      }
    } catch (error) { if (this.live(generation)) await this.finish(/busy|claimed|another/i.test(descriptionError(error)) ? "busy" : "failed", descriptionError(error)) }
    finally { this.connectingPreview = false }
  }

  private async send(payload: Exclude<CallSignalPayload, { kind: "invite" }>) {
    if (!this.snapshot.callId || !this.snapshot.peer || !this.peerSession || this.disposed) return
    await this.transport.send(this.snapshot.callId, this.snapshot.peer, this.peerSession, payload)
  }

  private async receive(signal: CallSignal) {
    if (this.disposed || this.seen.has(signal.id) || signal.expiresAt <= this.now()) return
    this.seen.add(signal.id)
    if (this.seen.size > 2_000) this.seen.delete(this.seen.values().next().value!)
    const payload = signal.payload
    if (payload.kind === "invite") {
      if (!this.eligible(signal.sender, true) || this.options.isBusy?.()) return
      const session = this.sessions.get(signal.callId)
      if (!session || session.status !== "ringing" || session.caller !== signal.sender || session.recipient !== this.options.identity.publicKey
        || session.callerSession !== signal.senderSession || session.inviteExpiresAt <= this.now()) return
      // The relay has already atomically reserved this identity for the incoming
      // call. Let that winner replace an unpublished local setup, including an
      // outgoing invite request that is about to lose the same reservation.
      if (!FINAL_PHASES.has(this.snapshot.phase) && !(this.snapshot.direction === "outgoing" && !this.published && !this.accepted)) return
      this.reset(signal.sender, uiMode(payload.mode), "incoming", signal.callId)
      this.privateCall ||= Boolean(payload.private) || session.noHistory
      this.connectionPolicy = payload.policy
      this.update({ relayRequiredByPeer: payload.policy === "relay" })
      this.peerSession = signal.senderSession
      this.published = true
      this.session = session
      this.timer(session.inviteExpiresAt - this.now(), "unanswered")
      return
    }
    if (FINAL_PHASES.has(this.snapshot.phase) || signal.callId !== this.snapshot.callId || signal.sender !== this.snapshot.peer
      || !this.eligible(signal.sender) || signal.targetSession !== this.transport.sessionId) return
    if (payload.kind === "accept") {
      if (this.snapshot.direction !== "outgoing" || this.snapshot.phase !== "ringing") return
      const session = this.session ?? this.sessions.get(signal.callId)
      // A valid acceptance is bound to the session atomically selected by the relay.
      // The poll can arrive before our invite request returns; it still carries
      // authenticated server state and must not lose that early acceptance.
      if (!session || session.status !== "active" || session.caller !== this.options.identity.publicKey
        || session.recipient !== signal.sender || session.callerSession !== this.transport.sessionId
        || signal.senderSession !== session.recipientSession) return
      this.session = session
      this.published = true
      this.privateCall ||= session.noHistory
      this.peerSession = signal.senderSession
      this.privateCall ||= Boolean(payload.private)
      this.accepted = true
      this.update({ phase: "connecting", remoteCameraEnabled: payload.mode === "video" })
      this.createConnection()
      this.timer(this.dependencies.connectTimeoutMs ?? 30_000, "failed", () => this.connectionFailure())
      await this.offer()
      return
    }
    if (!this.accepted || signal.senderSession !== this.peerSession || !this.pc) return
    const generation = this.generation
    try {
      if (payload.kind === "offer" || payload.kind === "answer") {
        if (payload.kind === "offer" && this.snapshot.direction !== "incoming" || payload.kind === "answer" && this.snapshot.direction !== "outgoing") return
        this.authenticateDescription(payload.description.sdp || "")
        const pc = this.pc
        await pc.setRemoteDescription(payload.description)
        if (!this.live(generation)) return
        for (const candidate of this.pendingIce.splice(0)) await pc.addIceCandidate(candidate)
        if (payload.kind === "offer") {
          await pc.setLocalDescription(await pc.createAnswer())
          if (this.live(generation)) await this.send({ kind: "answer", description: { type: "answer", sdp: pc.localDescription!.sdp } })
        }
      } else if (payload.kind === "ice") {
        this.remoteCandidateCount++
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(payload.candidate)
        else if (this.pendingIce.length < 128) this.pendingIce.push(payload.candidate)
      } else if (payload.kind === "restart") {
        if (this.snapshot.direction === "outgoing") this.beginReconnect()
      } else if (payload.kind === "media-state") {
        this.privateCall ||= Boolean(payload.private)
        this.update({ remoteMicrophoneMuted: payload.muted, remoteCameraEnabled: payload.camera })
      }
    } catch (error) { if (this.live(generation)) await this.finish("failed", descriptionError(error)) }
  }

  private authenticateDescription(sdp: string) {
    // The encrypted, signed signaling envelope authenticates this DTLS fingerprint.
    // Keep it pinned through ICE restarts rather than accepting a different media identity.
    const fingerprints = [...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm)].map(match => match[1].toUpperCase())
    if (!fingerprints.length || fingerprints.some(value => !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value) || value !== fingerprints[0])) throw new Error("The call's media identity could not be verified.")
    if (this.remoteFingerprint && this.remoteFingerprint !== fingerprints[0]) throw new Error("The call's media identity changed. Start a new call.")
    this.remoteFingerprint = fingerprints[0]
  }

  private createConnection() {
    if (!this.accepted || this.pc || this.disposed || FINAL_PHASES.has(this.snapshot.phase)) return
    const generation = this.generation
    const pc = this.dependencies.createPeerConnection?.(this.configuration) ?? new RTCPeerConnection(this.configuration)
    this.pc = pc
    const stream = this.snapshot.localStream!
    this.audioSender = pc.addTransceiver(stream.getAudioTracks()[0] ?? "audio", { direction: "sendrecv", streams: [stream] }).sender
    // Reserve video up front; explicit camera toggles can replace the track without renegotiating.
    this.videoSender = pc.addTransceiver(stream.getVideoTracks()[0] ?? "video", { direction: "sendrecv", streams: [stream] }).sender
    pc.onicecandidate = event => {
      if (event.candidate && this.live(generation)) {
        this.localCandidateCount++
        void this.sendCandidate(event.candidate.toJSON(), generation)
      }
    }
    pc.onicecandidateerror = () => { if (this.live(generation)) this.iceServerFailed = true }
    pc.ontrack = event => {
      if (!this.live(generation)) { event.track.stop(); return }
      const remote = this.snapshot.remoteStream ?? this.newStream()
      if (!remote.getTracks().includes(event.track)) remote.addTrack(event.track)
      this.update({ remoteStream: remote })
    }
    pc.onconnectionstatechange = () => {
      if (!this.live(generation)) return
      if (pc.connectionState === "connected") {
        if (this.deadline) clearTimeout(this.deadline)
        this.deadline = null
        this.update({ phase: "connected", connectedAt: this.snapshot.connectedAt ?? this.now(), error: null })
        void this.sendMediaState()
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") this.beginReconnect()
      else if (pc.connectionState === "closed") void this.finish("ended")
    }
  }

  private connectionFailure() {
    if (this.connectionPolicy === "relay") return this.iceServerFailed || !this.localCandidateCount
      ? "The calling relay could not be reached. Try another network, or ask the site owner to check the TURN relay. Your network address was not shared directly."
      : "The relay connection could not reach your contact. Keep both pages open and try again; the site owner may need to check the TURN relay."
    if (!this.snapshot.relayAvailable) return "A direct connection could not be established between these networks. Try another network, or ask the site owner to enable a TURN relay for reliable calling."
    if (!this.localCandidateCount || !this.remoteCandidateCount) return "The browser could not exchange a usable calling connection. Keep both pages open, check network access, and retry."
    return "The call could not connect through this network. Try another network or retry with relay-only enabled in Call settings."
  }

  private async sendCandidate(candidate: RTCIceCandidateInit, generation: number) {
    // A temporary signaling failure must not permanently lose the only route.
    // Bound retries to this call; never send a stale candidate to a later peer.
    for (let attempt = 0; attempt < 3 && this.live(generation); attempt++) {
      try { await this.send({ kind: "ice", candidate }); return }
      catch {
        if (attempt === 2) {
          if (this.live(generation)) this.update({ notice: "Connection details could not be sent. Check your connection while Serotine retries the call." })
          return
        }
        await new Promise(resolve => setTimeout(resolve, (this.dependencies.signalRetryDelayMs ?? 400) * (attempt + 1)))
      }
    }
  }

  private async offer(restart = false) {
    const pc = this.pc
    const generation = this.generation
    if (!pc || this.snapshot.direction !== "outgoing") return
    try {
      await pc.setLocalDescription(await pc.createOffer({ iceRestart: restart }))
      if (this.live(generation)) await this.send({ kind: "offer", description: { type: "offer", sdp: pc.localDescription!.sdp } })
    } catch (error) { if (this.live(generation)) await this.finish("failed", descriptionError(error)) }
  }
  private beginReconnect() {
    if (!this.pc || this.disposed || FINAL_PHASES.has(this.snapshot.phase) || this.snapshot.phase === "reconnecting") return
    if (this.reconnectAttempted) { void this.finish("failed", "The connection was interrupted again. Ended the call; you can try a new call."); return }
    this.reconnectAttempted = true
    this.update({ phase: "reconnecting" })
    this.timer(this.dependencies.reconnectTimeoutMs ?? 15_000, "failed", () => this.connectionFailure())
    void this.refreshConnection()
  }
  private async refreshConnection() {
    const generation = this.generation
    const pc = this.pc
    if (!pc) return
    try {
      // Long calls can outlive the original short-lived TURN credentials.
      // Refresh only the already-selected routing policy; never fall back.
      const configuration = await this.transport.configuration(this.connectionPolicy)
      if (!this.live(generation) || pc !== this.pc) return
      if (this.connectionPolicy === "relay" && !configuration.relayAvailable) throw new Error("The relay is unavailable. No direct connection was attempted.")
      this.configuration = { ...this.configuration, iceServers: configuration.iceServers }
      pc.setConfiguration(this.configuration)
      if (this.snapshot.direction === "outgoing") await this.offer(true)
      else await this.send({ kind: "restart" })
    } catch (error) { if (this.live(generation)) await this.finish("failed", descriptionError(error)) }
  }

  toggleMicrophone() {
    if (!this.snapshot.localStream || FINAL_PHASES.has(this.snapshot.phase)) return
    const microphoneMuted = !this.snapshot.microphoneMuted
    this.snapshot.localStream.getAudioTracks().forEach(track => { track.enabled = !microphoneMuted })
    this.update({ microphoneMuted })
    void this.sendMediaState()
  }
  async toggleCamera() {
    if (!this.snapshot.localStream || FINAL_PHASES.has(this.snapshot.phase)) return
    if (this.snapshot.cameraEnabled) {
      this.mediaGeneration.video++
      const generation = this.generation
      const stream = this.snapshot.localStream
      const tracks = stream.getVideoTracks()
      tracks.forEach(track => { track.stop(); stream.removeTrack(track) })
      this.update({ cameraEnabled: false, localStream: this.newStream(stream.getTracks()) })
      await this.queueMedia("video", async () => {
        if (this.live(generation) && !this.snapshot.cameraEnabled) await this.videoSender?.replaceTrack(null).catch(() => {})
      })
      void this.sendMediaState()
    } else {
      try { await this.replaceCapture("video", this.snapshot.cameraId) }
      catch (error) { this.update({ notice: `${mediaError(error)} Your audio can continue.` }) }
    }
  }
  async selectMicrophone(deviceId: string) {
    try { await this.replaceCapture("audio", deviceId) }
    catch (error) { this.update({ notice: mediaError(error) }) }
  }
  async selectCamera(deviceId: string) {
    this.update({ cameraId: deviceId })
    if (!this.snapshot.cameraEnabled) return
    try { await this.replaceCapture("video", deviceId) }
    catch (error) { this.update({ notice: `${mediaError(error)} Your audio can continue.` }) }
  }
  async switchCamera() {
    if (!this.snapshot.localStream || !this.snapshot.cameraEnabled) return
    const cameras = this.snapshot.devices.filter(device => device.kind === "videoinput")
    const current = this.snapshot.localStream.getVideoTracks()[0]?.getSettings()
    if (cameras.length > 1) {
      const index = cameras.findIndex(camera => camera.deviceId === (current?.deviceId || this.snapshot.cameraId))
      await this.selectCamera(cameras[(index + 1) % cameras.length].deviceId)
    } else {
      try { await this.replaceCapture("video", "", current?.facingMode === "environment" ? "user" : "environment") }
      catch (error) { this.update({ notice: `${mediaError(error)} Your audio can continue.` }) }
    }
  }
  private newStream(tracks: MediaStreamTrack[] = []) { return this.dependencies.createMediaStream?.(tracks) ?? new MediaStream(tracks) }
  private queueMedia(kind: "audio" | "video", operation: () => Promise<void>) {
    const queued = this.mediaQueue[kind].then(operation, operation)
    this.mediaQueue[kind] = queued.catch(() => {})
    return queued
  }
  private async replaceCapture(kind: "audio" | "video", deviceId: string, facingMode?: string) {
    if (!this.snapshot.localStream || FINAL_PHASES.has(this.snapshot.phase)) return
    const generation = this.generation
    const mediaGeneration = ++this.mediaGeneration[kind]
    const constraints: MediaTrackConstraints | boolean = deviceId ? { deviceId: { exact: deviceId } } : facingMode ? { facingMode: { ideal: facingMode } } : true
    const stream = await this.mediaDevices!.getUserMedia({ audio: kind === "audio" ? constraints : false, video: kind === "video" ? constraints : false })
    if (!this.live(generation) || mediaGeneration !== this.mediaGeneration[kind]) { stopStream(stream); return }
    const replacement = stream.getTracks().find(track => track.kind === kind)
    if (!replacement) { stopStream(stream); throw new Error(`No ${kind === "audio" ? "microphone" : "camera"} was available.`) }
    this.pendingCapture.add(stream)
    try {
      await this.queueMedia(kind, async () => {
        if (!this.live(generation) || mediaGeneration !== this.mediaGeneration[kind]) { stopStream(stream); return }
        if (kind === "audio") replacement.enabled = !this.snapshot.microphoneMuted
        const sender = kind === "audio" ? this.audioSender : this.videoSender
        try { if (sender) await sender.replaceTrack(replacement) }
        catch (error) { stopStream(stream); throw error }
        if (!this.live(generation) || mediaGeneration !== this.mediaGeneration[kind]) {
          // Replacement requests for this kind are serialized. Restore the
          // currently intended track before allowing a newer request to run.
          if (this.live(generation) && sender) await sender.replaceTrack(this.snapshot.localStream?.getTracks().find(track => track.kind === kind) ?? null).catch(() => {})
          stopStream(stream); return
        }
        if (kind === "audio") replacement.enabled = !this.snapshot.microphoneMuted
        const previous = this.snapshot.localStream!
        const keep = previous.getTracks().filter(track => track.kind !== kind)
        previous.getTracks().filter(track => track.kind === kind).forEach(track => track.stop())
        stream.getTracks().filter(track => track !== replacement).forEach(track => track.stop())
        const localStream = this.newStream([...keep, replacement])
        replacement.onended = () => {
          if (!this.live(generation) || !this.snapshot.localStream?.getTracks().includes(replacement)) return
          if (kind === "video") this.update({ cameraEnabled: false, notice: "The camera stopped. Your audio can continue." })
          else this.update({ microphoneMuted: true, notice: "The microphone stopped. Choose another microphone to continue." })
          void this.sendMediaState()
        }
        this.update(kind === "audio" ? { localStream, microphoneId: replacement.getSettings().deviceId || deviceId, notice: null }
          : { localStream, cameraEnabled: true, cameraId: replacement.getSettings().deviceId || deviceId, notice: null,
            ...(this.snapshot.direction === "outgoing" && !this.published ? { mode: "video" as const } : {}) })
      })
    } finally { this.pendingCapture.delete(stream) }
    await this.refreshDevices()
    void this.sendMediaState()
  }
  private async refreshDevices() {
    try { const devices = await this.mediaDevices!.enumerateDevices(); this.update({ devices: devices.filter(device => ["audioinput", "videoinput"].includes(device.kind)) }) }
    catch { /* Capture is usable even when enumeration is restricted. */ }
  }
  private async sendMediaState() {
    if (!this.accepted) return
    try { await this.send({ kind: "media-state", muted: this.snapshot.microphoneMuted, camera: this.snapshot.cameraEnabled, private: this.privateCall }) }
    catch { /* Connection state/deadlines handle disconnected signaling. */ }
  }

  updateSettings(settings: Partial<CallSettings>) {
    const next = { ...this.snapshot.settings, ...settings }
    this.update({ settings: next })
    this.options.onSettingsChange?.(next)
    this.heartbeatAt = 0
    if (next.silenceIncoming && this.snapshot.direction === "incoming" && ["incoming", "routing", "preparing", "preview"].includes(this.snapshot.phase)) void this.decline()
    if (next.relayOnly && this.connectionPolicy === "all" && !FINAL_PHASES.has(this.snapshot.phase)) void this.finish("ended", "Start a new call to use relay-only connections.")
  }
  async decline() { await this.finish("declined") }
  async end() { await this.finish("ended") }
  dismiss() {
    if (!FINAL_PHASES.has(this.snapshot.phase)) return
    this.update({ phase: "idle", callId: null, peer: null, direction: null, peerLabel: "", error: null, notice: null })
  }
  private terminalReason(reason: string | null | undefined): CompletedCall["outcome"] {
    return reason === "declined" ? "declined" : reason === "unanswered" || reason === "expired" ? "unanswered" : reason === "busy" ? "busy" : reason === "failed" ? "failed" : "ended"
  }
  private async finish(phase: CompletedCall["outcome"], error?: string, notify = true, record = true) {
    if (FINAL_PHASES.has(this.snapshot.phase)) return
    const previous = this.snapshot
    const published = this.published
    const callId = previous.callId
    this.privateCall ||= Boolean(previous.peer && this.options.getPeerPolicy(previous.peer).private)
    const completed: CompletedCall | null = published && record && !this.recorded && callId && previous.peer && previous.direction ? {
      id: callId, peer: previous.peer, mode: previous.mode, direction: previous.direction, outcome: phase,
      startedAt: this.startedAt, endedAt: this.now(), durationSeconds: previous.connectedAt ? Math.max(0, Math.floor((this.now() - previous.connectedAt) / 1_000)) : 0,
      private: this.privateCall || Boolean(this.options.getPeerPolicy(previous.peer).private),
    } : null
    this.recorded = true
    this.generation++
    this.cleanup()
    this.update({ phase, error: error ?? null, localStream: null, remoteStream: null, cameraEnabled: false })
    if (notify && published && callId) {
      const reason = phase === "ended" ? previous.connectedAt ? "ended" : "cancelled" : phase
      try {
        // The same atomic terminal update contains both peers' sticky privacy
        // choice, so final history never depends on a racing media-state packet.
        const terminal = await this.transport.finish(callId, reason, completed?.private ?? this.privateCall)
        if (completed) completed.private ||= terminal.noHistory
      } catch {
        // With an unknown terminal privacy state, preserving no history is safer.
        if (completed) completed.private = true
      }
    }
    if (completed) {
      this.recentCompleted.set(completed.id, completed)
      if (this.recentCompleted.size > 32) this.recentCompleted.delete(this.recentCompleted.keys().next().value!)
      try { await this.options.onCompleted?.(completed) } catch { /* History cannot prevent device release. */ }
    }
  }
  private cleanup() {
    this.mediaGeneration.audio++
    this.mediaGeneration.video++
    this.mediaQueue = { audio: Promise.resolve(), video: Promise.resolve() }
    this.pendingCapture.forEach(stopStream)
    this.pendingCapture.clear()
    if (this.deadline) clearTimeout(this.deadline)
    this.deadline = null
    const pc = this.pc
    this.pc = null
    if (pc) { pc.onicecandidate = null; pc.onicecandidateerror = null; pc.ontrack = null; pc.onconnectionstatechange = null; pc.close() }
    stopStream(this.snapshot.localStream)
    stopStream(this.snapshot.remoteStream)
    this.audioSender = null
    this.videoSender = null
    this.pendingIce = []
  }
  dispose() {
    if (this.disposed) return
    // finish synchronously stops capture before its first asynchronous operation.
    void this.end()
    this.disposed = true
    this.running = false
    this.generation++
    this.cleanup()
    if (this.pollTimer) clearTimeout(this.pollTimer)
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide)
      window.removeEventListener("serotine:identity-changing", this.onIdentityChange)
    }
    this.listeners.clear()
  }
}
