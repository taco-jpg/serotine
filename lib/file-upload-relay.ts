import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getDB, type D1DatabaseBinding } from "./db"
import { ensureIdentityRetirementSchema } from "./identity-retirement-schema"
import { ensureFileUploadSchema } from "./file-upload-schema"
import { AUTH_WINDOW_MS, type RequestProof } from "./protocol"
import { requestProofFailureMessage, verifyRequestProofResult } from "./request-auth"
import {
  FILE_UPLOAD_CHUNK_BYTES, FILE_UPLOAD_OWNER_QUOTA_BYTES, FILE_UPLOAD_RETENTION_TTL_MS,
  FILE_UPLOAD_STAGING_TTL_MS, FILE_UPLOAD_TOTAL_QUOTA_BYTES, MAX_FILE_UPLOAD_BYTES,
  fileUploadChunkCount, fileUploadChunkSize, fileUploadDigest,
  isFileUploadHash, isFileUploadId, isFileUploadObject,
  type FileUploadConfiguration, type FileUploadReceipt,
} from "./file-upload-protocol"

/** Deliberately small R2 surface, also used by the integration tests. */
export interface FileUploadBucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata: { contentType: string } }): Promise<unknown>
  get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>
  delete(keys: string | string[]): Promise<void>
}
interface UploadRow {
  uploadId: string; owner: string; size: number; chunkCount: number; accessHash: string
  status: FileUploadReceipt["status"]; createdAt: number; expiresAt: number
  reservedBytes: number; cleanupAt: number; deletedAt: number | null
}
interface ChunkRow { uploadId: string; chunkIndex: number; size: number; digest: string; ready: number }
export class FileUploadError extends Error {
  constructor(message: string, public status = 400, public code?: "files-unavailable" | "file-expired" | "file-quota") { super(message) }
}
const invalid = () => new FileUploadError("Invalid file upload request. Reload Serotine and retry.")
const unavailable = () => new FileUploadError("Large file uploads are not configured on this server. The site owner needs to connect the private serotine_files R2 bucket.", 503, "files-unavailable")
const fileKey = (uploadId: string, index: number) => `encrypted-files/v1/${uploadId}/${index}`
const receipt = (row: UploadRow): FileUploadReceipt => ({ success: true, uploadId: row.uploadId, status: row.status, expiresAt: row.expiresAt })
function shape(data: unknown, fields: string[]): asserts data is Record<string, unknown> {
  if (!isFileUploadObject(data) || Object.keys(data).length !== fields.length || !fields.every(field => Object.hasOwn(data, field))) throw invalid()
}
async function bucket(required = true): Promise<FileUploadBucket | null> {
  const { env } = await getCloudflareContext({ async: true })
  const value = (env as unknown as { serotine_files?: FileUploadBucket }).serotine_files
  if (!value || typeof value.put !== "function" || typeof value.get !== "function" || typeof value.delete !== "function") {
    if (required) throw unavailable()
    return null
  }
  return value
}
export async function fileUploadConfiguration(): Promise<FileUploadConfiguration> {
  let available = false
  try { available = !!await bucket(false) } catch { /* An older deployment can keep its existing small-file transport. */ }
  return { success: true, available, maxFileBytes: MAX_FILE_UPLOAD_BYTES, chunkBytes: FILE_UPLOAD_CHUNK_BYTES,
    stagingTtlMs: FILE_UPLOAD_STAGING_TTL_MS, retentionTtlMs: FILE_UPLOAD_RETENTION_TTL_MS }
}
async function authorize(action: string, data: unknown, proof: RequestProof) {
  const verified = await verifyRequestProofResult(action, data, proof)
  if (!verified.valid) throw new FileUploadError(requestProofFailureMessage(verified), 401)
  const files = (await bucket())!
  const db = await getDB()
  await ensureIdentityRetirementSchema(db)
  if (await db.prepare("SELECT 1 FROM RetiredIdentity WHERE publicKey = ?").bind(proof.publicKey).first()) {
    throw new FileUploadError("This identity has been retired. Use your current address.", 403)
  }
  const now = Date.now()
  await db.prepare("DELETE FROM RequestNonce WHERE rowid IN (SELECT rowid FROM RequestNonce WHERE expiresAt <= ? LIMIT 256)").bind(now).run()
  const nonce = await db.prepare("INSERT OR IGNORE INTO RequestNonce(publicKey, nonce, action, expiresAt) VALUES (?, ?, ?, ?)")
    .bind(proof.publicKey, proof.nonce, action, Math.max(now, proof.timestamp) + AUTH_WINDOW_MS).run()
  if (nonce.meta.changes !== 1) throw new FileUploadError("This file request was already used. Retry the action.", 409)
  const rate = await db.prepare("SELECT COUNT(*) AS count FROM RequestNonce WHERE publicKey = ? AND action = ? AND expiresAt > ?")
    .bind(proof.publicKey, action, now).first<{ count: number }>()
  const limit = action === "file:init" ? 20 : action === "file:cleanup" ? 6 : 600
  if ((rate?.count ?? 0) > limit) throw new FileUploadError("Too many file requests. Wait a minute and retry.", 429)
  await ensureFileUploadSchema(db)
  return { db, files, now }
}
async function rowFor(db: D1DatabaseBinding, uploadId: unknown, owner?: string): Promise<UploadRow> {
  if (!isFileUploadId(uploadId)) throw invalid()
  const row = await db.prepare("SELECT * FROM FileUpload WHERE uploadId = ?").bind(uploadId).first<UploadRow>()
  if (!row || (owner && owner !== row.owner)) throw new FileUploadError("This file upload is unavailable.", 404)
  return row
}
function active(row: UploadRow, now: number) {
  if (row.status === "deleted" || row.expiresAt <= now) throw new FileUploadError("This file upload expired or was removed. Attach the file again.", 410, "file-expired")
}

