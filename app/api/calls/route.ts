import { CallRelayError, handleCallRequest } from "@/lib/call-relay"
import { isCallObject } from "@/lib/call-protocol"
import type { RequestProof } from "@/lib/protocol"

const MAX_BODY_BYTES = 192 * 1024
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" } })
}
/** Dedicated transient transport. Calling never enters retained messaging feeds. */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin")
  const site = request.headers.get("sec-fetch-site")
  if ((origin !== null && origin !== new URL(request.url).origin) || (site !== null && site !== "same-origin" && site !== "none")) {
    return json({ success: false, error: "Open Serotine directly to use calling." }, 403)
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
    return json({ success: false, error: "Invalid calling request." }, 415)
  }
  try {
    if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new CallRelayError("Calling request is too large.", 413)
    if (!request.body) throw new CallRelayError("Invalid calling request.")
    const reader = request.body.getReader()
    const buffer = new Uint8Array(MAX_BODY_BYTES)
    let length = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (length + value.byteLength > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {})
          throw new CallRelayError("Calling request is too large.", 413)
        }
        buffer.set(value, length)
        length += value.byteLength
      }
    } finally { reader.releaseLock() }
    let body: unknown
    try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))) }
    catch { throw new CallRelayError("Invalid calling request.") }
    if (!isCallObject(body) || body.version !== 1 || typeof body.action !== "string" || !isCallObject(body.proof)
      || Object.keys(body).length !== 4 || !Object.hasOwn(body, "data")) throw new CallRelayError("Invalid calling request.")
    return json(await handleCallRequest(body.action, body.data, body.proof as unknown as RequestProof))
  } catch (error) {
    if (error instanceof CallRelayError) return json({ success: false, error: error.message }, error.status)
    // No raw negotiation, credentials, request bodies, or infrastructure errors in logs.
    return json({ success: false, error: "Calling is temporarily unavailable. Your conversation is still available." }, 503)
  }
}
