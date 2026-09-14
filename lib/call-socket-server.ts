import { isCallObject, isCallPeer } from "./call-protocol"
import { CALL_SOCKET_AUTH_MS, CALL_SOCKET_IDLE_MS, CALL_SOCKET_LIFETIME_MS, CALL_SOCKET_MUTATIONS,
  CALL_SOCKET_PENDING_LIMIT, CALL_SOCKET_RESPONSE_BYTES, callSocketUpgradeError, parseCallSocketFrame } from "./call-socket-protocol"

interface Socket extends WebSocket {
  serializeAttachment(value: unknown): void
  deserializeAttachment(): Attachment | null
}
interface Attachment {
  origin: string
  createdAt: number
  lastSeen: number
  publicKey: string | null
  sessionId: string | null
  authenticating: boolean
  windowStart: number
  requests: number
  frames: number
  pending: string[]
  unacked: { id: string; bytes: number; sentAt: number }[]
  changed: boolean
}
interface SocketState {
  acceptWebSocket(socket: Socket): void
  getWebSockets(): Socket[]
  storage: { getAlarm(): Promise<number | null>; setAlarm(time: number): Promise<void> }
}
export interface CallSignalingEnvironment {
  WORKER_SELF_REFERENCE: { fetch(request: Request): Promise<Response> }
  CALL_SIGNALING: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } }
}
declare const WebSocketPair: { new(): { 0: Socket; 1: Socket } }
const MAX_SOCKETS = 1_024
const MAX_UNAUTHENTICATED = 64
const MAX_IDENTITY_SOCKETS = 16
const encoder = new TextEncoder()
function close(socket: Socket, code: number, reason: string) { try { socket.close(code, reason) } catch { /* Already closed. */ } }
function attached(socket: Socket) { try { return socket.deserializeAttachment() } catch { return null } }
function alive(socket: Socket) { return socket.readyState === 1 }

/** Hibernating signaling only: signed JSON operations, never binary/media frames.
 * The self binding enters the existing Next handler with its own Cloudflare
 * request context; the DO never calls getCloudflareContext or bypasses D1 auth.
 */
export class CallSignalingHub {
  constructor(private ctx: SocketState, private env: CallSignalingEnvironment) {}