/** Logical deletion precedes physical deletion, so no late completion can revive a file.
 * Keep tombstones/chunk keys for 32 days: a later cleanup retries interrupted deletes
 * and catches a writer that stopped after R2.put but before its final D1 check.
 * A 33-day R2 lifecycle rule is the final no-traffic/crashed-worker cleanup backstop.
 */
async function deleteUpload(db: D1DatabaseBinding, files: FileUploadBucket, row: UploadRow, now: number, cancelOnly = false) {
  const updated = await db.prepare(`UPDATE FileUpload SET status = 'deleted', deletedAt = COALESCE(deletedAt, ?), cleanupAt = 0
    WHERE uploadId = ? AND ((? = 1 AND status IN ('staged', 'ready', 'deleted'))
      OR (? = 0 AND (status = 'deleted' OR expiresAt <= ? OR owner IN (SELECT publicKey FROM RetiredIdentity))))`)
    .bind(now, row.uploadId, cancelOnly ? 1 : 0, cancelOnly ? 1 : 0, now).run()
  // Once Send publishes a capability, uncertain delivery must not be broken by
  // a later composer discard. The conditional update arbitrates that race.
  if (!updated.meta.changes) return false
  // All possible chunk keys are bounded (256), including a concurrent writer.
  await files.delete(Array.from({ length: row.chunkCount }, (_, index) => fileKey(row.uploadId, index)))
  await db.prepare("UPDATE FileUpload SET reservedBytes = 0, cleanupAt = ? WHERE uploadId = ? AND status = 'deleted'")
    .bind(now + 60 * 60_000, row.uploadId).run()
  return true
}
export async function cleanupFileUploads(db: D1DatabaseBinding, files: FileUploadBucket, now = Date.now(), limit = 2): Promise<number> {
  const safeLimit = Math.max(1, Math.min(4, Math.floor(limit)))
  const { results } = await db.prepare(`SELECT * FROM FileUpload WHERE
    (status != 'deleted' AND (expiresAt <= ? OR owner IN (SELECT publicKey FROM RetiredIdentity)))
    OR (status = 'deleted' AND cleanupAt <= ?)
    ORDER BY cleanupAt, expiresAt LIMIT ?`).bind(now, now, safeLimit).all<UploadRow>()
  for (const row of results) {
    await deleteUpload(db, files, row, now)
    if (row.deletedAt !== null && row.deletedAt < now - 32 * 24 * 60 * 60_000) {
      await db.prepare("DELETE FROM FileUploadChunk WHERE uploadId = ?").bind(row.uploadId).run()
      await db.prepare("DELETE FROM FileUpload WHERE uploadId = ? AND status = 'deleted' AND reservedBytes = 0").bind(row.uploadId).run()
    }
  }
  return results.length
}

