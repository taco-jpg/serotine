import { PUBLIC_KEY_PATTERN } from "./protocol"
import type { StoredEvent } from "./messaging-types"

/** Only already signature-validated records may establish a destruction cutoff. */
export function privateDestroyCutoffs(records: StoredEvent[], owner: string): Record<string, number> {
  const cutoffs: Record<string, number> = {}
  for (const record of records) {
    const event = record.event
    if (record.legacy || event.kind !== "private-destroy" || event.group || event.author === event.conversationId
      || !PUBLIC_KEY_PATTERN.test(event.author) || !PUBLIC_KEY_PATTERN.test(event.conversationId)
      || event.recipients.length !== 1 || event.recipients[0] !== event.conversationId
      || (event.author !== owner && event.conversationId !== owner)
      || !Number.isSafeInteger(event.payload.destroyBefore) || event.payload.destroyBefore! < 1
      || event.payload.destroyBefore! > event.timestamp) continue
    const cid = event.author === owner ? event.conversationId : event.author
    cutoffs[cid] = Math.max(cutoffs[cid] ?? 0, event.payload.destroyBefore!)
  }
  return cutoffs
}

export function isPrivateEventExpired(record: StoredEvent, owner: string, cutoffs: Record<string, number> = {}, now = Date.now()) {
  if (record.event.kind !== "private-message") return false
  const event = record.event
  const cid = event.author === owner ? event.conversationId : event.author
  return !Number.isSafeInteger(event.payload.expiresAt) || event.payload.expiresAt! <= now
    || event.timestamp <= (cutoffs[cid] ?? 0)
}

/** Retain only identifiers, never private text, for rejecting late edit payloads. */
export function privateMessageTarget(record: StoredEvent, owner: string, targetId = record.event.id) {
  const cid = record.event.conversationId.startsWith("group:") || record.event.author === owner ? record.event.conversationId : record.event.author
  return JSON.stringify([cid, targetId])
}
