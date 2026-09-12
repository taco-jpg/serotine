import type { D1DatabaseBinding } from "./db"

const statement = `CREATE TABLE IF NOT EXISTS RetiredIdentity (
  publicKey TEXT PRIMARY KEY,
  retiredAt INTEGER NOT NULL
)`
const initialized = new WeakSet<D1DatabaseBinding>()

/** Permanent identity revocations are separate from expiring messages/nonces. */
export async function ensureIdentityRetirementSchema(db: D1DatabaseBinding): Promise<void> {
  if (initialized.has(db)) return
  await db.prepare(statement).run()
  await db.prepare("SELECT publicKey, retiredAt FROM RetiredIdentity LIMIT 0").all()
  initialized.add(db)
}
