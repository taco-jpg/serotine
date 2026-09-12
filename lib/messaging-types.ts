import type { Identity, Contact } from "./identity"

export type NotificationMode = "all" | "mentions" | "muted"
export type DeliveryStatus = "pending" | "sent" | "delivered" | "read" | "failed" | "received"
export type PrivateTtlSeconds = 0 | 300 | 3600 | 86400
export interface GroupState { id: string; name: string; admin: string; members: string[]; epoch: number; updatedAt: number; signature: string }
export interface AttachmentMeta { id: string; name: string; mime: string; size: number; chunks: number; sha256: string; kind: "file" | "voice"; duration?: number }
export interface PollState { question: string; options: string[]; votes: Record<string, number> }
export interface MessageRecord {
  id: string; conversationId: string; senderPubKey: string; content: string; timestamp: number
  delivery: DeliveryStatus; replyTo?: string; editedAt?: number; pinned: boolean
  attachment?: AttachmentMeta; poll?: PollState; mentions?: string[]; error?: string
  deliveredTo: string[]; readBy: string[]
  private?: boolean; expiresAt?: number; secret?: boolean
}
export interface ConversationRecord {
  id: string; kind: "direct" | "group" | "self"; name: string; members: string[]
  unreadCount: number; lastMessage?: MessageRecord; updatedAt: number; notificationMode: NotificationMode
  blocked: boolean; request: boolean; archived: boolean; group?: GroupState; sendError?: string
  privateTtlSeconds?: PrivateTtlSeconds
}
export interface ConversationDeletion {
  deletedAt: number; eventKeys: string[]; attachmentIds?: string[]; group?: GroupState; leftMembers?: string[]
}
export interface MessageDeletion extends ConversationDeletion {
  messageIds: string[]; legacyKeys?: string[]; attachmentKeys?: string[]
  groupEvents?: Array<{ key: string; group: GroupState; receivedAt: number; timestamp: number; sequence?: number }>
}
export interface MessagingPreferences {
  accepted: string[]; blocked: string[]; notifications: Record<string, NotificationMode>; readAt: Record<string, number>; readReceipts: boolean
  archived: string[]; deleted: Record<string, ConversationDeletion>; deletedMessages: Record<string, MessageDeletion>
}
export type EventKind = "message" | "edit" | "pin" | "poll" | "vote" | "receipt" | "group" | "leave" | "attachment" | "attachment-chunk" | "private-settings" | "private-message" | "private-destroy"
export interface EventPayload {
  content?: string; replyTo?: string; mentions?: string[]; targetId?: string; pinned?: boolean
  question?: string; options?: string[]; option?: number; receipt?: "delivered" | "read"
  attachment?: AttachmentMeta; attachmentId?: string; index?: number; data?: string
  ttlSeconds?: PrivateTtlSeconds; expiresAt?: number; secret?: boolean; destroyBefore?: number
}
export interface MessagingEvent {
  version: 3; id: string; author: string; conversationId: string; recipients: string[]; timestamp: number
  kind: EventKind; payload: EventPayload; group?: GroupState; signature: string
}
export interface StoredEvent {
  key: string; event: MessagingEvent; local: boolean; delivered: string[]; error?: string; failedRecipients?: string[]
  receivedAt: number; legacy?: boolean; sequence?: number
}
export interface MessagingSnapshot { version: 3; owner: string; events: StoredEvent[]; preferences: MessagingPreferences }
export interface MessagingModel { conversations: ConversationRecord[]; messages: MessageRecord[]; groups: GroupState[]; requests: ConversationRecord[] }
export interface MessagingContextValue extends MessagingModel {
  identity: Identity | null; contacts: Contact[]; ready: boolean; error: string | null; status: "connecting" | "online" | "offline"; preferences: MessagingPreferences
  sendText: (conversationId: string, text: string, replyTo?: string, mentions?: string[], expectedPrivateTtlSeconds?: PrivateTtlSeconds) => Promise<string>
  getPrivateMode: (conversationId: string) => PrivateTtlSeconds
  setPrivateMode: (conversationId: string, ttlSeconds: PrivateTtlSeconds) => Promise<void>
  destroyPrivateHistory: (conversationId: string) => Promise<void>
  sendSecret: (conversationId: string, text: string, ttlSeconds?: number) => Promise<string>
  editMessage: (conversationId: string, messageId: string, text: string) => Promise<void>
  deleteMessage: (conversationId: string, messageId: string) => Promise<void>
  pinMessage: (conversationId: string, messageId: string, pinned: boolean) => Promise<void>
  createPoll: (conversationId: string, question: string, options: string[]) => Promise<string>
  vote: (conversationId: string, messageId: string, option: number) => Promise<void>
  createGroup: (name: string, members: string[]) => Promise<string>
  updateGroup: (conversationId: string, changes: { name?: string; members?: string[] }) => Promise<void>
  leaveGroup: (conversationId: string) => Promise<void>
  archiveConversation: (conversationId: string, archived?: boolean) => Promise<void>
  deleteConversation: (conversationId: string) => Promise<void>
  acceptRequest: (conversationId: string) => Promise<void>
  blockContact: (publicKey: string, blocked?: boolean) => Promise<void>
  markRead: (conversationId: string) => Promise<void>
  setNotificationMode: (conversationId: string, mode: NotificationMode) => Promise<void>
  setReadReceipts: (enabled: boolean) => Promise<void>
  requestNotifications: () => Promise<NotificationPermission>
  retry: (messageId?: string) => Promise<void>
  sync: () => Promise<void>
  sendEvent: (conversationId: string, kind: EventKind, payload: EventPayload) => Promise<string>
  getAttachmentChunks: (conversationId: string, messageId: string) => Array<{ index: number; data: string }>
  refresh: () => Promise<void>
}
