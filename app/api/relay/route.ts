import {
  deleteMessage, getMyMessages, getSignal, storeEncryptedMessage, storeSignal,
  getEventFeed, getLegacyInbox, storeEncryptedEvent, retireIdentity,
} from "@/app/actions"
import { ID_PATTERN, MAX_EVENT_PACKET_LENGTH, MAX_PACKET_LENGTH, MAX_SIGNAL_PACKET_LENGTH, PUBLIC_KEY_PATTERN, type RequestProof } from "@/lib/protocol"

export const dynamic = "force-dynamic"

// Legacy files remain inline; event chunks and signals keep their smaller limits.
const MAX_BODY_BYTES = MAX_PACKET_LENGTH + 16 * 1024
const MAX_EVENT_BODY_BYTES = 144 * 1024
const MAX_CONTROL_BODY_BYTES = 80 * 1024
const INVALID_REQUEST = "Invalid messaging request. Reload Serotine and try again."

type JsonObject = Record<string, unknown>
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function keys(value: JsonObject, required: string[], optional: string[] = []) {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}
function peer(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_KEY_PATTERN.test(value)
}
function id(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value)
}
function packet(value: unknown, limit = MAX_PACKET_LENGTH): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= limit
}
function proofShape(value: unknown): value is RequestProof {
  return object(value) && keys(value, ["publicKey", "timestamp", "nonce", "signature"])
    && peer(value.publicKey) && Number.isSafeInteger(value.timestamp) && id(value.nonce)
    && typeof value.signature === "string" && /^[0-9a-f]{128}$/.test(value.signature)
}
function cursor(value: unknown): value is { createdAt: number; id: string } {
  return object(value) && keys(value, ["createdAt", "id"])
    && typeof value.createdAt === "number" && Number.isSafeInteger(value.createdAt)
    && value.createdAt >= 0 && id(value.id)
}
function legacyCursor(value: unknown): boolean {
  return object(value) && keys(value, ["createdAt", "id", "senderPubKey"])
    && typeof value.createdAt === "number" && Number.isSafeInteger(value.createdAt)
    && value.createdAt >= 0 && id(value.id) && peer(value.senderPubKey)
}
function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" },
  })
}
function failure(error: string, status: number) {
  return json({ success: false, error }, status)
}

class BodyTooLarge extends Error {}
async function readBody(request: Request, maximum: number): Promise<{ value: unknown; byteLength: number }> {
  const declaredLength = request.headers.get("content-length")
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximum) {
    throw new BodyTooLarge()
  }
  if (!request.body) throw new SyntaxError()
  const reader = request.body.getReader()
  // A growing byte buffer also bounds overhead for hostile one-byte chunks.
  let body = new Uint8Array(Math.min(16 * 1024, maximum))
  let length = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const nextLength = length + value.byteLength
      if (nextLength > maximum) {
        void reader.cancel().catch(() => {})
        throw new BodyTooLarge()
      }
      if (nextLength > body.byteLength) {
        const expanded = new Uint8Array(Math.min(maximum, Math.max(nextLength, body.byteLength * 2)))
        expanded.set(body.subarray(0, length))
        body = expanded
      }
      body.set(value, length)
      length = nextLength
    }
  } finally { reader.releaseLock() }
  return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, length))), byteLength: length }
}

