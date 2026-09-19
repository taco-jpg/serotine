import "server-only"
import { getCloudflareContext } from "@opennextjs/cloudflare"
import { getDB } from "./db"
import { ensureIdentityRetirementSchema } from "./identity-retirement-schema"
import { AUTH_WINDOW_MS, type RequestProof } from "./protocol"
import { requestProofFailureMessage, verifyRequestProofResult } from "./request-auth"
import { isSummaryMessages, SUMMARY_ACTION, SUMMARY_TIMEOUT_MS } from "./ai-summary"
import { AiSummaryError, cloudflareSummaryProvider, type SummaryEnvironment } from "./ai-summary-provider"

export const SUMMARY_IDENTITY_LIMIT = 4
export const SUMMARY_GLOBAL_LIMIT = 60

export async function handleAiSummary(data: unknown, proof: RequestProof, signal?: AbortSignal): Promise<{ success: true; summary: string }> {
  if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== 1
    || !("messages" in data) || !isSummaryMessages(data.messages)) throw new AiSummaryError("Invalid summary request. Review the preview again.")
  const verification = await verifyRequestProofResult(SUMMARY_ACTION, data, proof)
  if (!verification.valid) throw new AiSummaryError(requestProofFailureMessage(verification), 401, "summary-auth")
  signal?.throwIfAborted()
  const { env } = await getCloudflareContext({ async: true })
  const provider = cloudflareSummaryProvider(env as unknown as SummaryEnvironment)
  const db = await getDB()
  await ensureIdentityRetirementSchema(db)
  if (await db.prepare("SELECT 1 FROM RetiredIdentity WHERE publicKey = ?").bind(proof.publicKey).first()) {
    throw new AiSummaryError("This identity has been retired. Use your current address.", 403, "summary-auth")
  }
  const now = Date.now()
  await db.prepare("DELETE FROM RequestNonce WHERE rowid IN (SELECT rowid FROM RequestNonce WHERE expiresAt < ? LIMIT 256)").bind(now).run()
  // One SQL statement arbitrates concurrent requests across isolates. Reuse the
  // shared replay guard; only identity/nonce/action/expiry is retained, never
  // the plaintext messages, summary, conversation ID or peer metadata.
  const inserted = await db.prepare(`INSERT OR IGNORE INTO RequestNonce(publicKey, nonce, action, expiresAt)
    SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM RequestNonce WHERE publicKey = ? AND action = ? AND expiresAt > ?) < ?
      AND (SELECT COUNT(*) FROM RequestNonce WHERE action = ? AND expiresAt > ?) < ?`)
    .bind(proof.publicKey, proof.nonce, SUMMARY_ACTION, Math.max(now, proof.timestamp) + AUTH_WINDOW_MS,
      proof.publicKey, SUMMARY_ACTION, now, SUMMARY_IDENTITY_LIMIT, SUMMARY_ACTION, now, SUMMARY_GLOBAL_LIMIT).run()
  if (inserted.meta.changes !== 1) {
    if (await db.prepare("SELECT 1 FROM RequestNonce WHERE publicKey = ? AND nonce = ?").bind(proof.publicKey, proof.nonce).first()) {
      throw new AiSummaryError("This summary request was already used. Review the preview and retry.", 409, "summary-replay")
    }
    throw new AiSummaryError("Too many AI summary requests. Wait a minute and try again.", 429, "summary-rate")
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectCancelled: (() => void) | undefined
  try {
    controller.signal.throwIfAborted()
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancelled = () => reject(new AiSummaryError("AI summary was cancelled.", 408, "summary-cancelled"))
      controller.signal.addEventListener("abort", rejectCancelled, { once: true })
    })
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new AiSummaryError("AI summary took too long. You can try again later.", 504, "summary-timeout"))
        controller.abort()
      }, SUMMARY_TIMEOUT_MS)
    })
    const summary = await Promise.race([provider.summarize(data.messages, controller.signal), timeout, cancellation])
    return { success: true, summary }
  } catch (error) {
    if (error instanceof AiSummaryError) throw error
    if (signal?.aborted) throw new AiSummaryError("AI summary was cancelled.", 408, "summary-cancelled")
    throw new AiSummaryError("The AI provider is temporarily unavailable. Try again later.", 502, "summary-provider")
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", cancel)
    if (rejectCancelled) controller.signal.removeEventListener("abort", rejectCancelled)
  }
}
