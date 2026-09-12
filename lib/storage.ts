import { openDB, type DBSchema } from "idb"
import { notifyHistoryChanged } from "./history-events"
import { validateAttachments, type MessageAttachment } from "./legacy-attachments"

export interface StoredMessage {
  id: string
  peerPubKey: string
  senderPubKey: string
  content: string
  attachments?: MessageAttachment[]
  timestamp: number
  updatedAt?: number
  delivery?: "pending" | "sent" | "failed" | "received"
}
interface ChatDB extends DBSchema {
  messages: { key: [string, string, string]; value: StoredMessage; indexes: { "by-peer": string } }
}

async function initDB(owner: string) {
  if (!/^04[0-9a-f]{128}$/.test(owner)) throw new Error("A valid local identity is required to save messages.")
  return openDB<ChatDB>(`serotine-messages:${owner}`, 1, {
    upgrade(db) {
      const store = db.createObjectStore("messages", { keyPath: ["peerPubKey", "senderPubKey", "id"] })
      store.createIndex("by-peer", "peerPubKey")
    },
  })
}
export async function saveMessageToStorage(owner: string, message: StoredMessage) {
  const db = await initDB(owner)
  try {
    const tx = db.transaction("messages", "readwrite")
    const existing = await tx.store.get([message.peerPubKey, message.senderPubKey, message.id])
    // A slower retry in another tab must never erase a confirmed relay send.
    const stored = existing?.delivery === "sent" && message.senderPubKey === owner
      ? existing : { ...message, ...(existing ? { content: existing.content, timestamp: existing.timestamp, attachments: existing.attachments } : {}) }
    // Absence is part of the original packet too: a stale retry cannot add files.
    if (stored.attachments === undefined) delete stored.attachments
    await tx.store.put(stored)
    await tx.done
    notifyHistoryChanged(owner, message.peerPubKey)
    return stored
  } finally { db.close() }
}
export async function getMessagesFromStorage(owner: string, peerPubKey: string) {
  const db = await initDB(owner)
  try { return await db.getAllFromIndex("messages", "by-peer", peerPubKey) } finally { db.close() }
}

/** Remove legacy history and its inline files after the deletion marker is saved. */
export async function deleteConversationHistoryFromStorage(owner: string, peerPubKey: string, deletedAt = Infinity): Promise<void> {
  const db = await initDB(owner)
  try {
    const tx = db.transaction("messages", "readwrite")
    const rows = await tx.store.index("by-peer").getAll(peerPubKey)
    for (const row of rows) {
      if (row.timestamp <= deletedAt) await tx.store.delete([row.peerPubKey, row.senderPubKey, row.id])
    }
    await tx.done
    if (rows.some(row => row.timestamp <= deletedAt)) notifyHistoryChanged(owner, peerPubKey)
  } finally { db.close() }
  // The migration source is shared, so only its recorded original owner may
  // remove matching rows. Cursor deletion respects its older primary-key shape.
  if (typeof localStorage === "undefined" || localStorage.getItem("serotine_legacy_history_owner") !== owner) return
  const legacy = await openDB<ChatDB>("chat-storage", 2)
  try {
    if (!legacy.objectStoreNames.contains("messages")) return
    const tx = legacy.transaction("messages", "readwrite")
    let cursor = await tx.store.openCursor()
    while (cursor) {
      const row = cursor.value
      const peer = row?.senderPubKey === owner ? row.peerPubKey : row?.senderPubKey
      if (peer === peerPubKey && row.timestamp <= deletedAt) await cursor.delete()
      cursor = await cursor.continue()
    }
    await tx.done
  } finally { legacy.close() }
}

/** Export every conversation, including older history not yet opened this session. */
export async function exportAllMessagesFromStorage(owner: string): Promise<StoredMessage[]> {
  const db = await initDB(owner)
  try { return await db.getAll("messages") } finally { db.close() }
}

/** Validate the whole batch before opening a write transaction. */
export function validateStoredMessages(value: unknown, owner: string): StoredMessage[] {
  const address = /^04[0-9a-f]{128}$/
  if (!address.test(owner) || !Array.isArray(value) || value.length > 100_000) throw new Error("The backup message history is invalid or too large.")
  const seen = new Set<string>()
  return value.map((row: unknown) => {
    if (!row || typeof row !== "object") throw new Error("The backup contains an invalid message.")
    const item = row as StoredMessage
    if (typeof item.id !== "string" || item.id.length < 1 || item.id.length > 160
      || !address.test(item.peerPubKey) || !address.test(item.senderPubKey)
      || (item.senderPubKey !== owner && item.senderPubKey !== item.peerPubKey)
      || typeof item.content !== "string" || item.content.length > 64_000
      || (item.attachments !== undefined && !validateAttachments(item.attachments))
      || !Number.isSafeInteger(item.timestamp) || item.timestamp <= 0
      || (item.updatedAt !== undefined && (!Number.isSafeInteger(item.updatedAt) || item.updatedAt <= 0))
      || (item.delivery !== undefined && !["pending", "sent", "failed", "received"].includes(item.delivery))) {
      throw new Error("The backup contains an invalid or unrelated message.")
    }
    const key = JSON.stringify([item.peerPubKey, item.senderPubKey, item.id])
    if (seen.has(key)) throw new Error("The backup contains duplicate messages.")
    seen.add(key)
    return { id: item.id, peerPubKey: item.peerPubKey, senderPubKey: item.senderPubKey, content: item.content, timestamp: item.timestamp,
      ...(item.attachments !== undefined ? { attachments: item.attachments.map(attachment => ({ ...attachment })) } : {}),
      ...(item.updatedAt !== undefined ? { updatedAt: item.updatedAt } : {}), ...(item.delivery ? { delivery: item.delivery } : {}) }
  })
}

/** Merge a restored history without overwriting newer local rows or resending it. */
export async function importMessagesToStorage(owner: string, value: unknown): Promise<void> {
  const messages = validateStoredMessages(value, owner)
  const db = await initDB(owner)
  try {
    const tx = db.transaction("messages", "readwrite")
    for (const row of messages) {
      const existing = await tx.store.get([row.peerPubKey, row.senderPubKey, row.id])
      if (!existing) await tx.store.put(row)
    }
    await tx.done
    for (const peer of new Set(messages.map(row => row.peerPubKey))) notifyHistoryChanged(owner, peer)
  } finally { db.close() }
}

// Old versions had one shared store and only one identity. Import once for that
// original identity; preserve the old database and normalize received P2P rows.
export async function migrateLegacyHistory(owner: string) {
  const marker = "serotine_legacy_history_owner"
  if (localStorage.getItem(marker) || localStorage.getItem("serotine_identity_public_enc") !== owner) return
  const legacy = await openDB<ChatDB>("chat-storage", 2)
  try {
    if (legacy.objectStoreNames.contains("messages")) {
      const rows = await legacy.getAll("messages")
      const db = await initDB(owner)
      try {
        const tx = db.transaction("messages", "readwrite")
        for (const row of rows) {
          if (row && typeof row.content === "string") {
            await tx.store.put({ ...row, peerPubKey: row.senderPubKey === owner ? row.peerPubKey : row.senderPubKey })
          }
        }
        await tx.done
      } finally { db.close() }
    }
    localStorage.setItem(marker, owner)
  } finally { legacy.close() }
}
