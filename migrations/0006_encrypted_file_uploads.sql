-- Ciphertext is held in the private serotine_files R2 bucket, never D1 events.
CREATE TABLE IF NOT EXISTS FileUpload (
  uploadId TEXT PRIMARY KEY, owner TEXT NOT NULL, size INTEGER NOT NULL,
  chunkCount INTEGER NOT NULL, accessHash TEXT NOT NULL, status TEXT NOT NULL,
  createdAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
  reservedBytes INTEGER NOT NULL, cleanupAt INTEGER NOT NULL DEFAULT 0,
  deletedAt INTEGER
);
CREATE INDEX IF NOT EXISTS idx_file_upload_owner ON FileUpload(owner, status);
CREATE INDEX IF NOT EXISTS idx_file_upload_cleanup ON FileUpload(status, expiresAt, cleanupAt);
CREATE TABLE IF NOT EXISTS FileUploadChunk (
  uploadId TEXT NOT NULL, chunkIndex INTEGER NOT NULL, size INTEGER NOT NULL,
  digest TEXT NOT NULL, ready INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(uploadId, chunkIndex)
);
