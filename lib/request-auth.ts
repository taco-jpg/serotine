import { AUTH_WINDOW_MS, ID_PATTERN, PUBLIC_KEY_PATTERN, requestText, type RequestProof } from "./protocol"
import { hexToArrayBuffer, arrayBufferToHex } from "./crypto"

// Existing addresses are P-256 public points. Proofs require possession of their
// matching private key, without a server account or a public-key registry.
export async function createRequestProof(action: string, payload: unknown, privateJwk: JsonWebKey, publicKey: string): Promise<RequestProof> {
  const proof = { publicKey, timestamp: Date.now(), nonce: crypto.randomUUID() }
  const key = await crypto.subtle.importKey("jwk", { ...privateJwk, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(requestText(action, payload, proof)))
  return { ...proof, signature: arrayBufferToHex(signature) }
}

export type RequestProofVerification =
  | { valid: true }
  | { valid: false; reason: "malformed" }
  | { valid: false; reason: "invalid-signature" }
  | { valid: false; reason: "expired" | "future"; differenceMs: number }

export async function verifyRequestProofResult(action: string, payload: unknown, proof: RequestProof): Promise<RequestProofVerification> {
  try {
    if (!proof || typeof proof !== "object" || Array.isArray(proof)
      || typeof proof.publicKey !== "string" || !PUBLIC_KEY_PATTERN.test(proof.publicKey)
      || typeof proof.nonce !== "string" || !ID_PATTERN.test(proof.nonce)
      || !Number.isSafeInteger(proof.timestamp)
      || typeof proof.signature !== "string" || !/^[0-9a-f]{128}$/.test(proof.signature)) {
      return { valid: false, reason: "malformed" }
    }
    const key = await crypto.subtle.importKey("raw", hexToArrayBuffer(proof.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
    if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, hexToArrayBuffer(proof.signature), new TextEncoder().encode(requestText(action, payload, proof)))) {
      return { valid: false, reason: "invalid-signature" }
    }
    // Diagnose time only after authenticating the signed timestamp. Invalid
    // signatures must never be presented as a device-clock problem.
    const difference = Date.now() - proof.timestamp
    if (difference > AUTH_WINDOW_MS) return { valid: false, reason: "expired", differenceMs: difference }
    if (difference < -AUTH_WINDOW_MS) return { valid: false, reason: "future", differenceMs: -difference }
    return { valid: true }
  } catch { return { valid: false, reason: "invalid-signature" } }
}

export function requestProofFailureMessage(result: Exclude<RequestProofVerification, { valid: true }>): string {
  if (result.reason === "malformed") return "Identity verification failed because the request was incomplete or invalid. Reload Serotine and retry."
  if (result.reason === "invalid-signature") return "Identity verification failed because the request signature could not be verified. Reload Serotine and retry. If this continues, keep your browser data and report this error."
  const minutes = Math.max(1, Math.round(result.differenceMs / 60_000))
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  const duration = hours
    ? `${hours} ${hours === 1 ? "hour" : "hours"}${remainingMinutes ? ` ${remainingMinutes} ${remainingMinutes === 1 ? "minute" : "minutes"}` : ""}`
    : `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
  return result.reason === "expired"
    ? `Your signed request timestamp is about ${duration} behind the server, so this request expired. Reconnect and retry. If this continues, turn on automatic date and time, then reload Serotine.`
    : `Your signed request timestamp is about ${duration} ahead of the server. Turn on automatic date and time, then reload Serotine and retry.`
}

export async function verifyRequestProof(action: string, payload: unknown, proof: RequestProof): Promise<boolean> {
  return (await verifyRequestProofResult(action, payload, proof)).valid
}
