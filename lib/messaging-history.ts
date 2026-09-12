import type { ConversationDeletion, MessageDeletion, MessagingPreferences, StoredEvent } from "./messaging-types"

export function storedConversationId(record: StoredEvent, owner: string) {
  const event = record.event
  return event.conversationId.startsWith("group:") ? event.conversationId : event.author === owner ? event.conversationId : event.author
}

/** Deletion boundaries stay in place after a new message reopens the chat. */
export function isDeletedConversationEvent(record: StoredEvent, owner: string, preferences: Pick<MessagingPreferences, "deleted">) {
  // Membership changes must still reach peers after local history is deleted.
  if (record.event.kind === "group" || record.event.kind === "leave") return false
  const deletion = preferences.deleted?.[storedConversationId(record, owner)]
  const attachmentId = record.event.payload.attachmentId ?? record.event.payload.attachment?.id
  return !!deletion && (record.event.timestamp <= deletion.deletedAt || deletion.eventKeys.includes(record.key) || !!(attachmentId && deletion.attachmentIds?.includes(attachmentId)))
}

/** Individual deletions match IDs, never a time boundary or later messages. */
export function isDeletedMessageEvent(record: StoredEvent, owner: string, preferences: Pick<MessagingPreferences, "deletedMessages">) {
  if (record.event.kind === "group" || record.event.kind === "leave") return false
  const deletion = preferences.deletedMessages?.[storedConversationId(record, owner)]
  if (!deletion) return false
  const event = record.event
  const attachmentId = event.payload.attachmentId ?? event.payload.attachment?.id
  return deletion.messageIds.includes(event.id) || !!(event.payload.targetId && deletion.messageIds.includes(event.payload.targetId))
    || deletion.eventKeys.includes(record.key) || !!(attachmentId && deletion.attachmentKeys?.includes(legacyMessageKey(event.author, attachmentId)))
}

export function isDeletedStoredEvent(record: StoredEvent, owner: string, preferences: MessagingPreferences) {
  return isDeletedConversationEvent(record, owner, preferences) || isDeletedMessageEvent(record, owner, preferences)
}

export function legacyMessageKey(senderPubKey: string, id: string) { return JSON.stringify([senderPubKey, id]) }

export function isDeletedLegacyMessage(row: { peerPubKey: string; senderPubKey: string; id: string; timestamp: number }, preferences: MessagingPreferences) {
  const conversation = preferences.deleted?.[row.peerPubKey]
  return !!(conversation && row.timestamp <= conversation.deletedAt)
    || !!preferences.deletedMessages?.[row.peerPubKey]?.legacyKeys?.includes(legacyMessageKey(row.senderPubKey, row.id))
}

export function mergeConversationDeletions(incoming: MessagingPreferences["deleted"] = {}, existing: MessagingPreferences["deleted"] = {}) {
  const merged: Record<string, ConversationDeletion> = { ...incoming }
  for (const [cid, local] of Object.entries(existing)) {
    const remote = merged[cid]
    if (!remote) { merged[cid] = local; continue }
    const latest = local.deletedAt >= remote.deletedAt ? local : remote
    // Existing group authority cannot be replaced by importing a different admin.
    const group = local.group && (!remote.group || local.group.admin !== remote.group.admin || local.group.epoch >= remote.group.epoch) ? local.group : remote.group
    const leftMembers = group ? [...new Set([...(local.group?.signature === group.signature ? local.leftMembers ?? [] : []), ...(remote.group?.signature === group.signature ? remote.leftMembers ?? [] : [])])] : undefined
    merged[cid] = { ...latest, eventKeys: [...new Set([...remote.eventKeys, ...local.eventKeys])], attachmentIds: [...new Set([...(remote.attachmentIds ?? []), ...(local.attachmentIds ?? [])])], ...(group ? { group, leftMembers } : {}) }
  }
  return merged
}

export function mergeMessageDeletions(incoming: MessagingPreferences["deletedMessages"] = {}, existing: MessagingPreferences["deletedMessages"] = {}) {
  const merged = mergeConversationDeletions(incoming, existing) as Record<string, MessageDeletion>
  for (const cid of Object.keys(merged)) merged[cid] = { ...merged[cid],
    messageIds: [...new Set([...(incoming[cid]?.messageIds ?? []), ...(existing[cid]?.messageIds ?? [])])],
    attachmentKeys: [...new Set([...(incoming[cid]?.attachmentKeys ?? []), ...(existing[cid]?.attachmentKeys ?? [])])],
    groupEvents: [...new Map([...(incoming[cid]?.groupEvents ?? []), ...(existing[cid]?.groupEvents ?? [])].map(checkpoint => [checkpoint.key, checkpoint])).values()],
    legacyKeys: [...new Set([...(incoming[cid]?.legacyKeys ?? []), ...(existing[cid]?.legacyKeys ?? [])])] }
  return merged
}
