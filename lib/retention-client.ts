import type { Identity } from "./identity"
import type { RetentionDescriptor } from "./retention-protocol"
import { createRequestProof } from "./request-auth"
export async function requestRetention(identity: Identity, action: "retention:close" | "retention:accept", scope: RetentionDescriptor): Promise<{ pending: boolean }> {
  const data = { scope }, proof = await createRequestProof(action, data, identity.privateKey, identity.publicKey)
  const response = await fetch("/api/retention", { method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, action, data, proof }), signal: AbortSignal.timeout(30_000) })
  const result = await response.json() as { success?: boolean; error?: string; pending?: boolean }
  if (!response.ok || !result.success) throw new Error(typeof result.error === "string" ? result.error : "Server cleanup is unavailable. Retry before removing this relationship.")
  return { pending: result.pending === true }
}