/** Stable transport; the existing actions still verify signatures and consume nonces. */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin")
  const fetchSite = request.headers.get("sec-fetch-site")
  if ((origin !== null && origin !== new URL(request.url).origin)
    || (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none")) {
    return failure("Open Serotine directly to reconnect to messaging.", 403)
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return failure(INVALID_REQUEST, 415)
  }
  let body: unknown
  let bodyBytes: number
  const eventTransport = request.headers.get("x-serotine-events") === "1"
  try {
    const parsed = await readBody(request, eventTransport ? MAX_EVENT_BODY_BYTES : MAX_BODY_BYTES)
    body = parsed.value
    bodyBytes = parsed.byteLength
  }
  catch (error) {
    return error instanceof BodyTooLarge
      ? failure("This messaging request is too large. Use smaller files or shorten your message and try again.", 413)
      : failure(INVALID_REQUEST, 400)
  }
  if (!object(body)) return failure(INVALID_REQUEST, 400)
  if (body.version !== 2) {
    return failure("This Serotine tab uses an unsupported messaging version. Reload the app and reconnect.", 409)
  }
  if (!keys(body, ["version", "action", "data", "proof"]) || !object(body.data)) {
    return failure(INVALID_REQUEST, 400)
  }
  if (!proofShape(body.proof)) {
    return failure("Identity verification failed. Check your device clock and reopen the app.", 401)
  }
  const data = body.data
  const proof = body.proof
  // The event header selects its streamed cap; omitting it cannot expand an action's allowance.
  if (eventTransport && body.action !== "event:send" && body.action !== "event:sync") return failure(INVALID_REQUEST, 400)
  const actionBodyLimit = body.action === "message:send" ? MAX_BODY_BYTES
    : body.action === "event:send" || body.action === "event:sync" ? MAX_EVENT_BODY_BYTES : MAX_CONTROL_BODY_BYTES
  if (bodyBytes > actionBodyLimit) return failure("This messaging request is too large. Use smaller files or shorten your message and try again.", 413)
  try {
    // An explicit allowlist keeps this endpoint from invoking arbitrary server exports.
    switch (body.action) {
      case "identity:retire":
        if (!keys(data, [])) break
        return json(await retireIdentity(data as Record<string, never>, proof))
      case "event:send":
        if (!keys(data, ["id", "recipientPubKey", "encryptedData"])
          || !id(data.id) || !peer(data.recipientPubKey) || !packet(data.encryptedData, MAX_EVENT_PACKET_LENGTH)) break
        return json(await storeEncryptedEvent(data as unknown as Parameters<typeof storeEncryptedEvent>[0], proof))
      case "event:sync":
        if (!keys(data, [], ["after"]) || (Object.hasOwn(data, "after")
          && (typeof data.after !== "number" || !Number.isSafeInteger(data.after) || data.after < 0))) break
        return json(await getEventFeed(data as unknown as Parameters<typeof getEventFeed>[0], proof))
      case "message:inbox":
        if (!keys(data, [], ["after"]) || (Object.hasOwn(data, "after") && !legacyCursor(data.after))) break
        return json(await getLegacyInbox(data as unknown as Parameters<typeof getLegacyInbox>[0], proof))
      case "message:send":
        if (!keys(data, ["id", "recipientPubKey", "encryptedData"])
          || !id(data.id) || !peer(data.recipientPubKey) || !packet(data.encryptedData)) break
        return json(await storeEncryptedMessage(data as unknown as Parameters<typeof storeEncryptedMessage>[0], proof))
      case "message:list":
        if (!keys(data, ["senderPubKey"], ["after"]) || !peer(data.senderPubKey)
          || (Object.hasOwn(data, "after") && !cursor(data.after))) break
        // Preserve the signed object's property order rather than rebuilding it.
        return json(await getMyMessages(data as unknown as Parameters<typeof getMyMessages>[0], proof))
      case "message:ack":
        if (!keys(data, ["id", "senderPubKey"]) || !id(data.id) || !peer(data.senderPubKey)) break
        return json(await deleteMessage(data as unknown as Parameters<typeof deleteMessage>[0], proof))
      case "signal:send":
        if (!keys(data, ["recipientPubKey", "encryptedData"]) || !peer(data.recipientPubKey) || !packet(data.encryptedData, MAX_SIGNAL_PACKET_LENGTH)) break
        return json(await storeSignal(data as unknown as Parameters<typeof storeSignal>[0], proof))
      case "signal:read":
        if (!keys(data, ["senderPubKey"]) || !peer(data.senderPubKey)) break
        return json(await getSignal(data as unknown as Parameters<typeof getSignal>[0], proof))
    }
    return failure(INVALID_REQUEST, 400)
  } catch {
    return failure("The messaging relay is temporarily unavailable. Reconnect shortly. Sends have not been confirmed.", 503)
  }
}
