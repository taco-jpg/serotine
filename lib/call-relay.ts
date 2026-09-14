import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getDB, type D1DatabaseBinding } from "./db"
import { ensureCallRelaySchema } from "./call-relay-schema"
import { ensureIdentityRetirementSchema } from "./identity-retirement-schema"
import { requestProofFailureMessage, verifyRequestProofResult } from "./request-auth"
import { AUTH_WINDOW_MS, type RequestProof } from "./protocol"
import { arrayBufferToBase64 } from "./crypto"
import { CALL_INVITE_TTL_MS, CALL_LEASE_TTL_MS, CALL_PAGE_SIZE, CALL_PRESENCE_TTL_MS, CALL_SIGNAL_TTL_MS,
  isCallId, isCallObject, isCallPeer, isCallReason, isEncryptedCallSignal,
  type CallConfiguration, type CallSession, type EncryptedCallSignal } from "./call-protocol"

const COLUMNS = "callId, caller, recipient, callerSession, recipientSession, status, createdAt, inviteExpiresAt, expiresAt, reason, noHistory"
const TERMINAL_TTL_MS = 120_000
export class CallRelayError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}
const invalid = () => new CallRelayError("Invalid calling request. Reload Serotine and retry.")
function shape(data: Record<string, unknown>, required: string[]) {
  if (Object.keys(data).length !== required.length || !required.every(key => Object.hasOwn(data, key))) throw invalid()
}
function sessionId(data: Record<string, unknown>) { if (!isCallId(data.sessionId)) throw invalid(); return data.sessionId }

async function authorize(action: string, data: unknown, proof: RequestProof) {
  const verification = await verifyRequestProofResult(action, data, proof)
  if (!verification.valid) throw new CallRelayError(requestProofFailureMessage(verification), 401)
  const db = await getDB()
  await ensureIdentityRetirementSchema(db)
  if (await db.prepare("SELECT 1 FROM RetiredIdentity WHERE publicKey = ?").bind(proof.publicKey).first()) {
    throw new CallRelayError("This identity has been retired. Use your current address.", 403)
  }
  const now = Date.now()
  await db.prepare("DELETE FROM RequestNonce WHERE rowid IN (SELECT rowid FROM RequestNonce WHERE expiresAt <= ? LIMIT 256)").bind(now).run()
  const used = await db.prepare("INSERT OR IGNORE INTO RequestNonce(publicKey, nonce, action, expiresAt) VALUES (?, ?, ?, ?)")
    .bind(proof.publicKey, proof.nonce, action, Math.max(now, proof.timestamp) + AUTH_WINDOW_MS).run()
  if (used.meta.changes !== 1) throw new CallRelayError("This calling request was already used. Retry the action.", 409)
  const count = await db.prepare("SELECT COUNT(*) AS count FROM RequestNonce WHERE publicKey = ? AND action = ? AND expiresAt > ?")
    .bind(proof.publicKey, action, now).first<{ count: number }>()
  const limit = action === "call:invite" ? 6 : action === "call:configuration" ? 30 : 600
  if ((count?.count ?? 0) > limit) throw new CallRelayError("Too many calling requests. Wait a minute and retry.", 429)
  await ensureCallRelaySchema(db)
  await cleanup(db, now)
  return db
}

