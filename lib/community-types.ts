import type { SharedMessages } from "./shared-messages"
import type { AttachmentMeta, MessageRecord, NotificationMode } from "./messaging-types"

export type CommunityAdmission = "direct" | "approval"
export interface CommunityChannel {
  id: string; name: string; posting: "members" | "moderators"
  /** Missing on previously signed communities; omission continues to mean text. */
  kind?: "text" | "voice"
}
export interface CommunityTransfer {
  from: string; to: string; epoch: number; previous: string; stateHash: string; signature: string
}
export interface CommunitySettingsChanges {
  name?: string; description?: string; admission?: CommunityAdmission; joiningPaused?: boolean; channels?: CommunityChannel[]
}
export interface CommunityState {
  id: string; owner: string; name: string; description: string; epoch: number; updatedAt: number
  members: string[]; moderators: string[]; bans: string[]; channels: CommunityChannel[]
  admission: CommunityAdmission; joiningPaused: boolean; inviteGeneration: number; signature: string
  version?: 2; coOwners?: string[]; transfers?: CommunityTransfer[]; signer?: string; deleted?: boolean
}
export interface CommunityInvite {
  version: 1 | 2; communityId: string; owner: string; name: string; description: string
  admission: CommunityAdmission; history: "after-join"; inviteGeneration: number
  token: string; expiresAt: number; signature: string
  transfers?: CommunityTransfer[]
}
export type CommunityCommandAction = "approve" | "reject" | "remove" | "ban" | "unban" | "promote" | "demote" | "update" | "revoke-invites"
export type CommunityEventData =
  | { type: "state"; state: CommunityState; requestId?: string; commandId?: string }
  | { type: "join"; invite: CommunityInvite }
  | { type: "decision"; requestId: string; applicant: string; status: "rejected"; reason?: string; commandId?: string; stateRef?: string; transfers?: CommunityTransfer[] }
  | { type: "command"; epoch: number; action: CommunityCommandAction; target: string; requestId?: string; changes?: CommunitySettingsChanges; stateRef?: string }
  | { type: "leave"; epoch: number; stateRef?: string }
  | { type: "message"; epoch: number; channelId: string; content: string; shared?: SharedMessages; replyTo?: string; mentions?: string[]; stateRef?: string }
  | { type: "attachment"; epoch: number; channelId: string; attachment: AttachmentMeta; content?: string; replyTo?: string; mentions?: string[]; stateRef?: string }
  | { type: "attachment-chunk"; epoch: number; channelId: string; attachmentId: string; index: number; data: string; stateRef?: string }
  | { type: "edit"; epoch: number; channelId: string; targetId: string; content: string; stateRef?: string }
  | { type: "pin"; epoch: number; channelId: string; targetId: string; pinned: boolean; stateRef?: string }
  | { type: "poll"; epoch: number; channelId: string; question: string; options: string[]; stateRef?: string }
  | { type: "vote"; epoch: number; channelId: string; targetId: string; option: number; stateRef?: string }
  | { type: "receipt"; epoch: number; channelId: string; targetId: string; receipt: "delivered" | "read"; stateRef?: string }
  | { type: "hide"; epoch: number; channelId: string; targetId: string; stateRef?: string }
  | { type: "report"; epoch: number; channelId: string; targetId: string; reason: string; stateRef?: string }

export interface CommunityMessage extends MessageRecord { channelId: string; hidden: boolean }
export interface CommunityRecord extends CommunityState {
  joined: boolean; effectiveMembers: string[]; unreadCount: number; updatedAt: number; activityAt?: number; lastMessage?: CommunityMessage
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
  changes?: CommunitySettingsChanges; stateRef?: string
}
export interface CommunityModel {
  communities: CommunityRecord[]; messages: CommunityMessage[]; requests: CommunityJoinRequest[]
  reports: CommunityReport[]; commands: CommunityCommand[]; processedIds: string[]; acceptedKeys: string[]
}
