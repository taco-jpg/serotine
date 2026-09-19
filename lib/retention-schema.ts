import type { D1DatabaseBinding } from "./db"
const ready = new WeakSet<D1DatabaseBinding>()
export async function ensureRetentionSchema(db: D1DatabaseBinding): Promise<void> {
  if (ready.has(db)) return
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS RetentionScope(scopeId TEXT PRIMARY KEY, kind TEXT NOT NULL, owner TEXT NOT NULL, namespaceKey TEXT,
      peer TEXT, authorityVersion INTEGER NOT NULL DEFAULT 0, authorityProof TEXT NOT NULL DEFAULT '',
      closedAt INTEGER NOT NULL DEFAULT 0, boundaryAt INTEGER NOT NULL DEFAULT 0,
      firstAccepted INTEGER NOT NULL DEFAULT 0, secondAccepted INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS RetentionObject(objectKey TEXT PRIMARY KEY, scopeId TEXT NOT NULL, eventTimestamp INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
      cleanupAt INTEGER NOT NULL DEFAULT 0)`,
    "CREATE INDEX IF NOT EXISTS idx_retention_objects_scope ON RetentionObject(scopeId)",
    "CREATE INDEX IF NOT EXISTS idx_retention_objects_cleanup ON RetentionObject(cleanupAt, expiresAt)",
    `CREATE TABLE IF NOT EXISTS GroupAuthority(groupId TEXT NOT NULL, admin TEXT NOT NULL, terminalAt INTEGER NOT NULL DEFAULT 0,
      createdAt INTEGER NOT NULL, PRIMARY KEY(groupId, admin))`,
  ]) await db.prepare(sql).run()
  const { results } = await db.prepare("PRAGMA table_info(RelayEvent)").all<{ name: string }>()
  for (const column of ["retentionScope", "retentionTimestamp"]) if (results.length && !results.some(item => item.name === column)) {
    try { await db.prepare(`ALTER TABLE RelayEvent ADD COLUMN ${column} ${column === "retentionScope" ? "TEXT" : "INTEGER"}`).run() }
    catch (error) {
      const current = await db.prepare("PRAGMA table_info(RelayEvent)").all<{ name: string }>()
      if (!current.results.some(item => item.name === column)) throw error
    }
  }
  if (results.length) {
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_relay_event_retention ON RelayEvent(retentionScope)").run()
    await db.prepare(`CREATE TRIGGER IF NOT EXISTS retention_event_closed BEFORE INSERT ON RelayEvent
      WHEN NEW.retentionScope IS NOT NULL AND EXISTS(SELECT 1 FROM RetentionScope s WHERE s.scopeId = NEW.retentionScope AND
        (s.closedAt > 0 OR NEW.retentionTimestamp <= s.boundaryAt OR (s.kind = 'group' AND EXISTS(SELECT 1 FROM GroupAuthority g WHERE g.groupId = 'group:' || s.namespaceKey AND g.admin = s.owner AND g.terminalAt > 0))))
      BEGIN SELECT RAISE(ABORT, 'Conversation retention has ended'); END`).run()
  }
  // Both tables live with RelayEvent in D1. RequestNonce remains routed through
  // the realtime DO; no SQL statement crosses those storage boundaries.
  ready.add(db)
}
