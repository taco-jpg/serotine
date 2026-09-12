import { openDB, type DBSchema, type IDBPTransaction } from "idb"
import { ID_PATTERN, PUBLIC_KEY_PATTERN } from "./protocol"
import type { MessagingPreferences, MessagingSnapshot, StoredEvent } from "./messaging-types"
import { isDeletedStoredEvent, legacyMessageKey, mergeConversationDeletions, mergeMessageDeletions, storedConversationId } from "./messaging-history"
import { isPrivateEventExpired, privateDestroyCutoffs, privateMessageTarget } from "./private-messaging"
export { isDeletedConversationEvent } from "./messaging-history"

interface MessagingDB extends DBSchema {
  events: { key: string; value: StoredEvent }
  metadata: { key: string; value: unknown }
}
export const defaultMessagingPreferences = (): MessagingPreferences => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true, archived: [], deleted: {}, deletedMessages: {} })
function withDefaults(value?: Partial<MessagingPreferences>): MessagingPreferences {
  return { ...defaultMessagingPreferences(), ...value, archived: value?.archived ?? [], deleted: value?.deleted ?? {}, deletedMessages: value?.deletedMessages ?? {} }
}
async function database(owner: string) {
  if (!PUBLIC_KEY_PATTERN.test(owner)) throw new Error("A valid identity is required.")
  return openDB<MessagingDB>(`serotine-events:${owner}`, 1, { upgrade(db) { db.createObjectStore("events", { keyPath: "key" }); db.createObjectStore("metadata") } })
}
export function eventStorageKey(event: { author: string; conversationId: string; id: string }) { return `${event.author}:${event.conversationId}:${event.id}` }
type EventTransaction = IDBPTransaction<MessagingDB, ["events", "metadata"], "readwrite">
const verifiedPrivate = new Map<string, string>()
async function validatePrivateRecord(record: StoredEvent, owner: string) {
  if (record.legacy || record.key !== eventStorageKey(record.event) || (record.event.author !== owner && !record.event.recipients.includes(owner))) return false
  // Private content must never survive in a module-level validation cache.
  const text = record.event.kind === "private-message" ? undefined : JSON.stringify(record.event)
  if (text !== undefined && verifiedPrivate.get(record.event.signature) === text) return true
  const { validateMessagingEvent } = await import("./messaging")
  if (!await validateMessagingEvent(record.event)) return false
  if (verifiedPrivate.size >= 2000) verifiedPrivate.clear()
  if (text !== undefined) verifiedPrivate.set(record.event.signature, text)
  return true
}
function mergeCutoffs(left: Record<string, number>, right: Record<string, number>) {
  const result = { ...left }
  for (const [cid, time] of Object.entries(right)) result[cid] = Math.max(result[cid] ?? 0, time)
  return result
}
async function privateState(tx: EventTransaction) {
  return {
    cutoffs: (await tx.objectStore("metadata").get("private-cutoffs") ?? {}) as Record<string, number>,
    targets: new Set((await tx.objectStore("metadata").get("private-targets") ?? []) as string[]),
  }
}
function privateEdit(record: StoredEvent, owner: string, targets: Set<string>) {
  return record.event.kind === "edit" && !!record.event.payload.targetId && targets.has(privateMessageTarget(record, owner, record.event.payload.targetId))
}
async function savePrivateState(tx: EventTransaction, state: Awaited<ReturnType<typeof privateState>>) {
  await tx.objectStore("metadata").put(state.cutoffs, "private-cutoffs")
  await tx.objectStore("metadata").put([...state.targets], "private-targets")
}
async function readPrunedEvents(owner: string, now: number) {
  const db = await database(owner)
  let removed = 0
  try {
    // Signature work must finish before opening the write transaction. IndexedDB
    // transactions auto-close while unrelated asynchronous crypto is running.
    const initial = await db.getAll("events")
    const validPrivate: StoredEvent[] = []
    for (const record of initial) if (record.event.kind.startsWith("private-") && await validatePrivateRecord(record, owner)) validPrivate.push(record)
    const tx = db.transaction(["events", "metadata"], "readwrite")
    try {
      const state = await privateState(tx)
      const cutoffs = mergeCutoffs(state.cutoffs, privateDestroyCutoffs(validPrivate, owner))
      const targets = new Set([...state.targets, ...validPrivate.filter(record => record.event.kind === "private-message").map(record => privateMessageTarget(record, owner))])
      const records = await tx.objectStore("events").getAll()
      const retained: StoredEvent[] = []
      for (const record of records) {
        if (isPrivateEventExpired(record, owner, cutoffs, now) || privateEdit(record, owner, targets)) {
          await tx.objectStore("events").delete(record.key); removed++
        } else retained.push(record)
      }
      if (targets.size !== state.targets.size || JSON.stringify(cutoffs) !== JSON.stringify(state.cutoffs)) await savePrivateState(tx, { cutoffs, targets })
      await tx.done
      return { records: retained, removed }
    } catch (error) { try { tx.abort() } catch { /* Already closed. */ } await tx.done.catch(() => {}); throw error }
  } finally { db.close() }
}

