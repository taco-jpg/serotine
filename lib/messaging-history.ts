import type { ConversationDeletion, MessagingPreferences, StoredEvent } from "./messaging-types"

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
