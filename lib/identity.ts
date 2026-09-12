import { exportKey, exportPublicKeyToHex, generateEncryptionKeyPair, importKey, importPublicKeyFromHex, arrayBufferToBase64, base64ToArrayBuffer } from "./crypto"
import { PUBLIC_KEY_PATTERN } from "./protocol"
import { createRequestProof, verifyRequestProof } from "./request-auth"

const IDENTITY_KEY = "serotine_identity_v2"
const ARCHIVED_IDENTITIES_KEY = "serotine_identity_archives_v1"
export interface Identity { version: 2; publicKey: string; privateKey: JsonWebKey }
export interface ArchivedIdentity extends Identity { retired?: boolean }
export class IdentityAccessError extends Error {}
export class IdentityConflictError extends Error {
  constructor(public existingPublicKey: string, public backupPublicKey: string) {
    super("A different identity is already saved here. Confirm switching to the backup identity to continue.")
  }
}
export interface RestoreIdentityOptions {
  /** Confirmation is tied to the exact identity shown to the user. */
  replaceIdentity?: string
}

let identityWrites: Promise<void> = Promise.resolve()
function mutateIdentity<T>(action: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => typeof navigator !== "undefined" && navigator.locks
    ? await navigator.locks.request("serotine:identity", action) : await action()
  const result = identityWrites.then(run, run)
  identityWrites = result.then(() => {}, () => {})
  return result
}
function identitySnapshot() {
  try { return [IDENTITY_KEY, "serotine_identity_public_enc", "serotine_identity_private_enc"].map(key => localStorage.getItem(key)) }
  catch { throw new IdentityAccessError("Browser storage is blocked. Allow storage for this site, then check again.") }
}
function saveIdentity(identity: Identity, expected: (string | null)[]) {
  if (identitySnapshot().some((value, index) => value !== expected[index])) {
    throw new IdentityAccessError("The identity changed in another tab. Check again before continuing.")
  }
  try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)) }
  catch { throw new IdentityAccessError("Your identity could not be saved. Check available browser storage and try again.") }
}

/** Switching identities keeps the previous key and its separately stored history recoverable. */
export async function loadArchivedIdentities(): Promise<ArchivedIdentity[]> {
  let raw: string | null
  try { raw = localStorage.getItem(ARCHIVED_IDENTITIES_KEY) }
  catch { throw new IdentityAccessError("Browser storage is blocked. Allow storage for this site, then check again.") }
  if (!raw) return []
  let values: unknown
  try { values = JSON.parse(raw) } catch { throw new Error("Saved previous identities could not be read. They have not been changed.") }
  if (!Array.isArray(values)) throw new Error("Saved previous identities could not be read. They have not been changed.")
  const identities = await Promise.all(values.map(validateIdentity))
  try { return identities.map(identity => ({ ...identity, retired: localStorage.getItem(`serotine_retired_identity:${identity.publicKey}`) === "retired" })) }
  catch { throw new IdentityAccessError("Saved identity status could not be read. Allow browser storage and try again.") }
}

/** Persist recovery keys before permanently retiring an address at the relay. */
export async function replaceRetiredIdentity(expectedPublicKey: string, retire: () => Promise<void>): Promise<Identity> {
  return mutateIdentity(async () => {
    const before = identitySnapshot()
    const existing = await loadIdentity()
    if (!existing || existing.publicKey !== expectedPublicKey) throw new IdentityAccessError("The identity changed. Open Security again before continuing.")
    const pendingKey = `serotine_identity_replacement:${existing.publicKey}`
    const retiredKey = `serotine_retired_identity:${existing.publicKey}`
    let pending: string | null
    try { pending = localStorage.getItem(pendingKey) }
    catch { throw new IdentityAccessError("Browser storage is blocked. Allow storage before replacing your identity.") }
    const archived = await loadArchivedIdentities()
    let replacement: Identity | null = pending ? await validateIdentity(JSON.parse(pending)) : null
    // An archived replacement has already been activated and switched away from.
    // This also detects completed attempts if removing the staging key failed.
    if (replacement && (archived.some(item => item.publicKey === replacement!.publicKey)
      || localStorage.getItem(`serotine_retired_identity:${replacement.publicKey}`) === "retired")) replacement = null
    if (!replacement) {
      const pair = await generateEncryptionKeyPair()
      replacement = { version: 2, publicKey: await exportPublicKeyToHex(pair.publicKey), privateKey: await exportKey(pair.privateKey) }
    }
    if (replacement.publicKey === existing.publicKey) throw new Error("The saved replacement identity is invalid. Nothing was retired.")
    const contacts = new Map(loadContacts(existing.publicKey).filter(contact => contact.pub !== replacement.publicKey).map(contact => [contact.pub, contact]))
    for (const contact of loadContacts(replacement.publicKey)) contacts.set(contact.pub, contact.alias ? contact : contacts.get(contact.pub) ?? contact)
    if (identitySnapshot().some((entry, index) => entry !== before[index])) throw new IdentityAccessError("The identity changed in another tab. Check again before continuing.")
    if (typeof window !== "undefined") window.dispatchEvent(new Event("serotine:identity-changing"))
    try {
      // All recovery material and contact copies must be durable before the
      // irreversible request. An ambiguous network failure retries the same key.
      try {
        localStorage.setItem(pendingKey, JSON.stringify(replacement))
        localStorage.setItem(ARCHIVED_IDENTITIES_KEY, JSON.stringify([...archived.filter(item => item.publicKey !== existing.publicKey), existing]))
        saveContacts(replacement.publicKey, [...contacts.values()])
        if (localStorage.getItem(retiredKey) !== "retired") localStorage.setItem(retiredKey, "pending")
      } catch { throw new IdentityAccessError("Recovery keys could not be saved. Free browser storage and try again; no retirement request was sent.") }
      await retire()
      try { localStorage.setItem(retiredKey, "retired") }
      catch { throw new IdentityAccessError("Your old address was retired, but the replacement could not be activated. Keep this browser data and retry; your replacement key is saved.") }
      try { saveIdentity(replacement, before) }
      catch { throw new IdentityAccessError("Your old address was retired, but the replacement could not be activated. Keep this browser data and retry; your replacement key is saved.") }
      try { localStorage.removeItem(pendingKey) } catch { /* Later switches archive this replacement, so it cannot be reused. */ }
      return replacement
    } finally {
      if (typeof window !== "undefined") window.dispatchEvent(new Event("serotine:identity-changed"))
    }
  })
}

