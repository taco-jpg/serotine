import { openDB, type DBSchema } from "idb"
import { ID_PATTERN, PUBLIC_KEY_PATTERN } from "./protocol"
import type { MessagingPreferences, MessagingSnapshot, StoredEvent } from "./messaging-types"

interface MessagingDB extends DBSchema {
  events: { key: string; value: StoredEvent }
  metadata: { key: string; value: unknown }
}
export const defaultMessagingPreferences = (): MessagingPreferences => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true })
async function database(owner: string) {
  if (!PUBLIC_KEY_PATTERN.test(owner)) throw new Error("A valid identity is required.")
  return openDB<MessagingDB>(`serotine-events:${owner}`, 1, { upgrade(db) { db.createObjectStore("events", { keyPath: "key" }); db.createObjectStore("metadata") } })
}
export function eventStorageKey(event: { author: string; conversationId: string; id: string }) { return `${event.author}:${event.conversationId}:${event.id}` }
function changed(owner: string) {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("serotine:events", { detail: { owner } }))
}
export async function getStoredEvents(owner: string): Promise<StoredEvent[]> {
  const db = await database(owner)
  try { return await db.getAll("events") } finally { db.close() }
}
export async function saveStoredEvent(owner: string, record: StoredEvent) {
  const db = await database(owner)
  try {
    const tx = db.transaction("events", "readwrite")
    try {
    const existing = await tx.store.get(record.key)
    // An event is immutable. A retry may only add per-recipient confirmations.
    if (existing && JSON.stringify(existing.event) !== JSON.stringify(record.event)) throw new Error("Conflicting message identifier.")
    const value = existing ? { ...existing, ...record, local: existing.local || record.local, receivedAt: Math.min(existing.receivedAt, record.receivedAt), sequence: existing.sequence === undefined ? record.sequence : record.sequence === undefined ? existing.sequence : Math.min(existing.sequence, record.sequence), delivered: [...new Set([...existing.delivered, ...record.delivered])] } : record
    await tx.store.put(value)
    await tx.done
    } catch (error) { try { tx.abort() } catch { /* The transaction may already have aborted. */ } await tx.done.catch(() => {}); throw error }
  } finally { db.close() }
  changed(owner)
}
export async function getMessagingPreferences(owner: string): Promise<MessagingPreferences> {
  const db = await database(owner)
  try { return { ...defaultMessagingPreferences(), ...((await db.get("metadata", "preferences")) as Partial<MessagingPreferences> ?? {}) } } finally { db.close() }
}
export async function saveMessagingPreferences(owner: string, preferences: MessagingPreferences) {
  const db = await database(owner)
  try { await db.put("metadata", preferences, "preferences") } finally { db.close() }
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
  return { version: 3, owner, events, preferences }
}
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(x => typeof x === "string") }
function validConversation(value: string) { return PUBLIC_KEY_PATTERN.test(value) || (value.startsWith("group:") && ID_PATTERN.test(value.slice(6))) }
export async function validateMessagingSnapshot(value: unknown, owner: string): Promise<MessagingSnapshot> {
  if (!value || typeof value !== "object") throw new Error("The messaging backup is invalid.")
  const snapshot = value as MessagingSnapshot
  if (snapshot.version !== 3 || snapshot.owner !== owner || !Array.isArray(snapshot.events) || snapshot.events.length > 250000) throw new Error("The messaging backup belongs to a different identity or is invalid.")
  const p = snapshot.preferences
  if (!p || !stringArray(p.accepted) || !p.accepted.every(validConversation) || !stringArray(p.blocked) || !p.blocked.every(x => PUBLIC_KEY_PATTERN.test(x)) || !p.notifications || !p.readAt || typeof p.readReceipts !== "boolean") throw new Error("The saved chat preferences are invalid.")
  if (!Object.entries(p.notifications).every(([key, mode]) => validConversation(key) && ["all", "mentions", "muted"].includes(mode)) || !Object.entries(p.readAt).every(([key, time]) => validConversation(key) && Number.isSafeInteger(time) && time >= 0)) throw new Error("The saved chat preferences are invalid.")
  const { validateMessagingEvent, validLegacyMessagingEvent } = await import("./messaging")
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
    for (const record of snapshot.events) {
      const existing = await tx.objectStore("events").get(record.key)
      if (existing && JSON.stringify(existing.event) !== JSON.stringify(record.event)) throw new Error("The backup conflicts with a saved message.")
      await tx.objectStore("events").put(existing ? { ...record, local: existing.local || record.local, delivered: [...new Set([...existing.delivered, ...record.delivered])] } : record)
    }
    const old = await tx.objectStore("metadata").get("preferences") as MessagingPreferences | undefined
    const preferences = old ? { ...snapshot.preferences, ...old, accepted: [...new Set([...snapshot.preferences.accepted, ...old.accepted])], blocked: [...new Set([...snapshot.preferences.blocked, ...old.blocked])], notifications: { ...snapshot.preferences.notifications, ...old.notifications }, readAt: { ...snapshot.preferences.readAt, ...old.readAt } } : snapshot.preferences
    await tx.objectStore("metadata").put(preferences, "preferences")
    // The receiving device must scan the retained feed for itself.
    await tx.objectStore("metadata").put(0, "cursor")
    await tx.done
    } catch (error) { try { tx.abort() } catch { /* The transaction may already have aborted. */ } await tx.done.catch(() => {}); throw error }
  } finally { db.close() }
  changed(owner)
}
