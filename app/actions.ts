"use server"

import { getDB, RelayConfigurationError, type D1DatabaseBinding } from "@/lib/db"
import { verifyRequestProof } from "@/lib/request-auth"
import { relayFailureKind } from "@/lib/relay-diagnostics"
import { AUTH_WINDOW_MS, ID_PATTERN, MAX_PACKET_LENGTH, PUBLIC_KEY_PATTERN, type RequestProof, type InboxRequest, type InboxCursor } from "@/lib/protocol"

class RequestError extends Error {}
type Failure = { success: false; error: string }
export interface RelayMessage {
  id: string
  senderPubKey: string
  recipientPubKey: string
  encryptedData: string
  createdAt: number
}

function failure(error: unknown): Failure {
  if (error instanceof RequestError) return { success: false, error: error.message }
  if (error instanceof RelayConfigurationError) {
    console.error("Relay configuration: missing serotine_db binding")
    return { success: false, error: "Messaging is not configured on this server. The site owner needs to connect its relay database. Your saved messages are still on this browser." }
  }
  const kind = relayFailureKind(error)
  if (kind === "quota") {
    console.error("Relay operation failed: daily database allowance exhausted")
    return { success: false, error: "The relay has reached its daily database allowance. Messaging can resume when it resets. Your saved messages are still on this browser; retry unconfirmed messages later." }
  }
  if (kind === "overloaded") {
    console.error("Relay operation failed: database busy")
    return { success: false, error: "The relay is busy. Connection checks will slow down and retry automatically. Retry unconfirmed messages once the connection returns." }
  }
  if (kind === "schema") {
    console.error("Relay configuration: database schema remains incompatible after automatic setup")
    return { success: false, error: "The messaging database could not finish automatic setup. Your saved messages are still on this browser. Try reconnecting shortly." }
  }
  console.error("Relay operation failed: unavailable")
  return { success: false, error: "The relay is temporarily unavailable. Sends are not confirmed. Keep saved messages and retry when the connection returns." }
}
function checkPeer(peer: string) {
  if (typeof peer !== "string" || !PUBLIC_KEY_PATTERN.test(peer)) throw new RequestError("Invalid contact address.")
}
function checkPacket(packet: string) {
  if (typeof packet !== "string" || packet.length < 32 || packet.length > MAX_PACKET_LENGTH) throw new RequestError("Invalid encrypted packet.")
}
async function authorize(action: string, payload: unknown, proof: RequestProof): Promise<D1DatabaseBinding> {
  if (!await verifyRequestProof(action, payload, proof)) throw new RequestError("Identity verification failed. Check your device clock and reopen the app.")
  const db = await getDB()
  const now = Date.now()
  await db.prepare("DELETE FROM RequestNonce WHERE expiresAt < ?").bind(now).run()
  // Retain future-dated proofs until their entire acceptance window has elapsed.
  const result = await db.prepare("INSERT OR IGNORE INTO RequestNonce (publicKey, nonce, action, expiresAt) VALUES (?, ?, ?, ?)")
    .bind(proof.publicKey, proof.nonce, action, Math.max(now, proof.timestamp) + AUTH_WINDOW_MS).run()
  if (result.meta.changes !== 1) throw new RequestError("This request was already used. Please retry.")
  return db
}
async function limitWrites(db: D1DatabaseBinding, proof: RequestProof, action: string, limit: number) {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM RequestNonce WHERE publicKey = ? AND action = ? AND expiresAt > ?")
    .bind(proof.publicKey, action, Date.now()).first<{ count: number }>()
  if ((row?.count ?? 0) > limit) throw new RequestError("Too many requests. Wait a minute and try again.")
}

