import type { D1DatabaseBinding } from "./db"

export const CALL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS CallPresence (
    publicKey TEXT NOT NULL, sessionId TEXT NOT NULL, peers TEXT NOT NULL, incomingPeers TEXT NOT NULL, expiresAt INTEGER NOT NULL,
    PRIMARY KEY(publicKey, sessionId)
  )`,
  "CREATE INDEX IF NOT EXISTS idx_call_presence_expiry ON CallPresence(expiresAt)",
  `CREATE TABLE IF NOT EXISTS CallSession (
    callId TEXT PRIMARY KEY, caller TEXT NOT NULL, recipient TEXT NOT NULL,
    callerSession TEXT NOT NULL, recipientSession TEXT,
    status TEXT NOT NULL, createdAt INTEGER NOT NULL, inviteExpiresAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL, callerAliveUntil INTEGER NOT NULL, recipientAliveUntil INTEGER NOT NULL,
    reason TEXT, noHistory INTEGER NOT NULL DEFAULT 0
  )`,
  "CREATE INDEX IF NOT EXISTS idx_call_caller ON CallSession(caller, status, expiresAt)",
  "CREATE INDEX IF NOT EXISTS idx_call_recipient ON CallSession(recipient, status, expiresAt)",
  "CREATE INDEX IF NOT EXISTS idx_call_expiry ON CallSession(expiresAt)",
  `CREATE TABLE IF NOT EXISTS CallSignal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    callId TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL,
    senderSession TEXT NOT NULL, targetSession TEXT, expiresAt INTEGER NOT NULL, encryptedData TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_call_signal_recipient ON CallSignal(recipient, sequence)",
  "CREATE INDEX IF NOT EXISTS idx_call_signal_call ON CallSignal(callId)",
  "CREATE INDEX IF NOT EXISTS idx_call_signal_expiry ON CallSignal(expiresAt)",
] as const
const ready = new WeakSet<D1DatabaseBinding>()
export async function ensureCallRelaySchema(db: D1DatabaseBinding) {
  if (ready.has(db)) return
  if (db.batch) await db.batch(CALL_SCHEMA.map(sql => db.prepare(sql)))
  else for (const sql of CALL_SCHEMA) await db.prepare(sql).run()
  await db.prepare("SELECT callId, callerAliveUntil, recipientAliveUntil FROM CallSession LIMIT 0").all()
  ready.add(db)
}