  async fetch(request: Request): Promise<Response> {
    const error = callSocketUpgradeError(request)
    if (error) return new Response("Open Serotine directly to use calling.", { status: error })
    const sockets = this.ctx.getWebSockets().filter(alive)
    if (sockets.length >= MAX_SOCKETS || sockets.filter(socket => !attached(socket)?.publicKey).length >= MAX_UNAUTHENTICATED) {
      return new Response("Calling is busy. Retry shortly.", { status: 503 })
    }
    const pair = new WebSocketPair()
    const now = Date.now()
    pair[1].serializeAttachment({ origin: new URL(request.url).origin, createdAt: now, lastSeen: now, publicKey: null, sessionId: null,
      authenticating: false, windowStart: now, requests: 0, frames: 0, pending: [], unacked: [], changed: false } satisfies Attachment)
    this.ctx.acceptWebSocket(pair[1])
    await this.schedule(now + CALL_SOCKET_AUTH_MS)
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit)
  }

  private async schedule(at: number) {
    const alarm = await this.ctx.storage.getAlarm()
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at)
  }

  async alarm() {
    const now = Date.now()
    let next = Infinity
    for (const socket of this.ctx.getWebSockets()) {
      const state = attached(socket)
      if (!state || !alive(socket)) continue
      const deadline = Math.min(state.publicKey ? state.lastSeen + CALL_SOCKET_IDLE_MS : state.createdAt + CALL_SOCKET_AUTH_MS,
        state.createdAt + CALL_SOCKET_LIFETIME_MS, ...state.unacked.map(entry => entry.sentAt + 30_000))
      if (deadline <= now) close(socket, 4001, "Reconnect calling.")
      else next = Math.min(next, deadline)
    }
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next)
  }

  private respond(socket: Socket, id: string, status: number, body: Record<string, unknown>) {
    if (!alive(socket)) return
    const state = attached(socket)
    if (!state) return
    const text = JSON.stringify({ type: "response", id, status, body })
    const bytes = encoder.encode(text).length
    if (bytes > CALL_SOCKET_RESPONSE_BYTES || state.unacked.length >= CALL_SOCKET_PENDING_LIMIT
      || state.unacked.reduce((sum, entry) => sum + entry.bytes, 0) + bytes > CALL_SOCKET_RESPONSE_BYTES) {
      close(socket, 4008, "Calling client is too slow. Reconnect.")
      return
    }
    state.unacked.push({ id, bytes, sentAt: Date.now() })
    socket.serializeAttachment(state)
    try { socket.send(text) } catch { close(socket, 1011, "Calling connection failed.") }
  }

  async webSocketMessage(socket: Socket, message: string | ArrayBuffer) {
    if (!alive(socket)) return
    if (typeof message !== "string") { close(socket, 1003, "Only calling signaling is supported."); return }
    const frame = parseCallSocketFrame(message)
    const state = attached(socket)
    if (!frame || !state) { close(socket, 1008, "Invalid calling frame."); return }
    const now = Date.now()
    if (now - state.createdAt >= CALL_SOCKET_LIFETIME_MS || now - state.lastSeen >= CALL_SOCKET_IDLE_MS
      || (!state.publicKey && now - state.createdAt >= CALL_SOCKET_AUTH_MS)) { close(socket, 4001, "Reconnect calling."); return }
    if (now - state.windowStart >= 60_000) { state.windowStart = now; state.requests = 0; state.frames = 0 }
    if (++state.frames > 1_200) { close(socket, 4008, "Too many calling frames."); return }
    state.lastSeen = now
    if (frame.type === "ack") {
      state.unacked = state.unacked.filter(entry => entry.id !== frame.id)
      socket.serializeAttachment(state)
      return
    }
    if (++state.requests > 600 || state.pending.length >= CALL_SOCKET_PENDING_LIMIT
      || state.pending.includes(frame.id) || state.unacked.some(entry => entry.id === frame.id)) { close(socket, 4008, "Too many calling requests."); return }
    if (frame.type === "auth") {
      if (state.publicKey || state.authenticating) { close(socket, 1008, "Calling connection is already authenticated."); return }
      state.authenticating = true
    } else if (!state.publicKey || frame.body.proof.publicKey !== state.publicKey || frame.body.data.sessionId !== state.sessionId) {
      close(socket, 1008, "Calling identity or device changed."); return
    }
    state.pending.push(frame.id)
    state.changed = false
    socket.serializeAttachment(state)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    let status = 503
    let body: Record<string, unknown> = { success: false, error: "Calling signaling is temporarily unavailable. Retry shortly." }
    try {
      // Self-binding requests do not inherit ingress headers. Preserve the
      // validated upgrade origin so OpenNext reconstructs the same request URL.
      const origin = new URL(state.origin)
      const response = await this.env.WORKER_SELF_REFERENCE.fetch(new Request(`${state.origin}/api/calls`, {
        method: "POST", headers: {
          "content-type": "application/json", origin: state.origin, host: origin.host,
          "x-forwarded-host": origin.host, "x-forwarded-proto": origin.protocol.slice(0, -1),
        }, body: JSON.stringify(frame.body), signal: controller.signal,
      }))
      // Bound reads too: the self binding is trusted, but a broken response must
      // not allocate unbounded memory or forward an HTML error page to clients.
      if (!response.body) throw new Error("Empty response")
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let length = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > CALL_SOCKET_RESPONSE_BYTES - 256) { await reader.cancel(); throw new Error("Response too large") }
          chunks.push(chunk.value)
        }
      } finally { reader.releaseLock() }
      const joined = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength }
      const value: unknown = JSON.parse(new TextDecoder().decode(joined))
      if (!isCallObject(value)) throw new Error("Invalid response")
      status = response.status
      body = value
    } catch { /* Never log proofs, negotiation payloads, or backend errors. */ }
    finally { clearTimeout(timeout) }
    const current = attached(socket)
    if (!current) return
    current.pending = current.pending.filter(id => id !== frame.id)
    if (frame.type === "auth" && status === 200 && body.success === true) {
      if (body.publicKey !== frame.body.proof.publicKey || body.sessionId !== frame.body.data.sessionId) {
        close(socket, 1008, "Calling identity could not be verified."); return
      }
      const siblings = this.ctx.getWebSockets().filter(other => alive(other) && attached(other)?.publicKey === body.publicKey)
      if (siblings.length >= MAX_IDENTITY_SOCKETS) { close(socket, 4008, "Too many calling devices are open."); return }
      current.publicKey = body.publicKey as string
      current.sessionId = body.sessionId as string
    }
    socket.serializeAttachment(current)
    const targets = status === 200 && body.success === true && CALL_SOCKET_MUTATIONS.has(frame.body.action)
      && Array.isArray(body._notify) ? body._notify.filter(isCallPeer).slice(0, 16) : []
    delete body._notify
    this.respond(socket, frame.id, status, body)
    if (frame.type === "auth" && (status !== 200 || body.success !== true)) close(socket, 4003, "Calling authentication failed.")
    // Only the backend's authorized participant set can trigger a content-free
    // wakeup. Each recipient then fetches its own signed, access-checked snapshot.
    for (const other of this.ctx.getWebSockets()) {
      const recipient = attached(other)
      if (!alive(other) || !recipient?.publicKey || !targets.includes(recipient.publicKey) || recipient.changed) continue
      recipient.changed = true
      other.serializeAttachment(recipient)
      try { other.send('{"type":"changed"}') } catch { close(other, 1011, "Calling connection failed.") }
    }
    await this.schedule(Date.now() + 30_000)
  }

  webSocketClose(socket: Socket, code: number) { close(socket, code, "") }
  webSocketError(socket: Socket) { close(socket, 1011, "Calling connection failed.") }
}