export async function storeEncryptedMessage(data: { id: string; recipientPubKey: string; encryptedData: string }, proof: RequestProof): Promise<{ success: true } | Failure> {
  try {
    checkPeer(data.recipientPubKey); checkPacket(data.encryptedData)
    if (!ID_PATTERN.test(data.id) || data.recipientPubKey === proof.publicKey) throw new RequestError("Invalid message.")
    const db = await authorize("message:send", data, proof)
    await limitWrites(db, proof, "message:send", 60)
    const now = Date.now()
    await db.prepare("DELETE FROM RelayMessage WHERE expiresAt <= ?").bind(now).run()
    const existing = await db.prepare("SELECT id FROM RelayMessage WHERE recipientPubKey = ? AND senderPubKey = ? AND id = ?")
      .bind(data.recipientPubKey, proof.publicKey, data.id).first()
    if (existing) return { success: true }
    const pending = await db.prepare("SELECT COUNT(*) AS count FROM RelayMessage WHERE senderPubKey = ?").bind(proof.publicKey).first<{ count: number }>()
    if ((pending?.count ?? 0) >= 500) throw new RequestError("Your pending message limit is reached. Wait for your contacts to collect messages.")
    await db.prepare(`INSERT INTO RelayMessage (id, senderPubKey, recipientPubKey, encryptedData, createdAt, expiresAt)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(recipientPubKey, senderPubKey, id) DO NOTHING`)
      .bind(data.id, proof.publicKey, data.recipientPubKey, data.encryptedData, now, now + 7 * 86400_000).run()
    return { success: true }
  } catch (error) { return failure(error) }
}

export async function getMyMessages(data: InboxRequest, proof: RequestProof): Promise<{ success: true; messages: RelayMessage[]; nextCursor: InboxCursor | null } | Failure> {
  try {
    checkPeer(data.senderPubKey)
    if (data.after !== undefined && (!data.after || !Number.isSafeInteger(data.after.createdAt) || data.after.createdAt < 0 || !ID_PATTERN.test(data.after.id))) {
      throw new RequestError("Invalid inbox position. Reopen this conversation.")
    }
    const db = await authorize("message:list", data, proof)
    const after = data.after
    const { results } = await db.prepare(`SELECT id, senderPubKey, recipientPubKey, encryptedData, createdAt FROM RelayMessage
      WHERE recipientPubKey = ? AND senderPubKey = ? AND expiresAt > ?
      ${after ? "AND (createdAt > ? OR (createdAt = ? AND id > ?))" : ""}
      ORDER BY createdAt ASC, id ASC LIMIT 100`)
      .bind(proof.publicKey, data.senderPubKey, Date.now(), ...(after ? [after.createdAt, after.createdAt, after.id] : [])).all<RelayMessage>()
    const last = results.at(-1)
    return { success: true, messages: results, nextCursor: results.length === 100 && last ? { createdAt: last.createdAt, id: last.id } : null }
  } catch (error) { return failure(error) }
}

export async function deleteMessage(data: { id: string; senderPubKey: string }, proof: RequestProof): Promise<{ success: true } | Failure> {
  try {
    checkPeer(data.senderPubKey)
    if (!ID_PATTERN.test(data.id)) throw new RequestError("Invalid message.")
    const db = await authorize("message:ack", data, proof)
    await db.prepare("DELETE FROM RelayMessage WHERE id = ? AND senderPubKey = ? AND recipientPubKey = ?")
      .bind(data.id, data.senderPubKey, proof.publicKey).run()
    return { success: true }
  } catch (error) { return failure(error) }
}

export async function storeSignal(data: { recipientPubKey: string; encryptedData: string }, proof: RequestProof): Promise<{ success: true } | Failure> {
  try {
    checkPeer(data.recipientPubKey); checkPacket(data.encryptedData)
    const db = await authorize("signal:send", data, proof)
    await limitWrites(db, proof, "signal:send", 20)
    await db.prepare("DELETE FROM RelaySignal WHERE expiresAt <= ?").bind(Date.now()).run()
    await db.prepare(`INSERT INTO RelaySignal (senderPubKey, recipientPubKey, encryptedData, expiresAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(senderPubKey, recipientPubKey) DO UPDATE SET encryptedData = excluded.encryptedData, expiresAt = excluded.expiresAt`)
      .bind(proof.publicKey, data.recipientPubKey, data.encryptedData, Date.now() + 60_000).run()
    return { success: true }
  } catch (error) { return failure(error) }
}

export async function getSignal(data: { senderPubKey: string }, proof: RequestProof): Promise<{ success: true; signal: { encryptedData: string } | null } | Failure> {
  try {
    checkPeer(data.senderPubKey)
    const db = await authorize("signal:read", data, proof)
    const signal = await db.prepare("SELECT encryptedData FROM RelaySignal WHERE senderPubKey = ? AND recipientPubKey = ? AND expiresAt > ?")
      .bind(data.senderPubKey, proof.publicKey, Date.now()).first<{ encryptedData: string }>()
    return { success: true, signal }
  } catch (error) { return failure(error) }
}