/** Hold the identity lock through owner-scoped data import, then activate the identity last. */
export async function restoreValidatedIdentity(value: Identity, options: RestoreIdentityOptions = {}, importData?: (identity: Identity) => Promise<void>): Promise<Identity> {
  const identity = await validateIdentity(value)
  return mutateIdentity(async () => {
    const before = identitySnapshot()
    let existing: Identity | null = null
    try { existing = await loadIdentity() } catch (cause) {
      if (cause instanceof IdentityAccessError) throw cause
      // A valid backup may repair corrupt local state, but never blocked access.
    }
    if (options.replaceIdentity !== undefined && existing?.publicKey !== options.replaceIdentity) {
      throw new IdentityAccessError("The identity changed in another tab. Review this backup again before switching.")
    }
    const switchingFrom = existing && existing.publicKey !== identity.publicKey ? existing : null
    if (switchingFrom && options.replaceIdentity !== switchingFrom.publicKey) throw new IdentityConflictError(switchingFrom.publicKey, identity.publicKey)
    const archived = switchingFrom ? await loadArchivedIdentities() : []
    if (identitySnapshot().some((entry, index) => entry !== before[index])) {
      throw new IdentityAccessError("The identity changed in another tab. Check again before continuing.")
    }
    if (typeof window !== "undefined") window.dispatchEvent(new Event("serotine:identity-changing"))
    try {
      if (switchingFrom) {
        try { localStorage.setItem(ARCHIVED_IDENTITIES_KEY, JSON.stringify([...archived.filter(item => item.publicKey !== switchingFrom.publicKey), switchingFrom])) }
        catch { throw new IdentityAccessError("Your current identity could not be preserved. Free browser storage and try again; no identity was switched.") }
      }
      await importData?.(identity)
      saveIdentity(identity, before)
      return identity
    } finally {
      if (typeof window !== "undefined") window.dispatchEvent(new Event("serotine:identity-changed"))
    }
  })
}

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
  if (!globalThis.crypto?.subtle) throw new IdentityAccessError("Use an up-to-date browser over HTTPS to open Serotine.")
  const [saved, publicKey, privateKey] = identitySnapshot()
  if (saved) return validateIdentity(JSON.parse(saved))
  if (!publicKey && !privateKey) return null
  if (!publicKey || !privateKey) throw new Error("Your local identity is incomplete. Restore your backup to continue.")
  // Reading a legacy identity must not race a create/restore write in another tab.
  return validateIdentity({ version: 2, publicKey: publicKey.toLowerCase(), privateKey: JSON.parse(privateKey) })
}

export async function createIdentity(): Promise<Identity> {
  return mutateIdentity(async () => {
    const before = identitySnapshot()
    if (await loadIdentity()) throw new Error("An identity already exists on this browser.")
    const pair = await generateEncryptionKeyPair()
    const identity: Identity = { version: 2, publicKey: await exportPublicKeyToHex(pair.publicKey), privateKey: await exportKey(pair.privateKey) }
    saveIdentity(identity, before)
    return identity
  })
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

export async function restoreIdentityBackup(text: string, password: string, options: RestoreIdentityOptions = {}): Promise<Identity> {
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
  return restoreValidatedIdentity(value, options)
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
