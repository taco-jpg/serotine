import { getNativeBridge, type NativeBridge } from "./bridge"
import { flushNativeStorage } from "../../lib/native-persistence"

// These bounds are repeated at the privileged boundary. The renderer cannot
// select a host, follow redirects, send cookies, or turn the bridge into a proxy.
export const NATIVE_REQUEST_BYTES = 8 * 1024 * 1024
export const NATIVE_RESPONSE_BYTES = 16 * 1024 * 1024
const ENDPOINT_METHODS: Record<string, readonly string[]> = {
  "/api/relay": ["POST"], "/api/calls": ["POST"], "/api/direct": ["POST"],
  "/api/groups": ["POST"], "/api/retention": ["POST"],
  "/api/files": ["GET", "POST", "PUT"], "/api/plugins/summary": ["POST"],
  "/api/giphy/config": ["GET"],
}
const REQUEST_HEADERS = new Set(["content-type", "accept", "x-serotine-events", "x-serotine-file-request"])
const RESPONSE_HEADERS = new Set(["content-type", "content-length", "retry-after"])

function encode(bytes: Uint8Array): string {
  let text = ""
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}
function decode(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length > Math.ceil(NATIVE_RESPONSE_BYTES / 3) * 4
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)
    || (value.includes("=") && !/^[A-Za-z0-9+/]*={1,2}$/.test(value))) {
    throw new Error("The native connection returned invalid or oversized data.")
  }
  const text = atob(value)
  if (text.length > NATIVE_RESPONSE_BYTES) throw new Error("The native connection returned too much data.")
  return Uint8Array.from(text, character => character.charCodeAt(0))
}
async function bodyBytes(body?: BodyInit | null): Promise<Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined
  let bytes: Uint8Array
  if (typeof body === "string") {
    if (body.length > NATIVE_REQUEST_BYTES) throw new Error("The native request is too large.")
    bytes = new TextEncoder().encode(body)
  } else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body)
  else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  else if (body instanceof Blob) {
    if (body.size > NATIVE_REQUEST_BYTES) throw new Error("The native request is too large.")
    bytes = new Uint8Array(await body.arrayBuffer())
  } else throw new Error("This request body is not supported by the native connection.")
  if (bytes.byteLength > NATIVE_REQUEST_BYTES) throw new Error("The native request is too large.")
  return bytes
}

/** Use the browser's original fetch unchanged on the website. Installed builds
 * use only their constrained host-owned HTTPS adapter; failures never replay. */
export function apiFetch(path: string, init: RequestInit = {}, beforeNativeRequest?: () => void): Promise<Response> {
  const bridge = getNativeBridge()
  if (!bridge) return fetch(path, init)
  return nativeFetch(bridge, path, init, beforeNativeRequest)
}

async function nativeFetch(bridge: NativeBridge, path: string, init: RequestInit, beforeNativeRequest?: () => void): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase()
  if (!Object.hasOwn(ENDPOINT_METHODS, path) || !ENDPOINT_METHODS[path].includes(method)) throw new Error("This native endpoint is not allowed.")
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, name) => {
    if (!REQUEST_HEADERS.has(name) || value.length > 32 * 1024 || /[\r\n\0]/.test(value)) throw new Error("This native request header is not allowed.")
    headers[name] = value
  })
  init.signal?.throwIfAborted()
  const timeoutMs = path === "/api/files" ? 120_000 : path === "/api/plugins/summary" ? 35_000 : 30_000
  const controller = new AbortController()
  const abort = () => controller.abort(init.signal?.reason ?? new DOMException("The request was cancelled.", "AbortError"))
  init.signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error("The native connection took too long. Check your connection and retry.")), timeoutMs)
  const interrupted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
  })
  try {
    // Native I/O also has its own timeout. Cancelling here discards late replies;
    // it cannot retract a signed write already accepted by the relay.
    const result = await Promise.race([interrupted, (async () => {
      const body = await bodyBytes(init.body)
      if (method === "GET" && body !== undefined) throw new Error("A native GET request cannot have a body.")
      // Fail closed if identity, outbox, or privacy preferences cannot be made
      // durable. No signed request may outrun its local storage write.
      controller.signal.throwIfAborted()
      await flushNativeStorage()
      controller.signal.throwIfAborted()
      beforeNativeRequest?.()
      return bridge.request({ path, method, headers, ...(body === undefined ? {} : { bodyBase64: encode(body) }) })
    })()])
    controller.signal.throwIfAborted()
    if (!result || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || (result.status >= 300 && result.status < 400)) {
      throw new Error("The native connection returned an invalid response or redirect.")
    }
    const responseHeaders = new Headers()
    if (!result.headers || typeof result.headers !== "object" || Array.isArray(result.headers)) throw new Error("Invalid native response headers.")
    for (const [name, value] of Object.entries(result.headers)) {
      if (!RESPONSE_HEADERS.has(name.toLowerCase())) continue
      if (typeof value !== "string" || value.length > 32 * 1024 || /[\r\n\0]/.test(value)) throw new Error("Invalid native response headers.")
      responseHeaders.set(name, value)
    }
    const bytes = decode(result.bodyBase64)
    if ((result.status === 204 || result.status === 205) && bytes.length) throw new Error("Invalid native response body.")
    return new Response(result.status === 204 || result.status === 205 ? null : bytes, { status: result.status, headers: responseHeaders })
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener("abort", abort)
  }
}
