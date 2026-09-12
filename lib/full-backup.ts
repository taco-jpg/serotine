import { base64ToArrayBuffer } from "./crypto"
import { type Contact, type Identity, loadContacts, restoreIdentityBackup, saveContacts, validateAddress, validateIdentity } from "./identity"
import { exportAllMessagesFromStorage, importMessagesToStorage, migrateLegacyHistory, type StoredMessage, validateStoredMessages } from "./storage"
import { exportMessagingSnapshot, importMessagingSnapshot, validateMessagingSnapshot } from "./messaging-store"
import type { MessagingSnapshot } from "./messaging-types"

export const MAX_BACKUP_FILE_BYTES = 100 * 1024 * 1024
const MAX_PLAINTEXT_BYTES = Math.floor((MAX_BACKUP_FILE_BYTES - 1024) * 3 / 4)
const FORMAT = "serotine-full-backup"
const AAD = new TextEncoder().encode("serotine-full-backup:v1:PBKDF2-SHA256-600000:AES-256-GCM")

export interface FullBackupSnapshot {
  format: "serotine-full-snapshot"
  version: 1
  createdAt: number
  identity: Identity
  contacts: Contact[]
  messages: StoredMessage[]
  messaging: MessagingSnapshot
}

// Chunk the conversion so attachment-heavy backups don't build a huge rope of
// one-character strings or exceed the JavaScript argument stack.
function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer), parts: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
  }
  return btoa(parts.join(""))
}

async function deriveBackupKey(password: string, salt: ArrayBuffer) {
  if (password.length > 1024) throw new Error("The backup password is too long.")
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"])
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600_000 }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}

/** All identity, ownership, event signatures and bounds are checked before writes. */
export async function validateFullBackupSnapshot(value: unknown): Promise<FullBackupSnapshot> {
  if (!value || typeof value !== "object") throw new Error("This is not a full Serotine backup.")
  const snapshot = value as FullBackupSnapshot
  if (snapshot.format !== "serotine-full-snapshot" || snapshot.version !== 1
    || !Number.isSafeInteger(snapshot.createdAt) || snapshot.createdAt <= 0
    || !Array.isArray(snapshot.contacts) || snapshot.contacts.length > 10_000) {
    throw new Error("The full backup has an invalid format.")
  }
  const identity = await validateIdentity(snapshot.identity)
  const seen = new Set<string>()
  const contacts: Contact[] = []
  for (const contact of snapshot.contacts) {
    if (!contact || typeof contact.pub !== "string" || typeof contact.alias !== "string" || contact.alias.length > 60) {
      throw new Error("The backup contains an invalid contact.")
    }
    const pub = await validateAddress(contact.pub)
    if (pub !== contact.pub || pub === identity.publicKey || seen.has(pub)) throw new Error("The backup contains an invalid or duplicate contact.")
    seen.add(pub)
    contacts.push({ pub, alias: contact.alias })
  }
  const messages = validateStoredMessages(snapshot.messages, identity.publicKey)
  const messaging = await validateMessagingSnapshot(snapshot.messaging, identity.publicKey)
  return { format: "serotine-full-snapshot", version: 1, createdAt: snapshot.createdAt, identity, contacts, messages, messaging }
}

export async function exportFullBackup(identity: Identity, password: string): Promise<string> {
  if (password.length < 12) throw new Error("Use a backup password with at least 12 characters.")
  const validated = await validateIdentity(identity)
  await migrateLegacyHistory(validated.publicKey)
  const [messages, messaging] = await Promise.all([exportAllMessagesFromStorage(validated.publicKey), exportMessagingSnapshot(validated.publicKey)])
  const snapshot = await validateFullBackupSnapshot({ format: "serotine-full-snapshot", version: 1, createdAt: Date.now(),
    identity: validated, contacts: loadContacts(validated.publicKey), messages, messaging })
  const plain = new TextEncoder().encode(JSON.stringify(snapshot))
  if (plain.byteLength > MAX_PLAINTEXT_BYTES) throw new Error("This history is too large for a 100 MiB backup. Your data has not been changed.")
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveBackupKey(password, salt.buffer)
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, plain)
  return JSON.stringify({ format: FORMAT, version: 1, salt: encodeBase64(salt.buffer), iv: encodeBase64(iv.buffer), ciphertext: encodeBase64(ciphertext) })
}

/** Accept full encrypted exports as well as every previously supported identity backup. */
export async function restoreBackup(text: string, password: string): Promise<Identity> {
  if (text.length > MAX_BACKUP_FILE_BYTES || new TextEncoder().encode(text).byteLength > MAX_BACKUP_FILE_BYTES) {
    throw new Error("Choose a Serotine backup no larger than 100 MiB.")
  }
  let envelope
  try { envelope = JSON.parse(text) } catch { throw new Error("Choose a valid Serotine JSON backup.") }
  if (envelope?.format !== FORMAT) return restoreIdentityBackup(text, password)
  if (envelope.version !== 1 || typeof envelope.salt !== "string" || envelope.salt.length !== 24
    || typeof envelope.iv !== "string" || envelope.iv.length !== 16 || typeof envelope.ciphertext !== "string"
    || envelope.ciphertext.length < 24 || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) {
    throw new Error("The backup is damaged or uses an unsupported format.")
  }
  let decrypted: unknown
  try {
    const salt = base64ToArrayBuffer(envelope.salt), iv = base64ToArrayBuffer(envelope.iv)
    if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error("Invalid encryption parameters")
    const key = await deriveBackupKey(password, salt)
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, base64ToArrayBuffer(envelope.ciphertext))
    if (plain.byteLength > MAX_PLAINTEXT_BYTES) throw new Error("Backup exceeds limit")
    decrypted = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain))
  } catch { throw new Error("The backup password is incorrect, or the file is damaged.") }
  const snapshot = await validateFullBackupSnapshot(decrypted)

  // Reuse the existing identity lock, corrupt-state recovery and mismatch guard.
  // Every payload has already passed validation at this point.
  const identity = await restoreIdentityBackup(JSON.stringify(snapshot.identity), "")
  try {
    await importMessagingSnapshot(identity.publicKey, snapshot.messaging)
    await importMessagesToStorage(identity.publicKey, snapshot.messages)
    let current: Contact[] = []
    try { current = loadContacts(identity.publicKey) } catch { /* A validated backup repairs unreadable contacts. */ }
    const merged = new Map(snapshot.contacts.map(contact => [contact.pub, contact]))
    for (const contact of current) merged.set(contact.pub, contact.alias ? contact : merged.get(contact.pub) ?? contact)
    saveContacts(identity.publicKey, [...merged.values()])
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "Browser storage is unavailable."
    throw new Error(`Your identity was restored, but some chat data could not be saved. Free browser storage and restore this backup again. ${reason}`, { cause })
  }
  return identity
}
