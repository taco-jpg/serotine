import { arrayBufferToHex, verifySignature } from "./crypto"
import { ID_PATTERN, PUBLIC_KEY_PATTERN } from "./protocol"
import type { Identity } from "./identity"

export const DIRECT_FILE_BYTES = 2 * 1024 * 1024
export const DIRECT_SIGNAL_TTL = 60_000
export const DIRECT_NOTICE = "Both people must have Serotine open and connected. Messages and files travel directly. Offline delivery is unavailable, and the other person may learn your network address."
export type DeliveryMode = "relay" | "direct-only"
export interface DirectStatus { state: "idle" | "connecting" | "connected" | "unavailable" | "failed"; reason: string }
export interface DirectSignal {
  version: 1; policy: "direct-only"; session: string; sender: string; recipient: string
  kind: "offer" | "answer" | "close"; timestamp: number; expiresAt: number; sdp?: string; signature: string
}
export function directSignalText(signal: Omit<DirectSignal, "signature">) {
  return JSON.stringify(["serotine:direct:v1", signal.policy, signal.session, signal.sender, signal.recipient, signal.kind, signal.timestamp, signal.expiresAt, signal.sdp ?? null])
}
export function validDirectSdp(sdp: unknown): sdp is string {
  if (typeof sdp !== "string" || sdp.length > 16384 || !sdp.startsWith("v=0\r\n")) return false
  const lines = sdp.trim().split(/\r?\n/)
  if (lines.filter(line => line.startsWith("m=")).length !== 1 || !lines.some(line => /^m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel$/.test(line))) return false
  return lines.every(line => /^(v=0|o=\S+ \d+ \d+ IN IP[46] \S+|s=-|t=0 0|c=IN IP[46] \S+|m=application \d+ UDP\/DTLS\/SCTP webrtc-datachannel)$/.test(line)
    || /^a=(group:BUNDLE [\w -]+|msid-semantic: ?WMS(?: [\w*-]+)?|extmap-allow-mixed|ice-ufrag:[\w+/]+|ice-pwd:[\w+/]+|ice-options:[\w -]+|fingerprint:sha-256 [A-Fa-f0-9:]+|setup:(?:actpass|active|passive)|mid:[\w-]+|sctp-port:\d+|sctpmap:\d+ webrtc-datachannel \d+|(?:max-message-size):\d+|end-of-candidates)$/.test(line)
    || /^a=candidate:[\w+/]+ \d+ (?:udp|tcp|UDP|TCP) \d+ [\w.:%-]+ \d+ typ (?:host|srflx|prflx)(?: [\w.:%/-]+)*$/.test(line))
}
export async function signDirectSignal(signal: Omit<DirectSignal, "signature">, identity: Identity): Promise<DirectSignal> {
  const key = await crypto.subtle.importKey("jwk", { ...identity.privateKey, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  const signature = arrayBufferToHex(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(directSignalText(signal))))
  return { ...signal, signature }
}
export async function validDirectSignal(value: unknown, now = Date.now()): Promise<boolean> {
  try {
    const s = value as DirectSignal
    if (!s || s.version !== 1 || s.policy !== "direct-only" || !ID_PATTERN.test(s.session) || !PUBLIC_KEY_PATTERN.test(s.sender) || !PUBLIC_KEY_PATTERN.test(s.recipient) || s.sender === s.recipient
      || !["offer", "answer", "close"].includes(s.kind) || !Number.isSafeInteger(s.timestamp) || !Number.isSafeInteger(s.expiresAt)
      || s.timestamp > now + 30_000 || s.expiresAt <= now || s.expiresAt - s.timestamp > DIRECT_SIGNAL_TTL || s.expiresAt <= s.timestamp
      || Object.keys(s).some(key => !["version", "policy", "session", "sender", "recipient", "kind", "timestamp", "expiresAt", "sdp", "signature"].includes(key))
      || (s.kind === "close" ? s.sdp !== undefined : !validDirectSdp(s.sdp))) return false
    return await verifySignature(directSignalText(s), s.signature, s.sender)
  } catch { return false }
}
export function directIceConfiguration(servers: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }]): RTCConfiguration {
  if (servers.some(server => server.username !== undefined || server.credential !== undefined || (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => !/^stuns?:[^\s/?#@]+$/.test(url)))) throw new Error("Force P2P never permits TURN servers.")
  return { iceServers: servers, iceTransportPolicy: "all", bundlePolicy: "max-bundle" }
}
/** Candidate-pair evidence, never presence or connectionState alone. */
export function verifiedDirectPair(stats: RTCStatsReport): boolean {
  let selected: { state?: string; localCandidateId?: string; remoteCandidateId?: string } | undefined
  let explicit = false, ambiguous = false
  stats.forEach(row => {
    if (row.type === "transport" && row.selectedCandidatePairId) {
      if (explicit) ambiguous = true
      explicit = true; selected = stats.get(row.selectedCandidatePairId)
    }
  })
  if (!explicit) stats.forEach(row => { if (row.type === "candidate-pair" && row.nominated && row.state === "succeeded") { if (selected) ambiguous = true; selected = row } })
  if (ambiguous) return false
  if (!selected || selected.state !== "succeeded") return false
  if (!selected.localCandidateId || !selected.remoteCandidateId) return false
  const local = stats.get(selected.localCandidateId), remote = stats.get(selected.remoteCandidateId)
  return !!local && !!remote && [local.candidateType, remote.candidateType].every(type => ["host", "srflx", "prflx"].includes(type))
}
