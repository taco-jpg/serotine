import { FileUploadError, fileUploadConfiguration, handleFileUploadChunk, handleFileUploadRequest } from "@/lib/file-upload-relay"
import { isFileUploadObject } from "@/lib/file-upload-protocol"
import type { RequestProof } from "@/lib/protocol"

const MAX_CONTROL_BYTES = 32 * 1024
const json = (value: unknown, status = 200) => Response.json(value, { status,
  headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" } })
function sameOrigin(request: Request) {
  const origin = request.headers.get("origin")
  const site = request.headers.get("sec-fetch-site")
  if ((origin !== null && origin !== new URL(request.url).origin) || (site !== null && site !== "same-origin" && site !== "none")) {
    throw new FileUploadError("Open Serotine directly to upload files.", 403)
  }
}
function failure(error: unknown): Response {
  if (error instanceof FileUploadError) return json({ success: false, error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status)
  return json({ success: false, error: "File storage is temporarily unavailable. Retry the upload." }, 503)
}
function envelope(value: unknown): { action: string; data: unknown; proof: RequestProof } {
  if (!isFileUploadObject(value) || value.version !== 1 || typeof value.action !== "string" || !isFileUploadObject(value.proof)
    || Object.keys(value).length !== 4 || !Object.hasOwn(value, "data")) throw new FileUploadError("Invalid file upload request.")
  return { action: value.action, data: value.data, proof: value.proof as unknown as RequestProof }
}
async function boundedBody(request: Request, limit: number): Promise<ArrayBuffer> {
  if (Number(request.headers.get("content-length")) > limit) throw new FileUploadError("File request is too large.", 413)
  if (!request.body) throw new FileUploadError("Invalid file upload request.")
  const reader = request.body.getReader()
  const bytes = new Uint8Array(limit)
  let used = 0
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}) }, 60_000)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (timedOut) throw new FileUploadError("File upload took too long. Retry the upload.", 408)
      if (done) break
      if (used + value.byteLength > limit) {
        void reader.cancel().catch(() => {})
        throw new FileUploadError("File request is too large.", 413)
      }
      bytes.set(value, used)
      used += value.byteLength
    }
    return used === limit ? bytes.buffer : bytes.slice(0, used).buffer
  } finally { clearTimeout(timer); reader.releaseLock() }
}
export async function GET(request: Request): Promise<Response> {
  try { sameOrigin(request); return json(await fileUploadConfiguration()) } catch (error) { return failure(error) }
}
export async function POST(request: Request): Promise<Response> {
  try {
    sameOrigin(request)
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) throw new FileUploadError("Invalid file upload request.", 415)
    const bytes = await boundedBody(request, MAX_CONTROL_BYTES)
    let value: unknown
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new FileUploadError("Invalid file upload request.") }
    const { action, data, proof } = envelope(value)
    const result = await handleFileUploadRequest(action, data, proof)
    return result instanceof Response ? result : json(result)
  } catch (error) { return failure(error) }
}
export async function PUT(request: Request): Promise<Response> {
  try {
    sameOrigin(request)
    if (request.headers.get("content-type") !== "application/octet-stream") throw new FileUploadError("Invalid file chunk request.", 415)
    const header = request.headers.get("x-serotine-file-request")
    if (!header || header.length > MAX_CONTROL_BYTES) throw new FileUploadError("Invalid file chunk request.")
    let value: unknown
    try { value = JSON.parse(header) } catch { throw new FileUploadError("Invalid file chunk request.") }
    const { action, data, proof } = envelope(value)
    if (action !== "file:chunk") throw new FileUploadError("Invalid file chunk request.")
    return json(await handleFileUploadChunk(data, proof, limit => boundedBody(request, limit)))
  } catch (error) { return failure(error) }
}
