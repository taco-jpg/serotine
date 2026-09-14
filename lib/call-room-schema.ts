import type { D1DatabaseBinding } from "./db"

// Authority checkpoints deliberately outlive calls: dropping them would let an
// old, still-valid signature restore a removed member or a departed owner.
export const CALL_ROOM_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS CallRoomAuthority (
    scopeId TEXT PRIMARY KEY, kind TEXT NOT NULL, signature TEXT NOT NULL, checkpointJson TEXT NOT NULL, stateJson TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS CallRoomMember (
    publicKey TEXT PRIMARY KEY, roomId TEXT NOT NULL, scopeId TEXT NOT NULL, channelId TEXT,
    sessionId TEXT NOT NULL, mode TEXT NOT NULL, policy TEXT NOT NULL, joinedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_call_room_member_room ON CallRoomMember(roomId, expiresAt)",
  "CREATE INDEX IF NOT EXISTS idx_call_room_member_expiry ON CallRoomMember(expiresAt)",
  `CREATE TABLE IF NOT EXISTS CallRoomSignal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, roomId TEXT NOT NULL,
    sender TEXT NOT NULL, recipient TEXT NOT NULL, senderSession TEXT NOT NULL, targetSession TEXT NOT NULL,
    expiresAt INTEGER NOT NULL, encryptedData TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_call_room_signal_recipient ON CallRoomSignal(recipient, sequence)",
  "CREATE INDEX IF NOT EXISTS idx_call_room_signal_expiry ON CallRoomSignal(expiresAt)",
] as const
const ready = new WeakSet<D1DatabaseBinding>()
export async function ensureCallRoomSchema(db: D1DatabaseBinding) {
  if (ready.has(db)) return
  if (db.batch) await db.batch(CALL_ROOM_SCHEMA.map(sql => db.prepare(sql)))
  else for (const sql of CALL_ROOM_SCHEMA) await db.prepare(sql).run()
  ready.add(db)
}
