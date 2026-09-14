import { callIceConfiguration } from "./call-ice"
import { isStunUrl, type CallConfiguration } from "./call-protocol"

export interface CallTurnEnvironment { CALL_STUN_URLS?: string; CALL_TURN_KEY_ID?: string; CALL_TURN_API_TOKEN?: string }
export const CALL_TURN_TTL_SECONDS = 3_600

/** Called only after call:configuration authenticates. The permanent TURN-key
 * token stays in Worker secrets; only expiring ICE credentials reach browsers.
 * https://developers.cloudflare.com/realtime/turn/generate-credentials/ */
export async function callConfiguration(env: CallTurnEnvironment): Promise<CallConfiguration> {
  const now = Date.now()
  const urls = [...new Set((env.CALL_STUN_URLS ?? "stun:stun.cloudflare.com:3478").split(",").map(url => url.trim()).filter(isStunUrl))].slice(0, 4)
  const direct: RTCIceServer[] = urls.length ? [{ urls }] : []
  const fallback = (turnStatus: "not-configured" | "unavailable"): CallConfiguration => ({ iceServers: direct, relayAvailable: false, turnStatus, expiresAt: now + 60_000 })
  if (!env.CALL_TURN_KEY_ID && !env.CALL_TURN_API_TOKEN) return fallback("not-configured")
  if (!/^[a-fA-F0-9]{32}$/.test(env.CALL_TURN_KEY_ID ?? "") || !env.CALL_TURN_API_TOKEN) return fallback("unavailable")
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CALL_TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST", redirect: "error", cache: "no-store", signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.CALL_TURN_API_TOKEN}` },
      body: JSON.stringify({ ttl: CALL_TURN_TTL_SECONDS }),
    })
    if (!response.ok || !response.body) return fallback("unavailable")
    const reader = response.body.getReader(), bytes = new Uint8Array(16_384)
    let length = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (length + value.byteLength > bytes.length) { await reader.cancel(); throw new Error("Oversized TURN response") }
        bytes.set(value, length); length += value.byteLength
      }
    } finally { reader.releaseLock() }
    const result = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)))
    if (!Array.isArray(result?.iceServers)) return fallback("unavailable")
    // Cloudflare documents port 53 as browser-blocked; omit that alternate port.
    const filtered = result.iceServers.map((server: RTCIceServer) => ({ ...server,
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url => typeof url === "string" && !/:53(?:\?|$)/.test(url)),
    })).filter((server: RTCIceServer) => (server.urls as string[]).length)
    const managed = callIceConfiguration(filtered).iceServers!
    if (!managed.some(server => !!server.credential)) return fallback("unavailable")
    const iceServers = callIceConfiguration([...direct, ...managed]).iceServers!
    return { iceServers, relayAvailable: true, turnStatus: "ready", expiresAt: now + CALL_TURN_TTL_SECONDS * 1000 - 30_000 }
  } catch { return fallback("unavailable") }
  finally { clearTimeout(timeout); controller.abort() }
}
