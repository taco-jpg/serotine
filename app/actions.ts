"use server"
import { getDB } from "@/lib/db"

interface P2PSignal {
  id: string
  messageId: string
  recipientUIDs: string
  senderEphemeralPublicKey: string
  offerSDP: string | null
  answerSDP: string | null
  iceCandidates: string | null
  createdAt: string
}

interface Message {
  id: string
  receiverPubKeyHash: string
  encryptedData: string
  expiresAt: string
  createdAt: string
}

export async function storeSignal(data: {
  messageId: string
  recipientUIDs: string
  senderEphemeralPublicKey: string
  offerSDP?: string
  answerSDP?: string
  iceCandidates?: string
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDB()
  try {
    await db.prepare(`
      INSERT INTO P2PSignal (id, messageId, recipientUIDs, senderEphemeralPublicKey, offerSDP, answerSDP, iceCandidates, createdAt)
      VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(messageId) DO UPDATE SET
        recipientUIDs = excluded.recipientUIDs,
        senderEphemeralPublicKey = excluded.senderEphemeralPublicKey,
        offerSDP = excluded.offerSDP,
        answerSDP = excluded.answerSDP,
        iceCandidates = excluded.iceCandidates
    `).bind(
      data.messageId,
      data.recipientUIDs,
      data.senderEphemeralPublicKey,
      data.offerSDP ?? null,
      data.answerSDP ?? null,
      data.iceCandidates ?? null,
    ).run()
    return { success: true }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return { success: false, error: message }
  }
}

export async function getSignal(messageId: string): Promise<{ success: true; signal: P2PSignal | undefined } | { success: false; error: string }> {
  const db = await getDB()
  try {
    const signal = await db.prepare(
      `SELECT * FROM P2PSignal WHERE messageId = ?`
    ).bind(messageId).first() as P2PSignal | undefined
    return { success: true, signal }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return { success: false, error: message }
  }
}

export async function deleteSignal(messageId: string): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDB()
  try {
    await db.prepare(`DELETE FROM P2PSignal WHERE messageId = ?`).bind(messageId).run()
    return { success: true }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return { success: false, error: message }
  }
}

export async function storeEncryptedMessage(data: {
  receiverPubKeyHash: string
  encryptedData: string
}): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDB()
  try {
    await db.prepare(`
      INSERT INTO Message (id, receiverPubKeyHash, encryptedData, expiresAt, createdAt)
      VALUES (lower(hex(randomblob(16))), ?, ?, datetime('now', '+7 days'), datetime('now'))
    `).bind(data.receiverPubKeyHash, data.encryptedData).run()
    return { success: true }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return { success: false, error: message }
  }
}

export async function getMyMessages(receiverPubKeyHash: string): Promise<{ success: true; messages: Message[] } | { success: false; error: string }> {
  const db = await getDB()
  try {
    const { results } = await db.prepare(
      `SELECT * FROM Message WHERE receiverPubKeyHash = ?`
    ).bind(receiverPubKeyHash).all() as { results: Message[] }
    return { success: true, messages: results }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return { success: false, error: message }
  }
}

export async function deleteMessage(messageId: string): Promise<{ success: true } | { success: false; error: string }> {
  const db = await getDB()
  try {
    await db.prepare(`DELETE FROM Message WHERE id = ?`).bind(messageId).run()
    return { success: true }
  } catch {
    return { success: false, error: "Message delete failed or not found" }
  }
}