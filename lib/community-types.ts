import type { MessageRecord, NotificationMode } from "./messaging-types"

export type CommunityAdmission = "direct" | "approval"
export interface CommunityChannel { id: string; name: string; posting: "members" | "moderators" }
export interface CommunityState {
  id: string; owner: string; name: string; description: string; epoch: number; updatedAt: number
  members: string[]; moderators: string[]; bans: string[]; channels: CommunityChannel[]
  admission: CommunityAdmission; joiningPaused: boolean; inviteGeneration: number; signature: string
}
export interface CommunityInvite {
  version: 1; communityId: string; owner: string; name: string; description: string
  admission: CommunityAdmission; history: "after-join"; inviteGeneration: number
  token: string; expiresAt: number; signature: string
}
export type CommunityCommandAction = "approve" | "reject" | "remove" | "ban" | "unban"
export type CommunityEventData =
  | { type: "state"; state: CommunityState; requestId?: string; commandId?: string }
  | { type: "join"; invite: CommunityInvite }
  | { type: "decision"; requestId: string; applicant: string; status: "rejected"; reason?: string; commandId?: string }
  | { type: "command"; epoch: number; action: CommunityCommandAction; target: string; requestId?: string }
  | { type: "leave"; epoch: number }
  | { type: "message"; epoch: number; channelId: string; content: string; replyTo?: string; mentions?: string[] }
  | { type: "hide"; epoch: number; channelId: string; targetId: string }
  | { type: "report"; epoch: number; channelId: string; targetId: string; reason: string }

export interface CommunityMessage extends MessageRecord { channelId: string; hidden: boolean }
export interface CommunityRecord extends CommunityState {
  joined: boolean; effectiveMembers: string[]; unreadCount: number; updatedAt: number; lastMessage?: CommunityMessage
  notificationMode: NotificationMode; channelUnread: Record<string, number>
}
export interface CommunityJoinRequest {
  id: string; communityId: string; author: string; timestamp: number; invite: CommunityInvite
  status: "pending" | "approved" | "rejected"; reason?: string
}
export interface CommunityReport { id: string; communityId: string; author: string; channelId: string; targetId: string; reason: string; timestamp: number }
export interface CommunityCommand {
  id: string; communityId: string; author: string; timestamp: number; epoch: number
  action: CommunityCommandAction | "leave"; target: string; requestId?: string
}
export interface CommunityModel {
  communities: CommunityRecord[]; messages: CommunityMessage[]; requests: CommunityJoinRequest[]
  reports: CommunityReport[]; commands: CommunityCommand[]; processedIds: string[]
}
