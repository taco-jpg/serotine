import { openDB, type DBSchema } from "idb"

interface ChatDB extends DBSchema {
  messages: {
    key: string
    value: {
      id: string
      groupId: string
      senderId: string
      content: string
      timestamp: number
    }
    indexes: { "by-group": "groupId" }
  }
}

const DB_NAME = "chat-storage"
const DB_VERSION = 1

export async function initDB() {
  return openDB<ChatDB>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      const store = db.createObjectStore("messages", { keyPath: "id" })
      store.createIndex("by-group", "groupId")
    },
  })
}

export async function saveMessageToStorage(message: {
  id: string
  groupId: string
  senderId: string
  content: string
  timestamp: number
}) {
  const db = await initDB()
  await db.put("messages", message)
}

export async function getMessagesFromStorage(groupId: string) {
  const db = await initDB()
  return db.getAllFromIndex("messages", "by-group", groupId)
}

export async function deleteMessageFromStorage(id: string) {
  const db = await initDB()
  await db.delete("messages", id)
}
