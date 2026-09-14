import type { Identity } from "./identity"
import { createRequestProof } from "./request-auth"
import { isCallObject } from "./call-protocol"
import { CALL_SOCKET_PATH, CALL_SOCKET_REQUEST_BYTES, CALL_SOCKET_RESPONSE_BYTES, CALL_SOCKET_PENDING_LIMIT } from "./call-socket-protocol"

export class CallTransportError extends Error {
  constructor(message: string, public code?: "direct-only") { super(message) }
}
const unavailable = () => new CallTransportError("Calling could not reach its signaling server. Keep Serotine open and reconnect to try again.")
const unexpected = () => new CallTransportError("The calling service returned an unexpected response. Reload Serotine and retry.")
type Pending = { socket: WebSocket; resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Options {
  createWebSocket?: (url: string) => WebSocket
  origin?: string
  timeoutMs?: number
  reconnectDelayMs?: number
}

/** Call signaling only. Requests retain their identity proofs and encrypted SDP/ICE.
 * A disconnected mutation is rejected, never automatically sent a second time. */
export function createCallSocket(identity: Identity, sessionId: string, options: Options = {}) {
  const pending = new Map<string, Pending>(), listeners = new Set<() => void>()
  let socket: WebSocket | null = null, opening: Promise<void> | null = null
  let authenticated = false, disposed = false, attempts = 0
  let clockOffset = 0
  let cancelOpening: { socket: WebSocket; cancel(error: Error): void } | null = null
  let reconnect: ReturnType<typeof setTimeout> | undefined
  const timeoutMs = options.timeoutMs ?? 10_000
  const wake = () => { for (const listener of listeners) { try { listener() } catch { /* One view cannot prevent other consumers from resyncing. */ } } }
  function url() {
    const address = new URL(options.origin ?? window.location.origin)
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(address.hostname)
    if (address.protocol !== "https:" && !(address.protocol === "http:" && local)) throw new CallTransportError("Open Serotine over HTTPS to use calling.")
    address.protocol = address.protocol === "https:" ? "wss:" : "ws:"
    address.pathname = CALL_SOCKET_PATH; address.search = ""; address.hash = ""
    return address.toString()
  }
  function rejectPending(ws: WebSocket, error: Error) {
    for (const [id, entry] of pending) if (entry.socket === ws) { clearTimeout(entry.timer); pending.delete(id); entry.reject(error) }
  }
  function scheduleReconnect() {
    if (disposed || !listeners.size || reconnect || attempts >= 6) return
    const delay = Math.min(30_000, (options.reconnectDelayMs ?? 500) * 2 ** attempts++)
    reconnect = setTimeout(() => { reconnect = undefined; void connect().catch(() => scheduleReconnect()) }, delay)
  }
  function drop(ws: WebSocket, error = unavailable()) {
    const current = socket === ws
    if (current) { socket = null; authenticated = false }
    if (cancelOpening?.socket === ws) cancelOpening.cancel(error)
    rejectPending(ws, error)
    // Clear ownership before close: test doubles and some browser error paths
    // can synchronously dispatch another close notification.
    if (ws.readyState < 2) { try { ws.close(1000, "Reconnect calling") } catch { /* The socket may already be closing. */ } }
    if (current) scheduleReconnect()
  }
  async function exchange(ws: WebSocket, action: string, data: Record<string, unknown>, auth = false) {
    if (disposed || ws !== socket || ws.readyState !== 1) throw unavailable()
    if (pending.size >= CALL_SOCKET_PENDING_LIMIT || ws.bufferedAmount > CALL_SOCKET_REQUEST_BYTES * 2) throw new CallTransportError("Calling is busy. Wait a moment and retry.")
    const proof = await createRequestProof(action, data, identity.privateKey, identity.publicKey, Date.now() + clockOffset)
    if (disposed || ws !== socket || ws.readyState !== 1) throw unavailable()
    if (pending.size >= CALL_SOCKET_PENDING_LIMIT || ws.bufferedAmount > CALL_SOCKET_REQUEST_BYTES * 2) throw new CallTransportError("Calling is busy. Wait a moment and retry.")
    const id = crypto.randomUUID()
    const encoded = JSON.stringify({ type: auth ? "auth" : "request", id, body: { version: 1, action, data, proof } })
    if (new TextEncoder().encode(encoded).length > CALL_SOCKET_REQUEST_BYTES) throw new CallTransportError("This call setup is too large. Try starting a new call.")
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new CallTransportError("Call setup took too long. Please try again.")); drop(ws) }, timeoutMs)
      pending.set(id, { socket: ws, resolve, reject, timer })
      try { ws.send(encoded) } catch { drop(ws) }
    })
  }
  function receive(ws: WebSocket, event: MessageEvent) {
    if (disposed || ws !== socket) return
    if (typeof event.data !== "string" || event.data.length > CALL_SOCKET_RESPONSE_BYTES || new TextEncoder().encode(event.data).length > CALL_SOCKET_RESPONSE_BYTES) return drop(ws, unexpected())
    let value: unknown
    try { value = JSON.parse(event.data) } catch { return drop(ws, unexpected()) }
    if (!isCallObject(value)) return drop(ws, unexpected())
    if (value.type === "changed" && Object.keys(value).length === 1) { if (authenticated) wake(); return }
    if (value.type !== "response" || Object.keys(value).length !== 4 || typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)
      || !Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599 || !isCallObject(value.body)) return drop(ws, unexpected())
    try { ws.send(JSON.stringify({ type: "ack", id: value.id })) } catch { return drop(ws) }
    const entry = pending.get(value.id)
    if (!entry || entry.socket !== ws) return
    clearTimeout(entry.timer); pending.delete(value.id)
    const body = value.body
    if (Number(value.status) >= 200 && Number(value.status) < 300 && body.success === true) {
      // Server response time is conservative by the response's transit delay.
      // Use it for call deadlines instead of comparing different device clocks.
      if (Number.isSafeInteger(body.serverTime) && Number(body.serverTime) > 0) clockOffset = Number(body.serverTime) - Date.now()
      entry.resolve(body)
    }
    else {
      const message = body.error
      const safe = typeof message === "string" && message.length > 0 && message.length <= 500 && !/[<>]/.test(message) && ![...message].some(character => character.charCodeAt(0) < 32)
      entry.reject(safe ? new CallTransportError(message, body.code === "direct-only" ? "direct-only" : undefined) : unexpected())
    }
  }
  async function connect(): Promise<void> {
    if (disposed) throw unavailable()
    if (authenticated && socket?.readyState === 1) return
    if (opening) return opening
    clearTimeout(reconnect); reconnect = undefined
    opening = (async () => {
      let ws: WebSocket
      try { ws = options.createWebSocket?.(url()) ?? new WebSocket(url()) } catch { throw unavailable() }
      socket = ws; authenticated = false
      ws.addEventListener("message", event => receive(ws, event))
      ws.addEventListener("close", () => drop(ws))
      ws.addEventListener("error", () => drop(ws))
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const timer = setTimeout(() => done(unavailable()), timeoutMs)
          const opened = () => done(), failed = () => done(unavailable())
          const done = (error?: Error) => {
            if (settled) return
            settled = true; clearTimeout(timer)
            ws.removeEventListener("open", opened); ws.removeEventListener("close", failed); ws.removeEventListener("error", failed)
            if (cancelOpening?.socket === ws) cancelOpening = null
            if (error) reject(error); else resolve()
          }
          cancelOpening = { socket: ws, cancel: done }
          ws.addEventListener("open", opened, { once: true }); ws.addEventListener("close", failed, { once: true }); ws.addEventListener("error", failed, { once: true })
        })
        const result = await exchange(ws, "call:socket", { sessionId }, true)
        if (result.publicKey !== identity.publicKey || result.sessionId !== sessionId || disposed || ws !== socket) throw unexpected()
        authenticated = true; attempts = 0
        wake()
      } catch (error) { drop(ws); throw error }
    })()
    try { await opening } finally { opening = null }
  }
  return {
    now: () => Date.now() + clockOffset,
    async request(action: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
      if (data.sessionId !== sessionId || action === "call:socket") throw unexpected()
      await connect()
      return exchange(socket!, action, data)
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); if (!listeners.size) { clearTimeout(reconnect); reconnect = undefined } } },
    dispose() {
      if (disposed) return
      disposed = true; listeners.clear(); clearTimeout(reconnect); reconnect = undefined
      if (socket) drop(socket)
    },
  }
}
