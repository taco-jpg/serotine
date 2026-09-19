import { SUMMARY_ACTION } from "@/lib/ai-summary"
import { AiSummaryError } from "@/lib/ai-summary-provider"
import { handleAiSummary } from "@/lib/ai-summary-server"
import type { RequestProof } from "@/lib/protocol"

const MAX_BODY_BYTES = 80_000
const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } })
const invalid = () => new AiSummaryError("Invalid summary request. Review the preview again.")

async function body(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) throw new AiSummaryError("Summary request is too large.", 413)
  if (!request.body) throw invalid()
  const reader = request.body.getReader(), bytes = new Uint8Array(MAX_BODY_BYTES)
  let used = 0, timedOut = false
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}) }, 10_000)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (timedOut) throw new AiSummaryError("Summary request took too long. Retry the action.", 408)
      if (done) break
      if (used + value.byteLength > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {})
        throw new AiSummaryError("Summary request is too large.", 413)
      }
      bytes.set(value, used); used += value.byteLength
    }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used))) }
    catch { throw invalid() }
  } finally { clearTimeout(timer); reader.releaseLock() }
}

export async function POST(request: Request): Promise<Response> {
  try {
    // This paid, plaintext export is stricter than ordinary relay endpoints:
    // authenticated requests must also come from the same browser origin.
    const origin = request.headers.get("origin"), site = request.headers.get("sec-fetch-site")
    if (origin !== new URL(request.url).origin || (site !== null && site !== "same-origin")) {
      throw new AiSummaryError("Open Serotine directly to request an AI summary.", 403, "summary-origin")
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) {
      throw new AiSummaryError("Invalid summary request format.", 415)
    }
    const value = await body(request)
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 4
      || !("version" in value) || value.version !== 1 || !("action" in value) || value.action !== SUMMARY_ACTION
      || !("data" in value) || !("proof" in value)) throw invalid()
    return json(await handleAiSummary(value.data, value.proof as RequestProof, request.signal))
  } catch (error) {
    if (error instanceof AiSummaryError) return json({ success: false, error: error.message, code: error.code }, error.status)
    // Neither provider exceptions nor request content reach client-visible logs.
    return json({ success: false, error: "AI summaries are temporarily unavailable. Try again later.", code: "summary-unavailable" }, 503)
  }
}
