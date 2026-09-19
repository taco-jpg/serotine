import { MAX_MESSAGE_LENGTH } from "./protocol"
import type { MessageRecord } from "./messaging-types"

export const MAX_SHARED_MESSAGES = 20
export interface SharedMessageItem {
  sender: string
  timestamp: number
  text: string
  attachment?: { name: string; mime: string; size: number }
}
export interface SharedMessages { version: 1; items: SharedMessageItem[] }
export interface ShareSource { conversationId: string; channelId?: string }
export interface ShareDestination { conversationId: string; channelId?: string }
const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))

export function canShareMessage(message: MessageRecord & { hidden?: boolean }): boolean {
  return !message.private && !message.secret && !message.expiresAt && !message.hidden && !message.shared
    && !["pending", "failed"].includes(message.delivery) && !!(message.content || message.attachment || message.poll)
}

/** Deliberate copy, not a proof of the quoted authorship. Never copies a media
 * capability, encryption key, source conversation ID, or private local alias. */
export function sharedMessagesFromSelection(messages: readonly (MessageRecord & { hidden?: boolean; channelId?: string })[], source: ShareSource, ids: readonly string[]): SharedMessages {
  if (!ids.length || ids.length > MAX_SHARED_MESSAGES || new Set(ids).size !== ids.length) throw new Error(`Select between 1 and ${MAX_SHARED_MESSAGES} different messages.`)
  const selected = ids.map(id => messages.find(message => message.id === id && message.conversationId === source.conversationId && message.channelId === source.channelId))
  if (selected.some(message => !message || !canShareMessage(message))) throw new Error("A selected message is no longer available to share. Review your selection.")
  const items = (selected as MessageRecord[]).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)).map(message => ({
    sender: `${message.senderPubKey.slice(0, 10)}…${message.senderPubKey.slice(-8)}`,
    timestamp: message.timestamp,
    text: message.poll ? `Poll: ${message.poll.question}\n${message.poll.options.map(option => `• ${option}`).join("\n")}` : message.content,
    ...(message.attachment ? { attachment: { name: message.attachment.name, mime: message.attachment.mime, size: message.attachment.size } } : {}),
  }))
  const bundle: SharedMessages = { version: 1, items }
  if (!validSharedMessages(bundle)) throw new Error("This selection is too large to share in one bundle. Select fewer messages.")
  return bundle
}

export function sharedMessagesFallback(bundle: SharedMessages): string {
  return `Shared copy · ${bundle.items.length} message${bundle.items.length === 1 ? "" : "s"}\nQuoted text is not proof of original authorship.\n\n` + bundle.items.map(item =>
    `${item.sender} · ${new Date(item.timestamp).toISOString()}\n${item.text}${item.attachment ? `\n[File metadata only: ${item.attachment.name} · ${item.attachment.size} bytes. File not included.]` : ""}`
  ).join("\n\n")
}

export function validSharedMessages(value: unknown): value is SharedMessages {
  if (!value || typeof value !== "object" || Array.isArray(value) || !keys(value, ["version", "items"])) return false
  const bundle = value as SharedMessages
  if (bundle.version !== 1 || !Array.isArray(bundle.items) || !bundle.items.length || bundle.items.length > MAX_SHARED_MESSAGES) return false
  for (const item of bundle.items) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !keys(item, ["sender", "timestamp", "text", "attachment"])
      || typeof item.sender !== "string" || !/^[a-f0-9]{10}…[a-f0-9]{8}$/.test(item.sender)
      || !Number.isSafeInteger(item.timestamp) || item.timestamp <= 0 || item.timestamp > 8_640_000_000_000_000
      || typeof item.text !== "string" || item.text.length > MAX_MESSAGE_LENGTH || (!item.text.trim() && !item.attachment)) return false
    if (item.attachment !== undefined) {
      const file = item.attachment
      if (!file || typeof file !== "object" || Array.isArray(file) || !keys(file, ["name", "mime", "size"])
        || typeof file.name !== "string" || !file.name.trim() || file.name.length > 255
        || typeof file.mime !== "string" || file.mime.length > 120
        || !Number.isSafeInteger(file.size) || file.size < 0) return false
    }
  }
  return sharedMessagesFallback(bundle).length <= MAX_MESSAGE_LENGTH
}
