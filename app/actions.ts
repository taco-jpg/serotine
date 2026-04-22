"use server"
import { getDB } from "@/lib/db"

export async function storeSignal(data: {
  messageId: string
  recipientUIDs: string
  senderEphemeralPublicKey: string
  offerSDP?: string
  answerSDP?: string
  iceCandidates?: string
}) {
  const db = getDB()
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
  } catch (error: any) {
    return { error: error.message }
  }
}

export async function getSignal(messageId: string) {
  const db = getDB()
  try {
    const signal = await db.prepare(
      `SELECT * FROM P2PSignal WHERE messageId = ?`
    ).bind(messageId).first()
    return { success: true, signal }
  } catch (error: any) {
    return { error: error.message }
  }
}

export async function deleteSignal(messageId: string) {
  const db = getDB()
  try {
    await db.prepare(`DELETE FROM P2PSignal WHERE messageId = ?`).bind(messageId).run()
    return { success: true }
  } catch (error: any) {
    return { error: error.message }
  }
}

export async function storeEncryptedMessage(data: {
  receiverPubKeyHash: string
  encryptedData: string
}) {
  const db = getDB()
  try {
    await db.prepare(`
      INSERT INTO Message (id, receiverPubKeyHash, encryptedData, expiresAt, createdAt)
      VALUES (lower(hex(randomblob(16))), ?, ?, datetime('now', '+7 days'), datetime('now'))
    `).bind(data.receiverPubKeyHash, data.encryptedData).run()
    return { success: true }
  } catch (error: any) {
    return { error: error.message }
  }
}

export async function getMyMessages(receiverPubKeyHash: string) {
  const db = getDB()
  try {
    const { results } = await db.prepare(
      `SELECT * FROM Message WHERE receiverPubKeyHash = ?`
    ).bind(receiverPubKeyHash).all()
    return { success: true, messages: results }
  } catch (error: any) {
    return { error: error.message }
  }
}

export async function deleteMessage(messageId: string) {
  const db = getDB()
  try {
    await db.prepare(`DELETE FROM Message WHERE id = ?`).bind(messageId).run()
    return { success: true }
  } catch (error: any) {
    return { error: "Message delete failed or not found" }
  }
}