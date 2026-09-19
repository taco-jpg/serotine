import { getCloudflareContext } from '@opennextjs/cloudflare'
import type { D1DatabaseBinding } from './db'

export const PAYLOAD_PREFIX = '@r2:v2:'
export interface PayloadBucket {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata: { contentType: string } }): Promise<unknown>
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; size: number } | null>
}
interface Reference { key: string; bytes: number; sha256: string }
const encoder = new TextEncoder()
const digest = async (bytes: ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
function reference(value: string): Reference | null {
  if (!value.startsWith(PAYLOAD_PREFIX)) return null
  const parsed = JSON.parse(value.slice(PAYLOAD_PREFIX.length)) as Reference
  if (!/^relay-payloads\/(?:(?:v2|legacy-v2)\/|scoped-v1\/[0-9a-f]{64}\/)[0-9a-f]{64}$/.test(parsed.key) || !/^[0-9a-f]{64}$/.test(parsed.sha256)
    || !Number.isSafeInteger(parsed.bytes) || parsed.bytes < 0 || parsed.bytes > 2 * 1024 * 1024) throw new Error('Invalid stored payload reference')
  return parsed
}
async function context() {
  const { env } = await getCloudflareContext({ async: true })
  return env as unknown as { SEROTINE_STORAGE_VERSION?: string; serotine_files?: PayloadBucket }
}
async function write(files: PayloadBucket, value: string, version = "v2"): Promise<string> {
  const bytes = encoder.encode(value)
  const sha256 = await digest(bytes.buffer)
  const key = `relay-payloads/${version}/${sha256}`
  // A content-addressed key makes retries immutable, including concurrent
  // requests reusing a message ID with a different encrypted body.
  await files.put(key, bytes.buffer, { httpMetadata: { contentType: 'application/octet-stream' } })
  return PAYLOAD_PREFIX + JSON.stringify({ key, bytes: bytes.byteLength, sha256 } satisfies Reference)
}
async function read(files: PayloadBucket, ref: Reference) {
  const object = await files.get(ref.key)
  if (!object || object.size !== ref.bytes) throw new Error('Relay payload unavailable')
  const bytes = await object.arrayBuffer()
  if (bytes.byteLength !== ref.bytes || await digest(bytes) !== ref.sha256) throw new Error('Relay payload integrity check failed')
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** All encrypted packets are opaque: older clients may embed file bytes even
 * in a small message. Externalize every packet, without trying to classify it. */
export async function storeRelayPayload(value: string, scope?: { id: string; timestamp: number; db: D1DatabaseBinding }): Promise<string> {
  const env = await context()
  if (env.SEROTINE_STORAGE_VERSION === '1') return value // pre-cutover revision compatibility
  if (!env.serotine_files) throw new Error('The serotine_files R2 binding is required')
  if (scope) {
    const bytes = encoder.encode(value), sha256 = await digest(bytes.buffer)
    const generationDigest = await digest(encoder.encode(JSON.stringify([scope.timestamp, sha256])).buffer)
    const key = `relay-payloads/scoped-v1/${scope.id}/${generationDigest}`
    // Reserve an exact cleanup key BEFORE the external write. Never sharing a
    // key between scopes makes terminal object deletion safe without scans.
    const reserved = await scope.db.prepare(`INSERT OR IGNORE INTO RetentionObject(objectKey,scopeId,eventTimestamp,expiresAt)
      SELECT ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM RetentionScope WHERE scopeId = ? AND closedAt = 0 AND boundaryAt < ?)`)
      .bind(key, scope.id, scope.timestamp, Date.now() + 8 * 86400_000, scope.id, scope.timestamp).run()
    if (!reserved.meta.changes && !await scope.db.prepare("SELECT 1 FROM RetentionObject WHERE objectKey = ?").bind(key).first()) throw new Error('Conversation retention has ended')
    await env.serotine_files.put(key, bytes.buffer, { httpMetadata: { contentType: 'application/octet-stream' } })
    const closed = await scope.db.prepare("SELECT closedAt, boundaryAt FROM RetentionScope WHERE scopeId = ?").bind(scope.id).first<{ closedAt: number; boundaryAt: number }>()
    if (!closed || closed.closedAt || scope.timestamp <= closed.boundaryAt) {
      const files = env.serotine_files as PayloadBucket & { delete(keys: string[]): Promise<void> }
      await files.delete([key])
      throw new Error('Conversation retention has ended')
    }
    return PAYLOAD_PREFIX + JSON.stringify({ key, bytes: bytes.byteLength, sha256 } satisfies Reference)
  }
  return write(env.serotine_files, value)
}
export async function hydrateRelayPayloads<T extends { encryptedData: string }>(rows: T[]): Promise<T[]> {
  if (!rows.some(row => row.encryptedData.startsWith(PAYLOAD_PREFIX))) return rows
  const env = await context()
  if (!env.serotine_files) throw new Error('The serotine_files R2 binding is required')
  // A failed read rejects the entire page. Never advance a sync cursor past
  // an unavailable body or ACK/delete a legacy packet before retrieving it.
  const result: T[] = []
  for (const row of rows) {
    const ref = reference(row.encryptedData)
    result.push(ref ? { ...row, encryptedData: await read(env.serotine_files, ref) } : row)
  }
  return result
}

/** Legacy quotas measure the original bytes, not the compact reference length. */
export const RELAY_PAYLOAD_BYTES_SQL = `CASE WHEN substr(encryptedData,1,7) = '@r2:v2:'
  THEN json_extract(substr(encryptedData,8),'$.bytes') ELSE LENGTH(CAST(encryptedData AS BLOB)) END`

/** Copy, verify, then compare-and-swap. Bounded, resumable, no new endpoint and
 * no deletion of old bodies until a verified R2 object exists. Source expiry,
 * IDs, sequence numbers, quota counters and delivery semantics are unchanged. */
export async function migrateRelayPayloads(db: D1DatabaseBinding, files: PayloadBucket, limit = 8): Promise<number> {
  let remaining = Math.max(1, Math.min(32, Math.floor(limit))), migrated = 0
  for (const table of ['RelayEvent', 'RelayMessage', 'Message']) {
    if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(table).first()) continue
    const { results } = await db.prepare(`SELECT rowid AS sourceRowid, encryptedData FROM ${table}
      WHERE substr(encryptedData,1,7) != ? ORDER BY rowid LIMIT ?`).bind(PAYLOAD_PREFIX, remaining).all<{ sourceRowid: number; encryptedData: string }>()
    for (const row of results) {
      const stored = await write(files, row.encryptedData, table === "Message" ? "legacy-v2" : "v2")
      if (await read(files, reference(stored)!) !== row.encryptedData) throw new Error('Migration verification failed')
      const updated = await db.prepare(`UPDATE ${table} SET encryptedData = ? WHERE rowid = ? AND encryptedData = ?`)
        .bind(stored, row.sourceRowid, row.encryptedData).run()
      migrated += updated.meta.changes
      if (--remaining === 0) return migrated
    }
  }
  return migrated
}
