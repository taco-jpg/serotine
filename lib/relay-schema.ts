import type { D1DatabaseBinding } from "./db"

// This additive bootstrap must stay identical to migration 0002. Regression tests
// compare the resulting SQLite schema. It never touches legacy tables or rows.
const statements: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS RequestNonce (\n  publicKey TEXT NOT NULL,\n  nonce TEXT NOT NULL,\n  action TEXT NOT NULL,\n  expiresAt INTEGER NOT NULL,\n  PRIMARY KEY (publicKey, nonce)\n)",
  "CREATE INDEX IF NOT EXISTS idx_nonce_expiry ON RequestNonce(expiresAt)",
  "CREATE INDEX IF NOT EXISTS idx_nonce_rate ON RequestNonce(publicKey, action, expiresAt)",
  "CREATE TABLE IF NOT EXISTS RelayMessage (\n  id TEXT NOT NULL,\n  senderPubKey TEXT NOT NULL,\n  recipientPubKey TEXT NOT NULL,\n  encryptedData TEXT NOT NULL,\n  createdAt INTEGER NOT NULL,\n  expiresAt INTEGER NOT NULL,\n  PRIMARY KEY (recipientPubKey, senderPubKey, id)\n)",
  "CREATE INDEX IF NOT EXISTS idx_relay_conversation ON RelayMessage(recipientPubKey, senderPubKey, createdAt)",
  "CREATE INDEX IF NOT EXISTS idx_relay_expiry ON RelayMessage(expiresAt)",
  "CREATE INDEX IF NOT EXISTS idx_relay_sender ON RelayMessage(senderPubKey)",
  "CREATE TABLE IF NOT EXISTS RelaySignal (\n  senderPubKey TEXT NOT NULL,\n  recipientPubKey TEXT NOT NULL,\n  encryptedData TEXT NOT NULL,\n  expiresAt INTEGER NOT NULL,\n  PRIMARY KEY (senderPubKey, recipientPubKey)\n)",
  "CREATE INDEX IF NOT EXISTS idx_signal_expiry ON RelaySignal(expiresAt)"
]
const expectedObjects = [
  "RequestNonce", "RelayMessage", "RelaySignal", "idx_nonce_expiry",
  "idx_nonce_rate", "idx_relay_conversation", "idx_relay_expiry",
  "idx_relay_sender", "idx_signal_expiry",
]
const initialized = new WeakSet<D1DatabaseBinding>()

async function initialize(db: D1DatabaseBinding) {
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all<{ name: string }>()
  const present = new Set(results.map(row => row.name))
  if (expectedObjects.some(name => !present.has(name))) {
    // Concurrent workers may both initialize: each statement is idempotent.
    // If a request fails midway, a later request can finish the remaining work.
    if (db.batch) await db.batch(statements.map(statement => db.prepare(statement)))
    else for (const statement of statements) await db.prepare(statement).run()
  }
  // Validate required columns without reading message, signal, or nonce data.
  await db.prepare("SELECT publicKey, nonce, action, expiresAt FROM RequestNonce LIMIT 0").all()
  await db.prepare("SELECT id, senderPubKey, recipientPubKey, encryptedData, createdAt, expiresAt FROM RelayMessage LIMIT 0").all()
  await db.prepare("SELECT senderPubKey, recipientPubKey, encryptedData, expiresAt FROM RelaySignal LIMIT 0").all()
}

export async function ensureRelaySchema(db: D1DatabaseBinding): Promise<void> {
  if (initialized.has(db)) return
  // Only completed readiness crosses requests. Worker I/O belongs to the
  // request that created it, so concurrent requests do not share a promise.
  await initialize(db)
  initialized.add(db)
}
