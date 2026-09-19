import { migrateRelayPayloads, type PayloadBucket } from './relay-payloads'
import { cleanupFileUploads, type FileUploadBucket } from './file-upload-relay'
import { recordD1Result, type StorageEnvironment } from './storage-routing'
import { maintainRetentionStorage } from './retention-server'

/** Cloudflare Cron only. Bounded migration/retention work is separate from
 * presence, call heartbeats and inbox polls. No user or request proofs needed. */
export async function maintainRelayStorage(env: StorageEnvironment & { serotine_files?: PayloadBucket & FileUploadBucket }) {
  if (env.SEROTINE_STORAGE_VERSION !== '2' || !env.serotine_files) throw new Error('Storage v2 bindings are required')
  const db = env.serotine_db
  await maintainRetentionStorage(db, env.serotine_files)
  // Legacy inline bodies remain readable until their verified copy completes.
  const migrated = await migrateRelayPayloads(db, env.serotine_files, 16)
  for (const table of ['RelayEvent', 'RelayMessage']) {
    if (!await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(table).first()) continue
    const sql = `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE expiresAt <= ? LIMIT 128)`
    const result = await db.prepare(sql).bind(Date.now()).run()
    recordD1Result(sql, result, env.SEROTINE_D1_METRICS === '1')
  }
  if (await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='FileUpload'").first()) {
    await cleanupFileUploads(db, env.serotine_files, Date.now(), 4)
  }
  console.info(JSON.stringify({ metric: 'serotine.payload_migration', migrated }))
}
