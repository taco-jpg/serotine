CREATE TABLE IF NOT EXISTS FileDelivery(uploadId TEXT PRIMARY KEY, messageId TEXT NOT NULL, manifestHash TEXT NOT NULL,
  scopeId TEXT NOT NULL, kind TEXT NOT NULL, sentAt INTEGER NOT NULL, required TEXT NOT NULL, completed TEXT NOT NULL DEFAULT '[]');
CREATE INDEX IF NOT EXISTS idx_file_delivery_scope ON FileDelivery(scopeId);
CREATE TABLE IF NOT EXISTS FileUploadTombstone(uploadId TEXT PRIMARY KEY, owner TEXT NOT NULL, retiredAt INTEGER NOT NULL);