/** Physically remove expired payloads, including when an idle tab resumes. */
export async function pruneExpiredPrivateEvents(owner: string, now = Date.now()): Promise<number> {
  const { removed } = await readPrunedEvents(owner, now)
  if (removed) changed(owner)
  return removed
}
function changed(owner: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("serotine:events", { detail: { owner } }))
}
export async function getStoredEvents(owner: string): Promise<StoredEvent[]> {
  return (await readPrunedEvents(owner, Date.now())).records
}
export async function saveStoredEvent(owner: string, record: StoredEvent) {
  // Callers cannot establish a destructive boundary using an unverified event.
  if (record.event.kind.startsWith("private-") && !await validatePrivateRecord(record, owner)) throw new Error("The private conversation event is invalid.")
  const db = await database(owner)
  try {
    const tx = db.transaction(["events", "metadata"], "readwrite")
    try {
    const preferences = withDefaults(await tx.objectStore("metadata").get("preferences") as Partial<MessagingPreferences> | undefined)
    const existing = await tx.objectStore("events").get(record.key)
    // Check before a destruction event can remove the conflicting original.
    if (existing && JSON.stringify(existing.event) !== JSON.stringify(record.event)) throw new Error("Conflicting message identifier.")
    if (record.event.kind.startsWith("private-") || record.event.kind === "edit") {
      const state = await privateState(tx)
      if (record.event.kind === "private-message") state.targets.add(privateMessageTarget(record, owner))
      if (record.event.kind === "private-destroy") state.cutoffs = mergeCutoffs(state.cutoffs, privateDestroyCutoffs([record], owner))
      if (record.event.kind === "private-message" || record.event.kind === "private-destroy") {
        await savePrivateState(tx, state)
        for (const existing of await tx.objectStore("events").getAll()) if (isPrivateEventExpired(existing, owner, state.cutoffs) || privateEdit(existing, owner, state.targets)) await tx.objectStore("events").delete(existing.key)
      }
      if (isPrivateEventExpired(record, owner, state.cutoffs) || privateEdit(record, owner, state.targets)) { await tx.done; return false }
    }
    // Check and write in one transaction: an old relay response or retry cannot
    // put deleted content back after the delete transaction has committed.
    if (isDeletedStoredEvent(record, owner, preferences)) { await tx.done; return false }
    // An event is immutable. A retry may only add per-recipient confirmations.
    const value = existing ? { ...existing, ...record, local: existing.local || record.local, receivedAt: Math.min(existing.receivedAt, record.receivedAt), sequence: existing.sequence === undefined ? record.sequence : record.sequence === undefined ? existing.sequence : Math.min(existing.sequence, record.sequence), delivered: [...new Set([...existing.delivered, ...record.delivered])] } : record
    await tx.objectStore("events").put(value)
    await tx.done
    } catch (error) { try { tx.abort() } catch { /* The transaction may already have aborted. */ } await tx.done.catch(() => {}); throw error }
  } finally { db.close() }
  changed(owner)
  return true
}
export async function getMessagingPreferences(owner: string): Promise<MessagingPreferences> {
  const db = await database(owner)
  try { return withDefaults(await db.get("metadata", "preferences") as Partial<MessagingPreferences> | undefined) } finally { db.close() }
}
export async function saveMessagingPreferences(owner: string, preferences: MessagingPreferences) {
  const db = await database(owner)
  try {
    const tx = db.transaction("metadata", "readwrite")
    const old = withDefaults(await tx.store.get("preferences") as Partial<MessagingPreferences> | undefined)
    await tx.store.put({ ...withDefaults(preferences), deleted: mergeConversationDeletions(preferences.deleted, old.deleted), deletedMessages: mergeMessageDeletions(preferences.deletedMessages, old.deletedMessages) }, "preferences")
    await tx.done
  } finally { db.close() }
  changed(owner)
}
export async function getSyncCursor(owner: string): Promise<number> {
  const db = await database(owner)
  try { return Number(await db.get("metadata", "cursor")) || 0 } finally { db.close() }
}
export async function saveSyncCursor(owner: string, cursor: number) {
  const db = await database(owner)
  try { await db.put("metadata", cursor, "cursor") } finally { db.close() }
}
export async function exportMessagingSnapshot(owner: string): Promise<MessagingSnapshot> {
  const [events, preferences] = await Promise.all([getStoredEvents(owner), getMessagingPreferences(owner)])
  // Excluding orphan edits also prevents a late private edit from being copied
  // into a backup after its original private message has already disappeared.
  const publicTargets = new Set(events.filter(record => record.event.kind === "message").map(record => privateMessageTarget(record, owner)))
  return { version: 3, owner, events: events.filter(record => record.event.kind !== "private-message" && !isDeletedStoredEvent(record, owner, preferences)
    && (record.event.kind !== "edit" || !!record.event.payload.targetId && publicTargets.has(privateMessageTarget(record, owner, record.event.payload.targetId)))), preferences }
}
export async function deleteStoredConversation(owner: string, cid: string) {
  if (!validConversation(cid)) throw new Error("Choose a valid conversation.")
  const { buildMessagingModel } = await import("./messaging")
  const db = await database(owner)
  try {
    const tx = db.transaction(["events", "metadata"], "readwrite")
    try {
      const preferences = withDefaults(await tx.objectStore("metadata").get("preferences") as Partial<MessagingPreferences> | undefined)
      const records = await tx.objectStore("events").getAll()
      const model = buildMessagingModel(records, owner, [], preferences, undefined, true)
      const conversation = model.conversations.find(c => c.id === cid)
      const group = model.groups.find(g => g.id === cid)
      const prior = preferences.deleted[cid]
      const removed = records.filter(record => storedConversationId(record, owner) === cid && record.event.kind !== "private-destroy" && record.event.kind !== "private-settings" && !((record.event.kind === "group" || record.event.kind === "leave") && record.local && record.event.recipients.some(peer => !record.delivered.includes(peer))))
      const attachmentIds = [...new Set([...(prior?.attachmentIds ?? []), ...removed.flatMap(record => { const id = record.event.payload.attachmentId ?? record.event.payload.attachment?.id; return id ? [id] : [] })])]
      const deletion = { deletedAt: Math.max(Date.now(), prior?.deletedAt ?? 0), eventKeys: [...new Set([...(prior?.eventKeys ?? []), ...removed.map(record => record.key)])], attachmentIds, ...(group ? { group, leftMembers: conversation ? group.members.filter(member => !conversation.members.includes(member)) : prior?.leftMembers ?? [] } : {}) }
      for (const record of removed) await tx.objectStore("events").delete(record.key)
      await tx.objectStore("metadata").put({ ...preferences, archived: preferences.archived.filter(id => id !== cid), deleted: { ...preferences.deleted, [cid]: deletion } }, "preferences")
      await tx.done
    } catch (error) { try { tx.abort() } catch { /* The transaction may already have aborted. */ } await tx.done.catch(() => {}); throw error }
  } finally { db.close() }
  changed(owner)
}

