import { authorize, CallRelayError } from "./call-relay"
import { validDirectSignal, type DirectSignal } from "./direct-protocol"
import { PUBLIC_KEY_PATTERN, type RequestProof } from "./protocol"

/** Separate, bounded, expiring setup records; no messaging/attachment storage. */
export async function handleDirectSignaling(action: string, data: unknown, proof: RequestProof) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !["direct:signal", "direct:poll"].includes(action)) throw new CallRelayError("Invalid direct setup request.")
  const input = data as { signal?: DirectSignal; peers?: string[] }
  if (Object.keys(input).length !== 1) throw new CallRelayError("Invalid direct setup request.")
  if (action === "direct:signal" && (!await validDirectSignal(input.signal) || input.signal!.sender !== proof.publicKey)) throw new CallRelayError("Invalid signed direct setup.")
  if (action === "direct:poll" && (!Array.isArray(input.peers) || input.peers.length > 100 || !input.peers.every(peer => typeof peer === "string" && PUBLIC_KEY_PATTERN.test(peer)))) throw new CallRelayError("Invalid direct contacts.")
  const db = await authorize(action, data, proof), now = Date.now()
  await db.prepare("CREATE TABLE IF NOT EXISTS DirectSignal (sender TEXT NOT NULL, recipient TEXT NOT NULL, session TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL, PRIMARY KEY(sender,session,kind))").run()
  await db.prepare("CREATE INDEX IF NOT EXISTS DirectSignal_recipient ON DirectSignal(recipient,expiresAt)").run()
  await db.prepare("DELETE FROM DirectSignal WHERE expiresAt <= ?").bind(now).run()
  if (action === "direct:poll") {
    const rows = await db.prepare("SELECT value FROM DirectSignal WHERE recipient = ? AND expiresAt > ? AND sender IN (SELECT value FROM json_each(?)) ORDER BY expiresAt LIMIT 64")
      .bind(proof.publicKey, now, JSON.stringify(input.peers)).all<{ value: string }>()
    return { success: true, signals: rows.results.map(row => JSON.parse(row.value) as DirectSignal) }
  }
  const signal = input.signal!
  if (await db.prepare("SELECT 1 FROM RetiredIdentity WHERE publicKey = ?").bind(signal.recipient).first()) throw new CallRelayError("This contact's identity has been retired.", 403)
  const result = await db.prepare("INSERT OR IGNORE INTO DirectSignal(sender,recipient,session,kind,value,expiresAt) SELECT ?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM DirectSignal WHERE sender = ?) < 16 AND (SELECT COUNT(*) FROM DirectSignal WHERE recipient = ?) < 64")
    .bind(signal.sender, signal.recipient, signal.session, signal.kind, JSON.stringify(signal), signal.expiresAt, signal.sender, signal.recipient).run()
  if (!result.meta.changes) throw new CallRelayError("Direct setup is busy. Wait a minute before reconnecting.", 429)
  return { success: true }
}
