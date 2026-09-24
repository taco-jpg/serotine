import { openDB, type DBSchema } from "idb"
import type { AttachmentMeta } from "./messaging-types"
import { nativeStorageLimits } from "./native-persistence"
interface CacheDB extends DBSchema {
  files: { key: string; value: { id: string; digest: string; size: number; blob: Blob } }
  unavailable: { key: string; value: number }
}
const key = (metadata: AttachmentMeta) => `${metadata.id}:${metadata.sha256}`
async function database(owner: string) {
  return openDB<CacheDB>(`serotine-verified-attachments:${owner}`, 2, { upgrade(db) {
    if (!db.objectStoreNames.contains("files")) db.createObjectStore("files")
    if (!db.objectStoreNames.contains("unavailable")) db.createObjectStore("unavailable")
  } })
}
/** Only call after all ciphertext hashes, AEAD tags and final sink close have
 * succeeded. A failed durable write must never authorize server deletion. */
export async function cacheVerifiedAttachment(owner: string, metadata: AttachmentMeta, blob: Blob): Promise<void> {
  if (blob.size !== metadata.size) throw new Error("The local attachment copy is incomplete.")
  const nativeLimit = nativeStorageLimits()?.fileBytes
  if (nativeLimit !== undefined && blob.size > nativeLimit) throw new Error("This attachment exceeds the installed beta's 16 MB local file limit. Its relay copy was not authorized for deletion.")
  const db = await database(owner)
  try { await db.put("files", { id: metadata.id, digest: metadata.sha256, size: metadata.size, blob }, key(metadata)) }
  finally { db.close() }
}
export async function getVerifiedAttachment(owner: string, metadata: AttachmentMeta): Promise<Blob | undefined> {
  const db = await database(owner)
  try {
    const saved = await db.get("files", key(metadata))
    return saved && saved.id === metadata.id && saved.digest === metadata.sha256 && saved.size === metadata.size && saved.blob.size === metadata.size ? saved.blob : undefined
  } finally { db.close() }
}

/** Authenticated 410 responses are permanent for this upload/digest. A valid
 * local copy always takes precedence over this marker. */
export async function markAttachmentUnavailable(owner: string, metadata: AttachmentMeta): Promise<void> {
  const db = await database(owner)
  try { await db.put("unavailable", Date.now(), key(metadata)) } finally { db.close() }
}
export async function isAttachmentUnavailable(owner: string, metadata: AttachmentMeta): Promise<boolean> {
  const db = await database(owner)
  try { return await db.get("unavailable", key(metadata)) !== undefined } finally { db.close() }
}
