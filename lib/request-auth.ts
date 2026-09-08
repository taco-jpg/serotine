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

export async function verifyRequestProof(action: string, payload: unknown, proof: RequestProof): Promise<boolean> {
  try {
    if (!proof || !PUBLIC_KEY_PATTERN.test(proof.publicKey) || !ID_PATTERN.test(proof.nonce)
      || !Number.isSafeInteger(proof.timestamp) || Math.abs(Date.now() - proof.timestamp) > AUTH_WINDOW_MS
      || !/^[0-9a-f]{128}$/.test(proof.signature)) return false
    const key = await crypto.subtle.importKey("raw", hexToArrayBuffer(proof.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, hexToArrayBuffer(proof.signature), new TextEncoder().encode(requestText(action, payload, proof)))
  } catch { return false }
}