/** Commit the tombstone and payload removal together, including pending outbox pieces. */
export async function deleteStoredMessage(owner: string, cid: string, messageId: string, legacyRows: Array<{ senderPubKey: string; id: string }> = []) {
  if (!validConversation(cid) || !ID_PATTERN.test(messageId)) throw new Error("Choose a valid message.")
  const { buildMessagingModel } = await import("./messaging")
  const db = await database(owner)
  try {
    const tx = db.transaction(["events", "metadata"], "readwrite")
    try {
      const preferences = withDefaults(await tx.objectStore("metadata").get("preferences") as Partial<MessagingPreferences> | undefined)
      const records = await tx.objectStore("events").getAll()
      const model = buildMessagingModel(records, owner, [], preferences)
      const target = model.messages.find(message => message.conversationId === cid && message.id === messageId)
      const prior = preferences.deletedMessages[cid]
      if (!target && !prior?.messageIds.includes(messageId)) throw new Error("This message is no longer available.")
      const deletion = {
        deletedAt: Math.max(Date.now(), prior?.deletedAt ?? 0), eventKeys: [...(prior?.eventKeys ?? [])],
        messageIds: [...new Set([...(prior?.messageIds ?? []), messageId])],
        attachmentKeys: [...new Set([...(prior?.attachmentKeys ?? []), ...(target?.attachment ? [legacyMessageKey(target.senderPubKey, target.attachment.id)] : [])])],
        legacyKeys: [...new Set([...(prior?.legacyKeys ?? []), ...legacyRows.map(row => legacyMessageKey(row.senderPubKey, row.id))])],
        groupEvents: [...(prior?.groupEvents ?? [])],
      }
      const next = { ...preferences, deletedMessages: { ...preferences.deletedMessages, [cid]: deletion } }
      const removed = records.filter(record => storedConversationId(record, owner) === cid && isDeletedStoredEvent(record, owner, next))
      deletion.eventKeys = [...new Set([...deletion.eventKeys, ...removed.map(record => record.key)])]
      // Group signatures embedded in a deleted message still establish authority.
      // Replay them at their original position so earlier history stays visible.
      for (const record of removed) if (record.event.group && !deletion.groupEvents.some(checkpoint => checkpoint.key === record.key)) {
        deletion.groupEvents.push({ key: record.key, group: record.event.group, receivedAt: record.receivedAt, timestamp: record.event.timestamp, ...(record.sequence === undefined ? {} : { sequence: record.sequence }) })
      }
      for (const record of removed) await tx.objectStore("events").delete(record.key)
      await tx.objectStore("metadata").put(next, "preferences")
      await tx.done
    } catch (error) { try { tx.abort() } catch { /* The transaction may already have aborted. */ } await tx.done.catch(() => {}); throw error }
  } finally { db.close() }
  changed(owner)
}
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(x => typeof x === "string") }
function validConversation(value: string) { return PUBLIC_KEY_PATTERN.test(value) || (value.startsWith("group:") && ID_PATTERN.test(value.slice(6))) }
function validEventKey(key: string, cid: string, owner: string) {
  const match = key.match(/^(04[0-9a-f]{128}):(group:[^:]+|04[0-9a-f]{128}):([^:]+)$/)
  return !!match && ID_PATTERN.test(match[3]) && validConversation(match[2]) && (match[2].startsWith("group:") ? match[2] : match[1] === owner ? match[2] : match[1]) === cid
}
function validMessageKey(key: string, cid: string, owner: string, legacy: boolean) {
  try {
    const value = JSON.parse(key)
    return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && PUBLIC_KEY_PATTERN.test(value[0])
      && (cid.startsWith("group:") ? !legacy : value[0] === owner || value[0] === cid)
      && typeof value[1] === "string" && (legacy ? value[1].length > 0 && value[1].length <= 160 : ID_PATTERN.test(value[1]))
      && key === legacyMessageKey(value[0], value[1])
  } catch { return false }
}
export async function validateMessagingSnapshot(value: unknown, owner: string): Promise<MessagingSnapshot> {
  if (!value || typeof value !== "object") throw new Error("The messaging backup is invalid.")
  const snapshot = value as MessagingSnapshot
  if (snapshot.version !== 3 || snapshot.owner !== owner || !Array.isArray(snapshot.events) || snapshot.events.length > 250000) throw new Error("The messaging backup belongs to a different identity or is invalid.")
  const p = snapshot.preferences
  if (!p || !stringArray(p.accepted) || !p.accepted.every(validConversation) || !stringArray(p.blocked) || !p.blocked.every(x => PUBLIC_KEY_PATTERN.test(x)) || !p.notifications || !p.readAt || typeof p.readReceipts !== "boolean") throw new Error("The saved chat preferences are invalid.")
  if (!Object.entries(p.notifications).every(([key, mode]) => validConversation(key) && ["all", "mentions", "muted"].includes(mode)) || !Object.entries(p.readAt).every(([key, time]) => validConversation(key) && Number.isSafeInteger(time) && time >= 0)) throw new Error("The saved chat preferences are invalid.")
  if (p.archived !== undefined && (!stringArray(p.archived) || !p.archived.every(validConversation))) throw new Error("The saved archived chats are invalid.")
  if (p.deleted !== undefined && (!p.deleted || typeof p.deleted !== "object" || Array.isArray(p.deleted))) throw new Error("The saved deleted chats are invalid.")
  if (p.deletedMessages !== undefined && (!p.deletedMessages || typeof p.deletedMessages !== "object" || Array.isArray(p.deletedMessages))) throw new Error("The saved deleted messages are invalid.")
  const { validateMessagingEvent, validLegacyMessagingEvent, validateGroup } = await import("./messaging")
  for (const [cid, deletion] of [...Object.entries(p.deleted ?? {}), ...Object.entries(p.deletedMessages ?? {})]) {
    if (!validConversation(cid) || !deletion || !Number.isSafeInteger(deletion.deletedAt) || deletion.deletedAt < 0 || !stringArray(deletion.eventKeys) || deletion.eventKeys.length > 250000 || !deletion.eventKeys.every(key => validEventKey(key, cid, owner)) || (deletion.attachmentIds !== undefined && (!stringArray(deletion.attachmentIds) || deletion.attachmentIds.length > 250000 || !deletion.attachmentIds.every(id => ID_PATTERN.test(id)))) || (deletion.group !== undefined && (deletion.group.id !== cid || !await validateGroup(deletion.group))) || (deletion.leftMembers !== undefined && (!deletion.group || !stringArray(deletion.leftMembers) || !deletion.leftMembers.every(member => deletion.group!.members.includes(member))))) throw new Error("The saved deleted chats are invalid.")
  }
  for (const [cid, deletion] of Object.entries(p.deletedMessages ?? {})) {
    if (!stringArray(deletion.messageIds) || deletion.messageIds.length > 250000 || !deletion.messageIds.every(id => ID_PATTERN.test(id))
      || (deletion.legacyKeys !== undefined && (!stringArray(deletion.legacyKeys) || deletion.legacyKeys.length > 250000 || !deletion.legacyKeys.every(key => validMessageKey(key, cid, owner, true))))
      || (deletion.attachmentKeys !== undefined && (!stringArray(deletion.attachmentKeys) || deletion.attachmentKeys.length > 250000 || !deletion.attachmentKeys.every(key => validMessageKey(key, cid, owner, false))))
      || (deletion.groupEvents !== undefined && (!Array.isArray(deletion.groupEvents) || deletion.groupEvents.length > 250000))) throw new Error("The saved deleted messages are invalid.")
    const seenCheckpoints = new Set<string>()
    for (const checkpoint of deletion.groupEvents ?? []) {
      if (!checkpoint || typeof checkpoint.key !== "string" || seenCheckpoints.has(checkpoint.key) || !deletion.eventKeys.includes(checkpoint.key)
        || !validEventKey(checkpoint.key, cid, owner) || checkpoint.group?.id !== cid || !await validateGroup(checkpoint.group)
        || !Number.isSafeInteger(checkpoint.receivedAt) || checkpoint.receivedAt < 0 || !Number.isSafeInteger(checkpoint.timestamp) || checkpoint.timestamp < 1
        || (checkpoint.sequence !== undefined && (!Number.isSafeInteger(checkpoint.sequence) || checkpoint.sequence < 1))) throw new Error("The saved deleted messages are invalid.")
      seenCheckpoints.add(checkpoint.key)
    }
  }
  snapshot.preferences = withDefaults(p)
  const seen = new Set<string>()
  for (const record of snapshot.events) {
    if (!record || typeof record !== "object" || !record.event || record.key !== eventStorageKey(record.event) || seen.has(record.key) || typeof record.local !== "boolean" || !stringArray(record.delivered) || !record.delivered.every(x => record.event.recipients?.includes(x)) || !Number.isSafeInteger(record.receivedAt) || record.receivedAt < 0 || (record.sequence !== undefined && (!Number.isSafeInteger(record.sequence) || record.sequence < 1)) || (record.legacy !== undefined && typeof record.legacy !== "boolean")) throw new Error("The backup contains an invalid message record.")
    const e = record.event
    if (e.author !== owner && !e.recipients?.includes(owner)) throw new Error("The backup contains messages for another identity.")
    if (record.local && e.author !== owner) throw new Error("The backup contains an invalid outgoing message.")
    if (record.failedRecipients !== undefined && (!stringArray(record.failedRecipients) || !record.failedRecipients.every(peer => e.recipients.includes(peer)))) throw new Error("The backup contains invalid failed recipients.")
    if (record.legacy) {
      if (!validLegacyMessagingEvent(e)) throw new Error("The backup contains invalid legacy history.")
      // Legacy history is display-only and must never execute controls or resend.
      record.local = false
      record.delivered = [...e.recipients]
    } else if (!await validateMessagingEvent(e)) throw new Error("A saved message signature or envelope is invalid.")
    seen.add(record.key)
  }
  return snapshot
}
export async function importMessagingSnapshot(owner: string, value: MessagingSnapshot) {
  const snapshot = await validateMessagingSnapshot(value, owner)
  const db = await database(owner)
  try {
    const tx = db.transaction(["events", "metadata"], "readwrite")
    try {
    const savedPreferences = await tx.objectStore("metadata").get("preferences") as Partial<MessagingPreferences> | undefined
    const old = withDefaults(savedPreferences)
    const preferences = savedPreferences ? { ...snapshot.preferences, ...old, accepted: [...new Set([...snapshot.preferences.accepted, ...old.accepted])], blocked: [...new Set([...snapshot.preferences.blocked, ...old.blocked])], notifications: { ...snapshot.preferences.notifications, ...old.notifications }, readAt: { ...snapshot.preferences.readAt, ...old.readAt }, archived: [...new Set([...snapshot.preferences.archived, ...old.archived])], deleted: mergeConversationDeletions(snapshot.preferences.deleted, old.deleted), deletedMessages: mergeMessageDeletions(snapshot.preferences.deletedMessages, old.deletedMessages) } : snapshot.preferences
    const state = await privateState(tx)
    state.cutoffs = mergeCutoffs(state.cutoffs, privateDestroyCutoffs(snapshot.events, owner))
    for (const record of snapshot.events) if (record.event.kind === "private-message") state.targets.add(privateMessageTarget(record, owner))
    // Imports cannot extend private lifetimes or bring private edit text back.
    for (const record of await tx.objectStore("events").getAll()) if (isDeletedStoredEvent(record, owner, preferences) || isPrivateEventExpired(record, owner, state.cutoffs) || privateEdit(record, owner, state.targets)) await tx.objectStore("events").delete(record.key)
    for (const record of snapshot.events) {
      if (record.event.kind === "private-message" || isDeletedStoredEvent(record, owner, preferences) || privateEdit(record, owner, state.targets)) continue
      const existing = await tx.objectStore("events").get(record.key)
      if (existing && JSON.stringify(existing.event) !== JSON.stringify(record.event)) throw new Error("The backup conflicts with a saved message.")
      await tx.objectStore("events").put(existing ? { ...record, local: existing.local || record.local, delivered: [...new Set([...existing.delivered, ...record.delivered])] } : record)
    }
    if (snapshot.events.some(record => record.event.kind.startsWith("private-"))) await savePrivateState(tx, state)
    await tx.objectStore("metadata").put(preferences, "preferences")
    // The receiving device must scan the retained feed for itself.
    await tx.objectStore("metadata").put(0, "cursor")
    await tx.done
    } catch (error) { try { tx.abort() } catch { /* The transaction may already have aborted. */ } await tx.done.catch(() => {}); throw error }
  } finally { db.close() }
  changed(owner)
}
