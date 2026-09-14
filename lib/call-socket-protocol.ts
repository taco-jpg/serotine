import { isCallId, isCallObject, isCallPeer } from "./call-protocol"

export const CALL_SOCKET_PATH = "/api/calls/socket"
export const CALL_SOCKET_REQUEST_BYTES = 192 * 1024
export const CALL_SOCKET_RESPONSE_BYTES = 8 * 1024 * 1024
export const CALL_SOCKET_PENDING_LIMIT = 32
export const CALL_SOCKET_AUTH_MS = 10_000
export const CALL_SOCKET_IDLE_MS = 90_000
export const CALL_SOCKET_LIFETIME_MS = 60 * 60_000
const REQUEST_ID = /^[a-zA-Z0-9_-]{1,64}$/
const ACTIONS = new Set([
  "call:socket", "call:heartbeat", "call:capability", "call:configuration", "call:invite", "call:claim", "call:send", "call:poll", "call:finish",
  "room:status", "room:join", "room:heartbeat", "room:send", "room:poll", "room:leave",
])
export const CALL_SOCKET_MUTATIONS = new Set(["call:invite", "call:claim", "call:send", "call:finish", "room:join", "room:send", "room:leave"])
export interface CallSocketRequest {
  type: "auth" | "request"
  id: string
  body: { version: 1; action: string; data: Record<string, unknown> & { sessionId: string }; proof: Record<string, unknown> & { publicKey: string } }
}
export type CallSocketFrame = CallSocketRequest | { type: "ack"; id: string }
export function parseCallSocketFrame(text: string): CallSocketFrame | null {
  if (text.length > CALL_SOCKET_REQUEST_BYTES || new TextEncoder().encode(text).length > CALL_SOCKET_REQUEST_BYTES) return null
  let frame: unknown
  try { frame = JSON.parse(text) } catch { return null }
  if (!isCallObject(frame) || typeof frame.id !== "string" || !REQUEST_ID.test(frame.id)) return null
  if (frame.type === "ack") return Object.keys(frame).length === 2 ? frame as CallSocketFrame : null
  if ((frame.type !== "auth" && frame.type !== "request") || Object.keys(frame).length !== 3 || !isCallObject(frame.body)) return null
  const body = frame.body
  if (Object.keys(body).length !== 4 || body.version !== 1 || typeof body.action !== "string" || !ACTIONS.has(body.action)
    || !isCallObject(body.data) || !isCallId(body.data.sessionId) || !isCallObject(body.proof) || !isCallPeer(body.proof.publicKey)) return null
  if ((frame.type === "auth") !== (body.action === "call:socket")) return null
  return frame as unknown as CallSocketRequest
}

/** Browsers must reach the same origin over TLS. Local HTTP is only for development. */
export function callSocketUpgradeError(request: Request): number | null {
  const url = new URL(request.url)
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (request.method !== "GET" || url.pathname !== CALL_SOCKET_PATH || url.search) return 400
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return 403
  if (request.headers.get("origin") !== url.origin) return 403
  const site = request.headers.get("sec-fetch-site")
  if (site !== null && site !== "same-origin" && site !== "none") return 403
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return 426
  return null
}
