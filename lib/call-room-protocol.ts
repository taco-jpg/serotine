import type { GroupState } from "./messaging-types"
import type { CommunityState } from "./community-types"
import { communityChannelKey, isCommunityChannelKey } from "./community-protocol"
import { isCallId, isCallObject, isCallPayload, isCallPeer, CALL_PACKET_LIMIT, type CallSignalPayload, type CallRoutingPolicy } from "./call-protocol"

export const CALL_ROOM_LIMIT = 8
export const CALL_ROOM_LEASE_MS = 30_000
export type CallRoomTarget = { kind: "group"; group: GroupState } | { kind: "channel"; community: CommunityState; channelId: string }
export type CallRoomPayload = Exclude<CallSignalPayload, { kind: "invite" | "accept" }>
export interface CallRoomParticipant { publicKey: string; sessionId: string; mode: "voice" | "video"; policy: CallRoutingPolicy; joinedAt: number; expiresAt: number }
export interface CallRoomState { roomId: string; participants: CallRoomParticipant[]; limit: number }
export interface CallRoomSignal {
  id: string; roomId: string; sender: string; recipient: string; senderSession: string; targetSession: string; expiresAt: number; payload: CallRoomPayload
}
export interface EncryptedCallRoomSignal extends Omit<CallRoomSignal, "payload"> { encryptedData: string; sequence?: number }
/** A random group ID alone is not an authority: bind the room to its signed admin. */
export function callRoomId(target: CallRoomTarget): string {
  return target.kind === "group" ? `${target.group.id}:admin:${target.group.admin}` : communityChannelKey(target.community.id, target.channelId)
}
export function isCallRoomId(value: unknown): value is string {
  if (typeof value !== "string") return false
  const parts = value.split(":admin:")
  return isCommunityChannelKey(value) || (parts.length === 2 && parts[0].startsWith("group:") && isCallId(parts[0].slice(6)) && isCallPeer(parts[1]))
}
export function isCallRoomPayload(value: unknown): value is CallRoomPayload {
  return isCallPayload(value) && value.kind !== "invite" && value.kind !== "accept"
}
export function isCallRoomParticipant(value: unknown): value is CallRoomParticipant {
  return isCallObject(value) && isCallPeer(value.publicKey) && isCallId(value.sessionId) && ["voice", "video"].includes(String(value.mode))
    && ["all", "relay"].includes(String(value.policy)) && [value.joinedAt, value.expiresAt].every(n => Number.isSafeInteger(n) && Number(n) > 0)
}
export function isCallRoomState(value: unknown): value is CallRoomState {
  return isCallObject(value) && isCallRoomId(value.roomId) && value.limit === CALL_ROOM_LIMIT && Array.isArray(value.participants)
    && value.participants.length <= CALL_ROOM_LIMIT && value.participants.every(isCallRoomParticipant)
    && new Set(value.participants.map(p => p.publicKey)).size === value.participants.length
}
export function isEncryptedCallRoomSignal(value: unknown): value is EncryptedCallRoomSignal {
  return isCallObject(value) && isCallId(value.id) && isCallRoomId(value.roomId) && isCallPeer(value.sender) && isCallPeer(value.recipient)
    && value.sender !== value.recipient && isCallId(value.senderSession) && isCallId(value.targetSession) && Number.isSafeInteger(value.expiresAt)
    && typeof value.encryptedData === "string" && value.encryptedData.length >= 32 && value.encryptedData.length <= CALL_PACKET_LIMIT
}