export async function handleFileUploadRequest(action: string, data: unknown, proof: RequestProof): Promise<FileUploadReceipt | { success: true } | Response> {
  if (!["file:init", "file:complete", "file:publish", "file:delete", "file:read", "file:cleanup"].includes(action)) throw invalid()
  shape(data, action === "file:init" ? ["uploadId", "size", "chunkCount", "accessHash"]
    : action === "file:read" ? ["uploadId", "index", "capability"] : action === "file:cleanup" ? [] : ["uploadId"])
  const { db, files, now } = await authorize(action, data, proof)
  if (action === "file:cleanup") {
    await cleanupFileUploads(db, files, now, 4)
    return { success: true }
  }
  if (action === "file:init") {
    if (!isFileUploadId(data.uploadId) || !isFileUploadHash(data.accessHash) || !Number.isSafeInteger(data.size)
      || Number(data.size) < 1 || Number(data.size) > MAX_FILE_UPLOAD_BYTES
      || data.chunkCount !== fileUploadChunkCount(Number(data.size))) throw invalid()
    // Reclaim actual expired objects before releasing their reserved quota.
    await cleanupFileUploads(db, files, now)
    await db.prepare(`INSERT OR IGNORE INTO FileUpload(uploadId, owner, size, chunkCount, accessHash, status, createdAt, expiresAt, reservedBytes)
      SELECT ?, ?, ?, ?, ?, 'staged', ?, ?, ? WHERE
      (SELECT COALESCE(SUM(reservedBytes), 0) FROM FileUpload WHERE owner = ?) <= ?
      AND (SELECT COALESCE(SUM(reservedBytes), 0) FROM FileUpload) <= ?
      AND (SELECT COUNT(*) FROM FileUpload WHERE owner = ? AND status != 'deleted') < 100`)
      .bind(data.uploadId, proof.publicKey, data.size, data.chunkCount, data.accessHash, now, now + FILE_UPLOAD_STAGING_TTL_MS,
        data.size, proof.publicKey, FILE_UPLOAD_OWNER_QUOTA_BYTES - Number(data.size), FILE_UPLOAD_TOTAL_QUOTA_BYTES - Number(data.size), proof.publicKey).run()
    const row = await db.prepare("SELECT * FROM FileUpload WHERE uploadId = ?").bind(data.uploadId).first<UploadRow>()
    if (!row) throw new FileUploadError("File storage is full. Remove old uploads or retry after they expire.", 429, "file-quota")
    if (row.owner !== proof.publicKey || row.size !== data.size || row.chunkCount !== data.chunkCount || row.accessHash !== data.accessHash) {
      throw new FileUploadError("This upload identifier is already in use. Attach the file again.", 409)
    }
    active(row, now)
    return receipt(row)
  }
  const row = await rowFor(db, data.uploadId, action === "file:read" ? undefined : proof.publicKey)
  if (action === "file:delete") {
    await deleteUpload(db, files, row, now, true)
    return receipt(await rowFor(db, row.uploadId, proof.publicKey))
  }
  active(row, now)
  if (action === "file:read") {
    if (!isFileUploadHash(data.capability) || !Number.isInteger(data.index) || Number(data.index) < 0 || Number(data.index) >= row.chunkCount) throw invalid()
    if (row.status !== "published" || row.accessHash !== await fileUploadDigest(new TextEncoder().encode(data.capability).buffer)) {
      throw new FileUploadError("This file is unavailable or you do not have access.", 404)
    }
    const chunk = await db.prepare("SELECT * FROM FileUploadChunk WHERE uploadId = ? AND chunkIndex = ? AND ready = 1")
      .bind(row.uploadId, data.index).first<ChunkRow>()
    if (!chunk) throw new FileUploadError("This file is unavailable.", 404)
    const object = await files.get(fileKey(row.uploadId, Number(data.index)))
    if (!object || object.size !== chunk.size) throw new FileUploadError("This file is unavailable.", 404)
    return new Response(object.body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(chunk.size),
      "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff", "X-Serotine-File-Digest": chunk.digest,
      "Content-Disposition": "attachment" } })
  }
  if (action === "file:complete") {
    await db.prepare(`UPDATE FileUpload SET status = 'ready' WHERE uploadId = ? AND owner = ? AND status = 'staged' AND expiresAt > ?
      AND (SELECT COUNT(*) FROM FileUploadChunk WHERE uploadId = ? AND ready = 1) = chunkCount
      AND (SELECT COALESCE(SUM(size), 0) FROM FileUploadChunk WHERE uploadId = ? AND ready = 1) = size + 16 * chunkCount`)
      .bind(row.uploadId, proof.publicKey, Date.now(), row.uploadId, row.uploadId).run()
  } else {
    const publishedAt = Date.now()
    await db.prepare("UPDATE FileUpload SET status = 'published', expiresAt = ? WHERE uploadId = ? AND owner = ? AND status = 'ready' AND expiresAt > ?")
      .bind(publishedAt + FILE_UPLOAD_RETENTION_TTL_MS, row.uploadId, proof.publicKey, publishedAt).run()
  }
  const updated = await rowFor(db, row.uploadId, proof.publicKey)
  active(updated, Date.now())
  if (updated.status === "staged" || (action === "file:publish" && updated.status !== "published")) {
    throw new FileUploadError("The file is still uploading. Wait for it to finish and retry.", 409)
  }
  return receipt(updated)
}

