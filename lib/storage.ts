import { openDB, type DBSchema } from "idb"
import { notifyHistoryChanged } from "./history-events"

export interface StoredMessage {
  id: string
  peerPubKey: string
  senderPubKey: string
  content: string
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
  try { await db.put("messages", message) } finally { db.close() }
  notifyHistoryChanged(owner, message.peerPubKey)
}
export async function getMessagesFromStorage(owner: string, peerPubKey: string) {
  const db = await initDB(owner)
  try { return await db.getAllFromIndex("messages", "by-peer", peerPubKey) } finally { db.close() }
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
