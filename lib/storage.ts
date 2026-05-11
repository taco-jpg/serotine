import { openDB, type DBSchema } from "idb"

interface ChatDB extends DBSchema {
  messages: {
    key: string
    value: {
      id: string
      peerPubKey: string
      senderPubKey: string
      content: string
      timestamp: number
    }
    indexes: { "by-peer": "peerPubKey" }
  }
}

const DB_NAME = "chat-storage"
const DB_VERSION = 2

export async function initDB() {
  return openDB<ChatDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("messages")) {
        const store = db.createObjectStore("messages", { keyPath: "id" })
        store.createIndex("by-peer", "peerPubKey")
      }
    },
  })
}

export async function saveMessageToStorage(message: {
  id: string
  peerPubKey: string
  senderPubKey: string
  content: string
  timestamp: number
}) {
  const db = await initDB()
  await db.put("messages", message)
}

export async function getMessagesFromStorage(peerPubKey: string) {
  const db = await initDB()
  return db.getAllFromIndex("messages", "by-peer", peerPubKey)
}

export async function deleteMessageFromStorage(id: string) {
  const db = await initDB()
  await db.delete("messages", id)
}