/** The proof is checked before reading the bounded binary body. Only its signed
 * SHA-256 digest and expected length are persisted; filenames and keys stay E2E.
 */
export async function handleFileUploadChunk(data: unknown, proof: RequestProof, readBody: (limit: number) => Promise<ArrayBuffer>): Promise<{ success: true }> {
  shape(data, ["uploadId", "index", "size", "digest"])
  if (!isFileUploadId(data.uploadId) || !isFileUploadHash(data.digest) || !Number.isSafeInteger(data.index)
    || Number(data.index) < 0 || !Number.isSafeInteger(data.size)) throw invalid()
  const { db, files, now } = await authorize("file:chunk", data, proof)
  const row = await rowFor(db, data.uploadId, proof.publicKey)
  active(row, now)
  if (Number(data.index) >= row.chunkCount || data.size !== fileUploadChunkSize(row.size, Number(data.index))) throw invalid()
  const bytes = await readBody(Number(data.size))
  if (bytes.byteLength !== data.size || await fileUploadDigest(bytes) !== data.digest) throw new FileUploadError("The uploaded file chunk failed its integrity check. Retry the upload.", 400)
  await db.prepare(`INSERT OR IGNORE INTO FileUploadChunk(uploadId, chunkIndex, size, digest)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM FileUpload WHERE uploadId = ? AND owner = ? AND status = 'staged' AND expiresAt > ?)`)
    .bind(row.uploadId, data.index, data.size, data.digest, row.uploadId, proof.publicKey, Date.now()).run()
  const chunk = await db.prepare("SELECT * FROM FileUploadChunk WHERE uploadId = ? AND chunkIndex = ?")
    .bind(row.uploadId, data.index).first<ChunkRow>()
  if (!chunk || chunk.digest !== data.digest || chunk.size !== data.size) throw new FileUploadError("This file chunk is already finalized or has changed. Attach the file again.", 409)
  if (chunk.ready) {
    active(await rowFor(db, row.uploadId, proof.publicKey), Date.now())
    return { success: true }
  }
  const current = await rowFor(db, row.uploadId, proof.publicKey)
  active(current, Date.now())
  if (current.status !== "staged") throw new FileUploadError("This file upload is already finalized.", 409)
  await files.put(fileKey(row.uploadId, Number(data.index)), bytes, { httpMetadata: { contentType: "application/octet-stream" } })
  await db.prepare(`UPDATE FileUploadChunk SET ready = 1 WHERE uploadId = ? AND chunkIndex = ? AND digest = ?
    AND EXISTS (SELECT 1 FROM FileUpload WHERE uploadId = ? AND status = 'staged' AND expiresAt > ?)`)
    .bind(row.uploadId, data.index, data.digest, row.uploadId, Date.now()).run()
  const after = await rowFor(db, row.uploadId, proof.publicKey)
  if (after.status === "deleted" || after.expiresAt <= Date.now()) {
    await files.delete(fileKey(row.uploadId, Number(data.index)))
    throw new FileUploadError("This file upload expired or was removed. Attach the file again.", 410, "file-expired")
  }
  return { success: true }
}
