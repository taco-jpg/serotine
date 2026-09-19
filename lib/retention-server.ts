import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getDB, type D1DatabaseBinding } from "./db"
import { ensureEventRelaySchema } from "./event-relay-schema"
import { ensureRetentionSchema } from "./retention-schema"
import { retentionScopeId, validRetentionDescriptor, type RetentionDescriptor } from "./retention-protocol"
import { verifyRequestProofResult, requestProofFailureMessage } from "./request-auth"
import { AUTH_WINDOW_MS, type RequestProof } from "./protocol"

export class RetentionError extends Error { constructor(message: string, public status = 400) { super(message) } }
interface Scope { scopeId: string; kind: string; owner: string; peer: string | null; authorityVersion: number; authorityProof: string; closedAt: number; boundaryAt: number; firstAccepted: number; secondAccepted: number }
export async function registerRetention(db: D1DatabaseBinding, descriptor: RetentionDescriptor, sender: string, recipient?: string): Promise<string> {
  if (!await validRetentionDescriptor(descriptor)) throw new RetentionError("Invalid conversation retention details.")
  if (descriptor.kind === "direct" && (![descriptor.first, descriptor.second].includes(sender)
    || (recipient !== undefined && ![descriptor.first, descriptor.second].includes(recipient)))) throw new RetentionError("Invalid direct conversation scope.", 403)
  await ensureRetentionSchema(db)
  const scopeId = await retentionScopeId(descriptor)
  const transfers = descriptor.kind === "community" ? descriptor.transfers ?? [] : []
  const owner = descriptor.kind === "direct" ? descriptor.first : transfers.at(-1)?.to ?? descriptor.founder
  const version = transfers.length, checkpoint = transfers.at(-1)?.signature ?? ""
  await db.prepare(`INSERT OR IGNORE INTO RetentionScope(scopeId, kind, owner, peer, namespaceKey, authorityVersion, authorityProof)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(scopeId, descriptor.kind, owner, descriptor.kind === "direct" ? descriptor.second : null,
      descriptor.kind === "direct" ? null : descriptor.key, version, checkpoint).run()
  const prior = await db.prepare("SELECT * FROM RetentionScope WHERE scopeId = ?").bind(scopeId).first<Scope>()
  if (!prior) throw new RetentionError("Conversation retention is unavailable.", 503)
  if (prior.authorityVersion > version || (prior.authorityVersion === version && prior.authorityProof !== checkpoint)
    || (prior.authorityVersion > 0 && transfers[prior.authorityVersion - 1]?.signature !== prior.authorityProof)) throw new RetentionError("This community ownership proof is stale.", 409)
  if (version > prior.authorityVersion) await db.prepare(`UPDATE RetentionScope SET owner = ?, authorityVersion = ?, authorityProof = ?
    WHERE scopeId = ? AND authorityVersion = ? AND closedAt = 0`).bind(owner, version, checkpoint, scopeId, prior.authorityVersion).run()
  return scopeId
}
export async function assertRetentionOpen(db: D1DatabaseBinding, scopeId: string, timestamp: number) {
  await db.prepare(`UPDATE RetentionScope SET closedAt = (SELECT g.terminalAt FROM GroupAuthority g WHERE g.groupId = 'group:' || RetentionScope.namespaceKey AND g.admin = RetentionScope.owner)
    WHERE scopeId = ? AND kind = 'group' AND closedAt = 0 AND EXISTS(SELECT 1 FROM GroupAuthority g WHERE g.groupId = 'group:' || RetentionScope.namespaceKey AND g.admin = RetentionScope.owner AND g.terminalAt > 0)`).bind(scopeId).run()
  const row = await db.prepare("SELECT closedAt, boundaryAt FROM RetentionScope WHERE scopeId = ?").bind(scopeId).first<Scope>()
  if (!row || row.closedAt || timestamp <= row.boundaryAt) throw new RetentionError("Server retention for this conversation ended. Both contacts must accept the relationship again before sending new relay messages.", 409)
}

/** Terminal state is recorded first. Bounded physical cleanup can fail and be
 * retried without reopening the scope or exposing queued messages to readers. */
export async function purgeRetentionScope(db: D1DatabaseBinding, scopeId: string): Promise<{ removed: number; pending: boolean }> {
  const row = await db.prepare("SELECT closedAt, boundaryAt FROM RetentionScope WHERE scopeId = ?").bind(scopeId).first<Scope>()
  if (!row || (!row.closedAt && !row.boundaryAt)) throw new RetentionError("The conversation must be closed before purging.")
  const { results: removed } = await db.prepare(`DELETE FROM RelayEvent WHERE sequence IN (SELECT e.sequence FROM RelayEvent e JOIN RetentionScope s ON s.scopeId = e.retentionScope
    WHERE e.retentionScope = ? AND (s.closedAt > 0 OR e.retentionTimestamp <= s.boundaryAt) LIMIT 256) RETURNING sequence`).bind(scopeId).all<{ sequence: number }>()
  const { env } = await getCloudflareContext({ async: true })
  const files = (env as unknown as { serotine_files?: { delete(keys: string[]): Promise<void> } }).serotine_files
  const objects = await db.prepare(`SELECT o.objectKey FROM RetentionObject o JOIN RetentionScope s ON s.scopeId = o.scopeId
    WHERE o.scopeId = ? AND o.cleanupAt <= ? AND (s.closedAt > 0 OR o.eventTimestamp <= s.boundaryAt) LIMIT 256`).bind(scopeId, Date.now()).all<{ objectKey: string }>()
  if (objects.results.length && files) {
    await files.delete(objects.results.map(item => item.objectKey))
    // Keep keys until the maximum write lifetime passes. A crashed writer that
    // finishes a pre-purge put is reclaimed by this low-frequency retry sweep.
    await db.prepare(`UPDATE RetentionObject SET cleanupAt = CASE WHEN cleanupAt = 0 THEN ? ELSE ? END
      WHERE objectKey IN (${objects.results.map(() => "?").join(",")})`).bind(Date.now() + 5 * 60_000, Date.now() + 24 * 60 * 60_000, ...objects.results.map(item => item.objectKey)).run()
  }
  if (files) {
    const { purgeScopeAttachments } = await import("./file-upload-relay")
    await purgeScopeAttachments(db, files as import("./file-upload-relay").FileUploadBucket, scopeId)
  }
  const pending = !!await db.prepare(`SELECT 1 FROM RelayEvent e JOIN RetentionScope s ON s.scopeId = e.retentionScope
    WHERE e.retentionScope = ? AND (s.closedAt > 0 OR e.retentionTimestamp <= s.boundaryAt) LIMIT 1`).bind(scopeId).first()
    || !!await db.prepare(`SELECT 1 FROM RetentionObject o JOIN RetentionScope s ON s.scopeId = o.scopeId
      WHERE o.scopeId = ? AND o.cleanupAt = 0 AND (s.closedAt > 0 OR o.eventTimestamp <= s.boundaryAt) LIMIT 1`).bind(scopeId).first()
    || !!(files && await db.prepare(`SELECT 1 FROM FileDelivery d JOIN RetentionScope s ON s.scopeId = d.scopeId
      WHERE d.scopeId = ? AND (s.closedAt > 0 OR d.sentAt <= s.boundaryAt) LIMIT 1`).bind(scopeId).first())
  return { removed: removed.length, pending }
}

/** Low-frequency bounded expiry/retry work. No history scans on message reads
 * or heartbeat traffic. Scoped object keys never alias another live scope. */
export async function maintainRetentionStorage(db: D1DatabaseBinding, files: { delete(keys: string[]): Promise<void> }, now = Date.now()): Promise<void> {
  await ensureEventRelaySchema(db)
  await ensureRetentionSchema(db)
  await db.prepare(`UPDATE RetentionScope SET closedAt = (SELECT g.terminalAt FROM GroupAuthority g WHERE g.groupId = 'group:' || RetentionScope.namespaceKey AND g.admin = RetentionScope.owner)
    WHERE scopeId IN (SELECT s.scopeId FROM RetentionScope s JOIN GroupAuthority g ON g.groupId = 'group:' || s.namespaceKey AND g.admin = s.owner
      WHERE s.kind = 'group' AND s.closedAt = 0 AND g.terminalAt > 0 LIMIT 128)`).run()
  await db.prepare(`DELETE FROM RelayEvent WHERE sequence IN (SELECT e.sequence FROM RelayEvent e JOIN RetentionScope s ON s.scopeId = e.retentionScope
    WHERE s.closedAt > 0 OR e.retentionTimestamp <= s.boundaryAt LIMIT 256)`).run()
  const { results } = await db.prepare(`SELECT o.objectKey, o.expiresAt FROM RetentionObject o JOIN RetentionScope s ON s.scopeId = o.scopeId
    WHERE o.cleanupAt <= ? AND (o.expiresAt <= ? OR s.closedAt > 0 OR o.eventTimestamp <= s.boundaryAt) LIMIT 256`).bind(now, now).all<{ objectKey: string; expiresAt: number }>()
  if (results.length) {
    await files.delete(results.map(item => item.objectKey))
    const completed = results.filter(item => item.expiresAt <= now), retry = results.filter(item => item.expiresAt > now)
    if (completed.length) await db.prepare(`DELETE FROM RetentionObject WHERE objectKey IN (${completed.map(() => "?").join(",")})`).bind(...completed.map(item => item.objectKey)).run()
    if (retry.length) await db.prepare(`UPDATE RetentionObject SET cleanupAt = CASE WHEN cleanupAt = 0 THEN ? ELSE ? END WHERE objectKey IN (${retry.map(() => "?").join(",")})`)
      .bind(now + 5 * 60_000, now + 86400_000, ...retry.map(item => item.objectKey)).run()
  }
  const { ensureFileUploadSchema } = await import("./file-upload-schema")
  await ensureFileUploadSchema(db)
  const scopes = await db.prepare(`SELECT DISTINCT d.scopeId FROM FileDelivery d JOIN RetentionScope s ON s.scopeId = d.scopeId
    WHERE s.closedAt > 0 OR d.sentAt <= s.boundaryAt LIMIT 4`).all<{ scopeId: string }>()
  const { purgeScopeAttachments } = await import("./file-upload-relay")
  for (const scope of scopes.results) await purgeScopeAttachments(db, files as import("./file-upload-relay").FileUploadBucket, scope.scopeId, now)
}
export async function closeRetentionScope(db: D1DatabaseBinding, scopeId: string, expectedOwner?: string): Promise<void> {
  const result = await db.prepare(`UPDATE RetentionScope SET closedAt = CASE WHEN closedAt = 0 THEN ? ELSE closedAt END,
    firstAccepted = 0, secondAccepted = 0 WHERE scopeId = ? ${expectedOwner ? "AND owner = ?" : ""}`)
    .bind(Date.now(), scopeId, ...(expectedOwner ? [expectedOwner] : [])).run()
  if (!result.meta.changes) throw new RetentionError("Conversation authority changed. Refresh and retry.", 409)
}
export async function handleRetention(action: string, data: unknown, proof: RequestProof) {
  if (!["retention:close", "retention:accept"].includes(action) || !data || typeof data !== "object" || Array.isArray(data)
    || Object.keys(data).length !== 1 || !("scope" in data) || !await validRetentionDescriptor(data.scope)) throw new RetentionError("Invalid retention request.")
  const verified = await verifyRequestProofResult(action, data, proof)
  if (!verified.valid) throw new RetentionError(requestProofFailureMessage(verified), 401)
  const db = await getDB()
  if (await db.prepare("SELECT 1 FROM RetiredIdentity WHERE publicKey = ?").bind(proof.publicKey).first()) throw new RetentionError("This identity has been retired.", 403)
  const now = Date.now()
  const nonce = await db.prepare("INSERT OR IGNORE INTO RequestNonce(publicKey, nonce, action, expiresAt) VALUES (?, ?, ?, ?)")
    .bind(proof.publicKey, proof.nonce, action, Math.max(now, proof.timestamp) + AUTH_WINDOW_MS).run()
  if (nonce.meta.changes !== 1) throw new RetentionError("This request was already used. Retry the action.", 409)
  const count = await db.prepare("SELECT COUNT(*) AS count FROM RequestNonce WHERE publicKey = ? AND action = ? AND expiresAt > ?").bind(proof.publicKey, action, now).first<{ count: number }>()
  if ((count?.count ?? 0) > 20) throw new RetentionError("Too many retention requests. Retry in a minute.", 429)
  await ensureEventRelaySchema(db)
  const descriptor = data.scope as RetentionDescriptor, scopeId = await registerRetention(db, descriptor, proof.publicKey)
  const scope = (await db.prepare("SELECT * FROM RetentionScope WHERE scopeId = ?").bind(scopeId).first<Scope>())!
  if (descriptor.kind !== "direct" && scope.owner !== proof.publicKey) throw new RetentionError("Only the current owner may terminate this space.", 403)
  if (action === "retention:accept") {
    if (descriptor.kind !== "direct") throw new RetentionError("Only direct relationships can be reopened.")
    if (scope.closedAt) {
      const column = scope.owner === proof.publicKey ? "firstAccepted" : "secondAccepted"
      await db.prepare(`UPDATE RetentionScope SET ${column} = ? WHERE scopeId = ? AND closedAt = ?`).bind(now, scopeId, scope.closedAt).run()
      await db.prepare(`UPDATE RetentionScope SET closedAt = 0, boundaryAt = ?, firstAccepted = 0, secondAccepted = 0
        WHERE scopeId = ? AND closedAt > 0 AND firstAccepted >= closedAt AND secondAccepted >= closedAt`).bind(now, scopeId).run()
    }
    return { success: true, pending: !!(await db.prepare("SELECT closedAt, boundaryAt FROM RetentionScope WHERE scopeId = ?").bind(scopeId).first<Scope>())?.closedAt }
  }
  if (scope.boundaryAt && descriptor.timestamp <= scope.boundaryAt) throw new RetentionError("This removal belongs to an earlier relationship. Review the current contact and retry.", 409)
  await closeRetentionScope(db, scopeId, descriptor.kind === "direct" ? undefined : proof.publicKey)
  // A transient physical deletion failure leaves the authoritative terminal
  // marker durable. A fresh proof safely retries exactly this cleanup.
  const result = await purgeRetentionScope(db, scopeId)
  return { success: true, ...result }
}
