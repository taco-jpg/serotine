import { exportKey, exportPublicKeyToHex, generateEncryptionKeyPair, importKey, importPublicKeyFromHex, arrayBufferToBase64, base64ToArrayBuffer } from "./crypto"
import { PUBLIC_KEY_PATTERN } from "./protocol"
import { createRequestProof, verifyRequestProof } from "./request-auth"

const IDENTITY_KEY = "serotine_identity_v2"
export interface Identity { version: 2; publicKey: string; privateKey: JsonWebKey }

export async function validateIdentity(value: unknown): Promise<Identity> {
  if (!value || typeof value !== "object") throw new Error("This is not a valid identity backup.")
  const identity = value as Identity
  if (identity.version !== 2 || !PUBLIC_KEY_PATTERN.test(identity.publicKey) || !identity.privateKey?.d) throw new Error("The identity is incomplete. Restore a valid backup.")
  await importKey(identity.privateKey, "encryption", "private")
  const proof = await createRequestProof("identity:check", null, identity.privateKey, identity.publicKey)
  if (!await verifyRequestProof("identity:check", null, proof)) throw new Error("The public and private identity keys do not match.")
  return identity
}

export async function loadIdentity(): Promise<Identity | null> {
  if (!globalThis.crypto?.subtle) throw new Error("Use an up-to-date browser over HTTPS to open Serotine.")
  const saved = localStorage.getItem(IDENTITY_KEY)
  if (saved) return validateIdentity(JSON.parse(saved))
  const publicKey = localStorage.getItem("serotine_identity_public_enc")
  const privateKey = localStorage.getItem("serotine_identity_private_enc")
  if (!publicKey && !privateKey) return null
  if (!publicKey || !privateKey) throw new Error("Your local identity is incomplete. Restore your backup to continue.")
  const identity = await validateIdentity({ version: 2, publicKey: publicKey.toLowerCase(), privateKey: JSON.parse(privateKey) })
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
  return identity
}

export async function createIdentity(): Promise<Identity> {
  if (await loadIdentity()) throw new Error("An identity already exists on this browser.")
  const pair = await generateEncryptionKeyPair()
  const identity: Identity = { version: 2, publicKey: await exportPublicKeyToHex(pair.publicKey), privateKey: await exportKey(pair.privateKey) }
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
  return identity
}

export async function validateAddress(address: string): Promise<string> {
  const normalized = address.trim().toLowerCase()
  if (!PUBLIC_KEY_PATTERN.test(normalized)) throw new Error("Paste the full 130-character contact address, starting with 04.")
  await importPublicKeyFromHex(normalized, "encryption")
  return normalized
}

async function backupKey(password: string, salt: ArrayBuffer) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"])
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 600000 }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}

export async function exportIdentityBackup(identity: Identity, password: string) {
  if (password.length < 12) throw new Error("Use a backup password with at least 12 characters.")
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await backupKey(password, salt.buffer)
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(identity)))
  return JSON.stringify({ format: "serotine-backup", version: 2, salt: arrayBufferToBase64(salt.buffer), iv: arrayBufferToBase64(iv.buffer), ciphertext: arrayBufferToBase64(ciphertext) }, null, 2)
}

export async function restoreIdentityBackup(text: string, password: string): Promise<Identity> {
  if (text.length > 32_000) throw new Error("This backup file is too large.")
  let value
  try { value = JSON.parse(text) } catch { throw new Error("Choose a valid Serotine JSON backup.") }
  if (value?.format === "serotine-backup" && value.version === 2) {
    try {
      const key = await backupKey(password, base64ToArrayBuffer(value.salt))
      const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToArrayBuffer(value.iv) }, key, base64ToArrayBuffer(value.ciphertext))
      value = JSON.parse(new TextDecoder().decode(decrypted))
    } catch { throw new Error("The backup password is incorrect, or the file is damaged.") }
  } else if (value?.kty === "EC" && value.d) {
    // Import the unencrypted encryption-key exports made by earlier versions.
    const publicJwk = { ...value, key_ops: [] }
    delete publicJwk.d
    const publicKey = await importKey(publicJwk, "encryption", "public")
    value = { version: 2, publicKey: await exportPublicKeyToHex(publicKey), privateKey: value }
  }
  const identity = await validateIdentity(value)
  let existing: Identity | null = null
  try { existing = await loadIdentity() } catch { /* A valid backup may repair corrupt local state. */ }
  if (existing && existing.publicKey !== identity.publicKey) throw new Error("A different identity is already saved here. Use a separate browser profile to restore this one.")
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
  return identity
}

export interface Contact { pub: string; alias: string }
export function loadContacts(owner: string): Contact[] {
  const key = `serotine_contacts:${owner}`
  let raw = localStorage.getItem(key)
  if (!raw && localStorage.getItem("serotine_identity_public_enc") === owner) {
    raw = localStorage.getItem("serotine_contacts_v2") || localStorage.getItem("serotine_contacts")
  }
  if (!raw) return []
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error("Saved contacts could not be read. Your identity and messages are still stored.") }
  if (!Array.isArray(parsed)) throw new Error("Saved contacts have an invalid format.")
  const contacts = parsed.map(c => typeof c === "string" ? { pub: c, alias: "" } : c)
    .filter((c): c is Contact => c && typeof c.pub === "string" && PUBLIC_KEY_PATTERN.test(c.pub.toLowerCase()))
    .map(c => ({ pub: c.pub.toLowerCase(), alias: typeof c.alias === "string" ? c.alias.slice(0, 60) : "" }))
  return contacts.filter((c, index) => c.pub !== owner && contacts.findIndex(other => other.pub === c.pub) === index)
}
export function saveContacts(owner: string, contacts: Contact[]) {
  localStorage.setItem(`serotine_contacts:${owner}`, JSON.stringify(contacts))
  window.dispatchEvent(new Event("serotine:contacts"))
}
export const shortAddress = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`
