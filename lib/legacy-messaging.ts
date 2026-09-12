import { prepareAttachment } from "./attachments"
import { validateAttachments, type MessageAttachment } from "./legacy-attachments"
import { ID_PATTERN, MAX_MESSAGE_LENGTH } from "./protocol"
import type { MessagingEvent } from "./messaging-types"

interface LegacyMessage {
  id: string; sender: string; recipient: string; timestamp: number; content: string
  attachments?: MessageAttachment[]
}

async function stableId(parts: string[]): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts))))
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** The migration and local deletion must use the same ID for old non-UUID rows. */
export async function legacyStoredMessageId(row: { peerPubKey: string; senderPubKey: string; id: string }) {
  if (ID_PATTERN.test(row.id)) return row.id
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${row.peerPubKey}:${row.senderPubKey}:${row.id}`)))
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
}

/** Locate a displayed legacy file without decoding or hashing its attachment bytes. */
export async function legacyVisibleMessageIds(message: LegacyMessage) {
  const ids = message.content.trim() || !message.attachments?.length ? [message.id] : []
  for (let index = 0; index < (message.attachments?.length ?? 0); index++) {
    ids.push(await stableId(["serotine:legacy-attachment:v1", message.sender, message.recipient, message.id, String(index), "manifest"]))
  }
  return ids
}

/** Saved history and relay envelopes use identical derived IDs, making conversion retryable. */
export async function legacyMessageEvents(message: LegacyMessage): Promise<MessagingEvent[]> {
  if (message.attachments !== undefined && !validateAttachments(message.attachments)) throw new Error("The saved message contains invalid attachments.")
  const base = { version: 3 as const, author: message.sender, conversationId: message.recipient, recipients: [message.recipient], timestamp: message.timestamp, signature: "" }
  const events: MessagingEvent[] = []
  // File-only envelopes must not create invalid empty text events in the outgoing queue.
  if (message.content.trim() || !message.attachments?.length) events.push({ ...base, id: message.id, kind: "message", payload: { content: message.content.slice(0, MAX_MESSAGE_LENGTH) } })
  for (const [index, attachment] of (message.attachments ?? []).entries()) {
    const namespace = ["serotine:legacy-attachment:v1", message.sender, message.recipient, message.id, String(index)]
    const binary = atob(attachment.data)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const { metadata, chunks } = await prepareAttachment(new File([bytes], attachment.name, { type: attachment.type }))
    metadata.id = await stableId([...namespace, "file"])
    // Store every piece before its visible manifest or acknowledgment of the old packet.
    for (const chunk of chunks) events.push({ ...base, id: await stableId([...namespace, "chunk", String(chunk.index)]), kind: "attachment-chunk", payload: { attachmentId: metadata.id, ...chunk } })
    events.push({ ...base, id: await stableId([...namespace, "manifest"]), kind: "attachment", payload: { attachment: metadata } })
  }
  return events
}
