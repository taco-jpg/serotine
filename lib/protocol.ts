/** Shared, deterministic wire format. Never include private keys in a request. */
export const MAX_MESSAGE_LENGTH = 8000
export const MAX_PACKET_LENGTH = 64000
export const AUTH_WINDOW_MS = 60_000
export const PUBLIC_KEY_PATTERN = /^04[0-9a-f]{128}$/
export const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface InboxCursor { createdAt: number; id: string }
export interface InboxRequest { senderPubKey: string; after?: InboxCursor }

export interface RequestProof {
  publicKey: string
  timestamp: number
  nonce: string
  signature: string
}

export interface Envelope {
  version: 2
  id: string
  sender: string
  recipient: string
  content: string
  timestamp: number
}

export function requestText(action: string, payload: unknown, proof: Omit<RequestProof, "signature">) {
  return JSON.stringify(["serotine:request:v2", action, proof.publicKey, proof.timestamp, proof.nonce, payload])
}

export function isEnvelope(value: unknown, sender: string, recipient: string): value is Envelope {
  if (!value || typeof value !== "object") return false
  const item = value as Envelope
  return item.version === 2 && ID_PATTERN.test(item.id) && item.sender === sender && item.recipient === recipient
    && typeof item.content === "string" && item.content.trim().length > 0 && item.content.length <= MAX_MESSAGE_LENGTH
    && Number.isSafeInteger(item.timestamp) && item.timestamp > 0 && item.timestamp <= Date.now() + AUTH_WINDOW_MS
}
