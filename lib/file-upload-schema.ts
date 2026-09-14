import type { D1DatabaseBinding } from "./db"

export const FILE_UPLOAD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS FileUpload (
    uploadId TEXT PRIMARY KEY, owner TEXT NOT NULL, size INTEGER NOT NULL,
    chunkCount INTEGER NOT NULL, accessHash TEXT NOT NULL, status TEXT NOT NULL,
    createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
    reservedBytes INTEGER NOT NULL, cleanupAt INTEGER NOT NULL DEFAULT 0,
    deletedAt INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS idx_file_upload_owner ON FileUpload(owner, status)",
  "CREATE INDEX IF NOT EXISTS idx_file_upload_cleanup ON FileUpload(status, expiresAt, cleanupAt)",
  `CREATE TABLE IF NOT EXISTS FileUploadChunk (
    uploadId TEXT NOT NULL, chunkIndex INTEGER NOT NULL, size INTEGER NOT NULL,
    digest TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(uploadId, chunkIndex)
  )`,
] as const
const ready = new WeakSet<D1DatabaseBinding>()
export async function ensureFileUploadSchema(db: D1DatabaseBinding): Promise<void> {
  if (ready.has(db)) return
  if (db.batch) await db.batch(FILE_UPLOAD_SCHEMA.map(sql => db.prepare(sql)))
  else for (const sql of FILE_UPLOAD_SCHEMA) await db.prepare(sql).run()
  await db.prepare("SELECT uploadId, reservedBytes, cleanupAt FROM FileUpload LIMIT 0").all()
  ready.add(db)
}
