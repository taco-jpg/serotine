import type { D1DatabaseBinding } from "./db"

// Separate from the acknowledged v2 queue: one device cannot remove another
// device's synchronization history. AUTOINCREMENT survives expiry and deletion.
const statements = [
  `CREATE TABLE IF NOT EXISTS RelayEvent (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    senderPubKey TEXT NOT NULL,
    recipientPubKey TEXT NOT NULL,
    encryptedData TEXT NOT NULL,
    payloadBytes INTEGER NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    UNIQUE(recipientPubKey, senderPubKey, id)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_event_recipient_sequence ON RelayEvent(recipientPubKey, sequence)",
  "CREATE INDEX IF NOT EXISTS idx_event_sender_sequence ON RelayEvent(senderPubKey, sequence)",
  "CREATE INDEX IF NOT EXISTS idx_event_expiry ON RelayEvent(expiresAt)",
  `CREATE TABLE IF NOT EXISTS RelayEventUsage (
    senderPubKey TEXT PRIMARY KEY,
    eventCount INTEGER NOT NULL,
    payloadBytes INTEGER NOT NULL
  )`,
  `CREATE TRIGGER IF NOT EXISTS relay_event_usage_insert AFTER INSERT ON RelayEvent BEGIN
    INSERT INTO RelayEventUsage(senderPubKey, eventCount, payloadBytes) VALUES(NEW.senderPubKey, 1, NEW.payloadBytes)
      ON CONFLICT(senderPubKey) DO UPDATE SET eventCount = eventCount + 1, payloadBytes = payloadBytes + NEW.payloadBytes;
  END`,
  `CREATE TRIGGER IF NOT EXISTS relay_event_usage_delete AFTER DELETE ON RelayEvent BEGIN
    UPDATE RelayEventUsage SET eventCount = eventCount - 1, payloadBytes = payloadBytes - OLD.payloadBytes WHERE senderPubKey = OLD.senderPubKey;
    DELETE FROM RelayEventUsage WHERE senderPubKey = OLD.senderPubKey AND eventCount = 0;
  END`,
] as const

const initialized = new WeakSet<D1DatabaseBinding>()
const expectedObjects = ["RelayEvent", "RelayEventUsage", "idx_event_recipient_sequence", "idx_event_sender_sequence",
  "idx_event_expiry", "relay_event_usage_insert", "relay_event_usage_delete"]

export async function ensureEventRelaySchema(db: D1DatabaseBinding): Promise<void> {
  if (initialized.has(db)) return
  // Never share in-flight Worker I/O between requests. Partial setup is safe to retry.
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')").all<{ name: string }>()
  const present = new Set(results.map(row => row.name))
  if (expectedObjects.some(name => !present.has(name))) {
    if (db.batch) await db.batch(statements.map(statement => db.prepare(statement)))
    else for (const statement of statements) await db.prepare(statement).run()
  }
  await db.prepare("SELECT sequence, id, senderPubKey, recipientPubKey, encryptedData, payloadBytes, createdAt, expiresAt FROM RelayEvent LIMIT 0").all()
  await db.prepare("SELECT senderPubKey, eventCount, payloadBytes FROM RelayEventUsage LIMIT 0").all()
  initialized.add(db)
}