async function cleanup(db: D1DatabaseBinding, now: number) {
  // Terminal tombstones survive two minutes so cancellation and another device's
  // answer cannot vanish between polls. Cleanup never waits for a client ACK.
  await db.prepare(`UPDATE CallSession SET status = 'ended', reason = CASE WHEN status = 'ringing' THEN 'unanswered' ELSE 'failed' END, expiresAt = ?
    WHERE callId IN (SELECT callId FROM CallSession WHERE status != 'ended' AND (expiresAt <= ?
      OR caller IN (SELECT publicKey FROM RetiredIdentity) OR recipient IN (SELECT publicKey FROM RetiredIdentity)) LIMIT 128)`).bind(now, now).run()
  await db.prepare("DELETE FROM CallSignal WHERE sequence IN (SELECT sequence FROM CallSignal WHERE expiresAt <= ? OR callId IN (SELECT callId FROM CallSession WHERE status = 'ended') LIMIT 256)").bind(now).run()
  await db.prepare("DELETE FROM CallSession WHERE callId IN (SELECT callId FROM CallSession WHERE status = 'ended' AND expiresAt <= ? LIMIT 128)").bind(now - TERMINAL_TTL_MS).run()
  await db.prepare("DELETE FROM CallPresence WHERE rowid IN (SELECT rowid FROM CallPresence WHERE expiresAt <= ? LIMIT 128)").bind(now).run()
}
async function getSession(db: D1DatabaseBinding, callId: string, publicKey: string) {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM CallSession WHERE callId = ? AND (caller = ? OR recipient = ?)`)
    .bind(callId, publicKey, publicKey).first<CallSession>()
  return row ? { ...row, noHistory: !!row.noHistory } : null
}

async function touch(db: D1DatabaseBinding, publicKey: string, device: string, now: number) {
  await db.prepare(`UPDATE CallSession SET callerAliveUntil = ?, expiresAt = MIN(?, recipientAliveUntil)
    WHERE caller = ? AND callerSession = ? AND status = 'active' AND expiresAt > ?`)
    .bind(now + CALL_LEASE_TTL_MS, now + CALL_LEASE_TTL_MS, publicKey, device, now).run()
  await db.prepare(`UPDATE CallSession SET recipientAliveUntil = ?, expiresAt = MIN(?, callerAliveUntil)
    WHERE recipient = ? AND recipientSession = ? AND status = 'active' AND expiresAt > ?`)
    .bind(now + CALL_LEASE_TTL_MS, now + CALL_LEASE_TTL_MS, publicKey, device, now).run()
}

async function configuration(policy: "all" | "relay", device: string): Promise<CallConfiguration> {
  const { env } = await getCloudflareContext({ async: true })
  const config = env as unknown as { CALL_TURN_URLS?: string; CALL_TURN_SECRET?: string; CALL_STUN_URLS?: string }
  const urls = (config.CALL_TURN_URLS ?? "").split(",").map(url => url.trim()).filter(url => /^turns?:[^\s@]+$/.test(url)).slice(0, 8)
  const relayAvailable = urls.length > 0 && typeof config.CALL_TURN_SECRET === "string" && config.CALL_TURN_SECRET.length >= 24
  if (policy === "relay" && !relayAvailable) throw new CallRelayError("Relay-only calling is not configured on this server. Choose Direct connection explicitly or ask the site owner to enable TURN.", 409)
  const iceServers: RTCIceServer[] = []
  const expiresAt = Date.now() + 10 * 60_000
  if (relayAvailable) {
    // coturn REST authentication: ten-minute HMAC credentials; no reusable secret
    // or participant public key is sent to the browser or placed in the username.
    const username = `${Math.floor(expiresAt / 1000)}:${device}`
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(config.CALL_TURN_SECRET!), { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
    const credential = arrayBufferToBase64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username)))
    iceServers.push({ urls, username, credential })
  }
  if (policy === "all") {
    const stun = (config.CALL_STUN_URLS ?? "stun:stun.l.google.com:19302").split(",").map(url => url.trim()).filter(url => /^stuns?:[^\s@]+$/.test(url)).slice(0, 4)
    if (stun.length) iceServers.push({ urls: stun })
  }
  return { iceServers, relayAvailable, expiresAt }
}

/** All writes are fresh identity proofs. Negotiation remains encrypted at rest. */
export async function handleCallRequest(action: string, data: unknown, proof: RequestProof): Promise<Record<string, unknown>> {
  if (!isCallObject(data) || !["call:heartbeat", "call:capability", "call:invite", "call:claim", "call:send", "call:poll", "call:finish", "call:configuration"].includes(action)) throw invalid()
  const device = sessionId(data)
  const db = await authorize(action, data, proof)
  const self = proof.publicKey
  const now = Date.now()
  if (action === "call:heartbeat") {
    shape(data, ["sessionId", "peers", "incomingPeers"])
    if (!Array.isArray(data.peers) || data.peers.length > 500 || !data.peers.every(isCallPeer) || data.peers.includes(self)
      || !Array.isArray(data.incomingPeers) || data.incomingPeers.length > 500 || !data.incomingPeers.every(peer => (data.peers as string[]).includes(String(peer)))) throw invalid()
    // Cap linked sessions rather than allowing unlimited unexpired presence rows.
    await db.prepare(`INSERT INTO CallPresence(publicKey, sessionId, peers, incomingPeers, expiresAt)
      SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM CallPresence WHERE publicKey = ?) < 16
        OR EXISTS(SELECT 1 FROM CallPresence WHERE publicKey = ? AND sessionId = ?)
      ON CONFLICT(publicKey,sessionId) DO UPDATE SET peers = excluded.peers, incomingPeers = excluded.incomingPeers, expiresAt = excluded.expiresAt`)
      .bind(self, device, JSON.stringify([...new Set(data.peers)]), JSON.stringify([...new Set(data.incomingPeers)]), now + CALL_PRESENCE_TTL_MS, self, self, device).run()
    await touch(db, self, device, now)
    return { success: true }
  }
  if (action === "call:configuration") {
    shape(data, ["sessionId", "policy"])
    if (data.policy !== "all" && data.policy !== "relay") throw invalid()
    return { success: true, ...(await configuration(data.policy, device)) }
  }
  if (action === "call:capability") {
    shape(data, ["sessionId", "peer"])
    if (!isCallPeer(data.peer) || data.peer === self) throw invalid()
    const available = !!await db.prepare(`SELECT 1 FROM CallPresence p WHERE publicKey = ? AND expiresAt > ?
      AND EXISTS(SELECT 1 FROM json_each(p.incomingPeers) WHERE value = ?)
      AND NOT EXISTS(SELECT 1 FROM RetiredIdentity WHERE publicKey = ?) LIMIT 1`).bind(data.peer, now, self, data.peer).first()
    const busy = available && !!await db.prepare("SELECT 1 FROM CallSession WHERE (caller = ? OR recipient = ?) AND status != 'ended' AND expiresAt > ? LIMIT 1").bind(data.peer, data.peer, now).first()
    return { success: true, available, busy }
  }
  if (action === "call:invite") {
    shape(data, ["sessionId", "signal", "noHistory"])
    if (!isEncryptedCallSignal(data.signal) || typeof data.noHistory !== "boolean") throw invalid()
    const signal = data.signal
    if (signal.sender !== self || signal.senderSession !== device || signal.targetSession !== null
      || signal.expiresAt <= now || signal.expiresAt > now + CALL_INVITE_TTL_MS) throw invalid()
    // A SINGLE SQLite statement arbitrates BOTH roles, including crossed calls
    // and concurrent callers on linked devices. Never use read-then-insert locks.
    const inserted = await db.prepare(`INSERT INTO CallSession(callId, caller, recipient, callerSession, recipientSession, status,
      createdAt, inviteExpiresAt, expiresAt, callerAliveUntil, recipientAliveUntil, reason, noHistory)
      SELECT ?, ?, ?, ?, NULL, 'ringing', ?, ?, ?, ?, ?, NULL, ?
      WHERE NOT EXISTS(SELECT 1 FROM CallSession WHERE status != 'ended' AND expiresAt > ? AND (caller IN (?, ?) OR recipient IN (?, ?)))
        AND NOT EXISTS(SELECT 1 FROM RetiredIdentity WHERE publicKey IN (?, ?))
        AND EXISTS(SELECT 1 FROM CallPresence p WHERE publicKey = ? AND expiresAt > ? AND EXISTS(SELECT 1 FROM json_each(p.incomingPeers) WHERE value = ?))
        AND EXISTS(SELECT 1 FROM CallPresence p WHERE publicKey = ? AND sessionId = ? AND expiresAt > ? AND EXISTS(SELECT 1 FROM json_each(p.peers) WHERE value = ?))
      ON CONFLICT(callId) DO NOTHING`).bind(signal.callId, self, signal.recipient, device, now, signal.expiresAt, signal.expiresAt,
      signal.expiresAt, signal.expiresAt, Number(data.noHistory), now, self, signal.recipient, self, signal.recipient, self, signal.recipient,
      signal.recipient, now, self, self, device, now, signal.recipient).run()
    if (inserted.meta.changes !== 1) throw new CallRelayError("Calling is unavailable, or one participant is already in a call. Both people need Serotine open with calling allowed.", 409)
    try { await insertSignal(db, signal, now, true) }
    catch (error) {
      // Releasing a reservation after a failed signal avoids a phantom busy call.
      await db.prepare("UPDATE CallSession SET status = 'ended', reason = 'failed', expiresAt = ? WHERE callId = ? AND caller = ? AND callerSession = ? AND status = 'ringing'").bind(now, signal.callId, self, device).run()
      throw error
    }
    return { success: true, session: await getSession(db, signal.callId, self) }
  }
  if (action === "call:claim") {
    shape(data, ["sessionId", "callId", "noHistory"])
    if (!isCallId(data.callId) || typeof data.noHistory !== "boolean") throw invalid()
    const claim = await db.prepare(`UPDATE CallSession SET status = 'active', recipientSession = ?,
      callerAliveUntil = ?, recipientAliveUntil = ?, expiresAt = ?, noHistory = MAX(noHistory, ?)
      WHERE callId = ? AND recipient = ? AND status = 'ringing' AND expiresAt > ? AND inviteExpiresAt > ?
      AND EXISTS(SELECT 1 FROM CallPresence p WHERE p.publicKey = ? AND p.sessionId = ? AND p.expiresAt > ?
        AND EXISTS(SELECT 1 FROM json_each(p.incomingPeers) WHERE value = CallSession.caller))`)
      .bind(device, now + CALL_LEASE_TTL_MS, now + CALL_LEASE_TTL_MS, now + CALL_LEASE_TTL_MS, Number(data.noHistory), data.callId, self, now, now, self, device, now).run()
    if (claim.meta.changes !== 1) throw new CallRelayError("This call expired or was already answered on another device.", 409)
    return { success: true, session: await getSession(db, data.callId, self) }
  }
  if (action === "call:send") {
    shape(data, ["sessionId", "signal", "noHistory"])
    if (typeof data.noHistory !== "boolean" || !isEncryptedCallSignal(data.signal) || data.signal.sender !== self || data.signal.senderSession !== device
      || data.signal.targetSession === null || data.signal.expiresAt <= now || data.signal.expiresAt > now + CALL_SIGNAL_TTL_MS) throw invalid()
    if (data.noHistory) await db.prepare(`UPDATE CallSession SET noHistory = 1 WHERE callId = ?
      AND ((caller = ? AND callerSession = ?) OR (recipient = ? AND recipientSession = ?))`)
      .bind(data.signal.callId, self, device, self, device).run()
    await insertSignal(db, data.signal, now, false)
    return { success: true }
  }
  if (action === "call:finish") {
    shape(data, ["sessionId", "callId", "reason", "noHistory"])
    if (!isCallId(data.callId) || !isCallReason(data.reason) || typeof data.noHistory !== "boolean") throw invalid()
    const ended = await db.prepare(`UPDATE CallSession SET status = 'ended', reason = CASE WHEN status = 'ended' THEN reason ELSE ? END,
      expiresAt = CASE WHEN status = 'ended' THEN expiresAt ELSE ? END, noHistory = MAX(noHistory, ?) WHERE callId = ?
      AND ((caller = ? AND callerSession = ?) OR (recipient = ? AND (recipientSession = ? OR recipientSession IS NULL)))`)
      .bind(data.reason, now, Number(data.noHistory), data.callId, self, device, self, device).run()
    if (ended.meta.changes !== 1) {
      const current = await getSession(db, data.callId, self)
      if (!current || current.status !== "ended") throw new CallRelayError("This call belongs to another device or is no longer available.", 409)
    }
    await db.prepare("DELETE FROM CallSignal WHERE callId = ?").bind(data.callId).run()
    return { success: true, session: await getSession(db, data.callId, self) }
  }
  shape(data, ["sessionId", "after"])
  if (!Number.isSafeInteger(data.after) || Number(data.after) < 0) throw invalid()
  await touch(db, self, device, now)
  const { results: signals } = await db.prepare(`SELECT e.* FROM CallSignal e JOIN CallSession c ON c.callId = e.callId
    WHERE e.recipient = ? AND e.sequence > ? AND e.expiresAt > ? AND c.status != 'ended' AND c.expiresAt > ?
      AND ((e.targetSession = ? AND c.status = 'active') OR (e.targetSession IS NULL AND c.status = 'ringing'
        AND EXISTS(SELECT 1 FROM CallPresence p WHERE p.publicKey = ? AND p.sessionId = ? AND p.expiresAt > ?
          AND EXISTS(SELECT 1 FROM json_each(p.incomingPeers) WHERE value = e.sender))))
    ORDER BY e.sequence ASC LIMIT ?`).bind(self, data.after, now, now, device, self, device, now, CALL_PAGE_SIZE).all<EncryptedCallSignal & { sequence: number }>()
  // Read session state AFTER the signal page. An answer arriving between these
  // reads must not accompany an older 'ringing' snapshot and be discarded by
  // the client while its cursor advances. States only progress forward.
  const { results: sessions } = await db.prepare(`SELECT ${COLUMNS} FROM CallSession WHERE caller = ? OR recipient = ? ORDER BY createdAt DESC LIMIT 32`).bind(self, self).all<CallSession>()
  return { success: true, sessions: sessions.map(row => ({ ...row, noHistory: !!row.noHistory })), signals, nextCursor: signals.at(-1)?.sequence ?? data.after }
}

async function insertSignal(db: D1DatabaseBinding, signal: EncryptedCallSignal, now: number, invite: boolean) {
  const inserted = await db.prepare(`INSERT INTO CallSignal(id, callId, sender, recipient, senderSession, targetSession, expiresAt, encryptedData)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM CallSession c WHERE c.callId = ? AND c.expiresAt > ?
      AND ((? = 1 AND c.status = 'ringing' AND c.caller = ? AND c.recipient = ? AND c.callerSession = ?)
        OR (? = 0 AND c.status = 'active' AND ((c.caller = ? AND c.callerSession = ? AND c.recipient = ? AND c.recipientSession = ?)
          OR (c.recipient = ? AND c.recipientSession = ? AND c.caller = ? AND c.callerSession = ?))))
      AND (SELECT COUNT(*) FROM CallSignal WHERE callId = ?) < 512
      AND NOT EXISTS(SELECT 1 FROM RetiredIdentity WHERE publicKey IN (?, ?))
    ON CONFLICT(id) DO NOTHING`).bind(signal.id, signal.callId, signal.sender, signal.recipient, signal.senderSession,
      signal.targetSession, signal.expiresAt, signal.encryptedData, signal.callId, now,
      Number(invite), signal.sender, signal.recipient, signal.senderSession,
      Number(invite), signal.sender, signal.senderSession, signal.recipient, signal.targetSession,
      signal.sender, signal.senderSession, signal.recipient, signal.targetSession, signal.callId, signal.sender, signal.recipient).run()
  if (inserted.meta.changes !== 1) throw new CallRelayError("This call signal is stale, already used, or belongs to another device.", 409)
}
