import { ID_PATTERN, PUBLIC_KEY_PATTERN } from "./protocol"

// Bound small clock/latency differences without disabling expiry or replay checks.
export const CALL_CLOCK_SKEW_MS = 5_000
export const CALL_INVITE_TTL_MS = 40_000
// Offer/answer/ICE packets are deliberately short-lived. Reliability comes from
// WSS wakeups plus a substantially faster fallback resync, not longer-lived
// negotiation material.
export const CALL_SIGNAL_TTL_MS = 30_000
// Presence and active-call leases intentionally outlive the fallback refresh.
// WSS change pushes still trigger immediate resync; these TTLs only absorb timer
// throttling or a missed renewal without returning to an 8s D1 write cadence.
export const CALL_PRESENCE_TTL_MS = 120_000
export const CALL_LEASE_TTL_MS = 120_000
export const CALL_PAGE_SIZE = 64
export const CALL_PACKET_LIMIT = 96_000
/** The legacy relay value is decoded only so updated clients can reject it explicitly. */
export type CallRoutingPolicy = "all" | "relay"
export type CallEndReason = "ended" | "cancelled" | "declined" | "busy" | "unanswered" | "failed"
export type CallSignalPayload =
  | { kind: "invite"; mode: "voice" | "video"; policy: CallRoutingPolicy; private: boolean }
  | { kind: "accept"; mode: "voice" | "video"; private: boolean }
  | { kind: "offer" | "answer"; description: RTCSessionDescriptionInit }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "restart" }
  | { kind: "media-state"; muted: boolean; camera: boolean; private: boolean }

/** These objects live only in memory and the transient call relay, never the message event store. */
export interface CallSession {
  callId: string
  caller: string
  recipient: string
  callerSession: string
  recipientSession: string | null
  status: "ringing" | "active" | "ended"
  createdAt: number
  inviteExpiresAt: number
  expiresAt: number
  reason: CallEndReason | null
  noHistory: boolean
}
export interface CallSignal {
  id: string
  callId: string
  sender: string
  recipient: string
  senderSession: string
  targetSession: string | null
  expiresAt: number
  payload: CallSignalPayload
}
export interface EncryptedCallSignal extends Omit<CallSignal, "payload"> {
  encryptedData: string
  sequence?: number
}
export interface CallConfiguration { iceServers: RTCIceServer[]; relayAvailable: boolean; expiresAt: number; turnStatus?: "ready" | "not-configured" | "unavailable" }
/** RFC 7064 server URI without userinfo, paths, query parameters or credentials. */
export function isStunUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false
  const match = /^stuns?:([^\s/?#@]+)$/.exec(value)
  if (!match) return false
  const endpoint = /^(\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(match[1])
  if (!endpoint || (endpoint[2] !== undefined && (Number(endpoint[2]) < 1 || Number(endpoint[2]) > 65535))) return false
  const host = endpoint[1]
  if (!host.startsWith("[")) return host.length <= 253 && host.split(".").every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  try { return new URL(`https://${host}`).hostname === host.toLowerCase() } catch { return false }
}
export const isCallId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value)
export const isCallPeer = (value: unknown): value is string => typeof value === "string" && PUBLIC_KEY_PATTERN.test(value)
export const isCallObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
export const isCallReason = (value: unknown): value is CallEndReason => ["ended", "cancelled", "declined", "busy", "unanswered", "failed"].includes(String(value))
export function isCallPayload(value: unknown): value is CallSignalPayload {
  if (!isCallObject(value)) return false
  if (value.kind === "invite") return ["voice", "video"].includes(String(value.mode)) && ["all", "relay"].includes(String(value.policy)) && typeof value.private === "boolean"
  if (value.kind === "accept") return ["voice", "video"].includes(String(value.mode)) && typeof value.private === "boolean"
  if (value.kind === "restart") return Object.keys(value).length === 1
  if (value.kind === "offer" || value.kind === "answer") return isCallObject(value.description) && value.description.type === value.kind
    && typeof value.description.sdp === "string" && value.description.sdp.length <= 48_000
  if (value.kind === "ice") return isCallObject(value.candidate) && typeof value.candidate.candidate === "string" && value.candidate.candidate.length <= 8_000
    && (value.candidate.sdpMid === undefined || value.candidate.sdpMid === null || typeof value.candidate.sdpMid === "string")
    && (value.candidate.sdpMLineIndex === undefined || value.candidate.sdpMLineIndex === null || Number.isSafeInteger(value.candidate.sdpMLineIndex))
  return value.kind === "media-state" && typeof value.muted === "boolean" && typeof value.camera === "boolean" && typeof value.private === "boolean"
}
export function isCallSession(value: unknown): value is CallSession {
  if (!isCallObject(value)) return false
  return isCallId(value.callId) && isCallPeer(value.caller) && isCallPeer(value.recipient) && value.caller !== value.recipient
    && isCallId(value.callerSession) && (value.recipientSession === null || isCallId(value.recipientSession))
    && ["ringing", "active", "ended"].includes(String(value.status))
    && [value.createdAt, value.inviteExpiresAt, value.expiresAt].every(n => Number.isSafeInteger(n) && Number(n) > 0)
    && (value.reason === null || isCallReason(value.reason)) && typeof value.noHistory === "boolean"
}
export function isEncryptedCallSignal(value: unknown): value is EncryptedCallSignal {
  return isCallObject(value) && isCallId(value.id) && isCallId(value.callId) && isCallPeer(value.sender) && isCallPeer(value.recipient)
    && value.sender !== value.recipient && isCallId(value.senderSession) && (value.targetSession === null || isCallId(value.targetSession))
    && Number.isSafeInteger(value.expiresAt) && typeof value.encryptedData === "string" && value.encryptedData.length >= 32 && value.encryptedData.length <= CALL_PACKET_LIMIT
}
