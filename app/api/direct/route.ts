import { CallRelayError } from "@/lib/call-relay"
import { handleDirectSignaling } from "@/lib/direct-signaling-server"
import type { RequestProof } from "@/lib/protocol"

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } })
export async function POST(request: Request) {
  const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site")
  if ((origin !== null && origin !== new URL(request.url).origin) || (site !== null && !["same-origin", "none"].includes(site))) return json({ success: false, error: "Open Serotine directly to establish a direct connection." }, 403)
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return json({ success: false, error: "Invalid direct setup." }, 415)
  try {
    if (!request.body) throw new CallRelayError("Invalid direct setup.")
    const reader = request.body.getReader(), buffer = new Uint8Array(36 * 1024)
    let length = 0
    try { while (true) { const { value, done } = await reader.read(); if (done) break; if (length + value.byteLength > buffer.length) { void reader.cancel(); throw new CallRelayError("Direct setup is too large.", 413) }; buffer.set(value, length); length += value.byteLength } } finally { reader.releaseLock() }
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))) as { version: number; action: string; data: unknown; proof: RequestProof }
    if (!body || body.version !== 1 || Object.keys(body).length !== 4 || !body.proof) throw new CallRelayError("Invalid direct setup.")
    return json(await handleDirectSignaling(body.action, body.data, body.proof))
  } catch (error) {
    return json({ success: false, error: error instanceof CallRelayError ? error.message : "Direct setup is unavailable. No conversation content was relayed." }, error instanceof CallRelayError ? error.status : 503)
  }
}
