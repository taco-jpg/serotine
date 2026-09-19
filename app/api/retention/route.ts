import { handleRetention, RetentionError } from "@/lib/retention-server"
import type { RequestProof } from "@/lib/protocol"
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })
export async function POST(request: Request): Promise<Response> {
  try {
    const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site")
    if ((origin !== null && origin !== new URL(request.url).origin) || (site !== null && site !== "same-origin" && site !== "none")) throw new RetentionError("Open Serotine directly to manage retention.", 403)
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new RetentionError("Invalid request format.", 415)
    const reader = request.body?.getReader()
    if (!reader) throw new RetentionError("Invalid retention request.")
    const bytes = new Uint8Array(32_000); let length = 0, expired = false
    const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}) }, 10_000)
    let body: { version: number; action: string; data: unknown; proof: RequestProof }
    try {
      while (true) { const part = await reader.read(); if (expired) throw new RetentionError("Request timed out.", 408); if (part.done) break
        if (length + part.value.length > bytes.length) { void reader.cancel(); throw new RetentionError("Request is too large.", 413) }
        bytes.set(part.value, length); length += part.value.length }
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))
    } finally { clearTimeout(timer); reader.releaseLock() }
    if (!body || body.version !== 1 || Object.keys(body).length !== 4) throw new RetentionError("Invalid retention request.")
    return json(await handleRetention(body.action, body.data, body.proof))
  } catch (error) {
    if (error instanceof RetentionError) return json({ success: false, error: error.message }, error.status)
    return json({ success: false, error: "Server cleanup could not finish. Retry; a closed conversation stays closed while cleanup is pending." }, 503)
  }
}
