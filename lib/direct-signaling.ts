import { createRequestProof } from "./request-auth"
import type { Identity } from "./identity"
import type { DirectSignal } from "./direct-protocol"

export async function directSignaling(identity: Identity, action: "direct:signal" | "direct:poll", data: { signal: DirectSignal } | { peers: string[] }): Promise<DirectSignal[]> {
  const proof = await createRequestProof(action, data, identity.privateKey, identity.publicKey)
  const response = await fetch("/api/direct", { method: "POST", credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "strict-origin",
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ version: 1, action, data, proof }), signal: AbortSignal.timeout(10_000) })
  const result = await response.json() as { success?: boolean; error?: string; signals?: DirectSignal[] }
  if (!response.ok || !result.success) throw new Error(result.error || "Direct setup is unavailable. Conversation content has not been relayed.")
  if (action === "direct:poll" && (!Array.isArray(result.signals) || result.signals.length > 64)) throw new Error("Invalid direct setup response.")
  return result.signals ?? []
}
