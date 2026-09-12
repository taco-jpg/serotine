import { validateAttachments, type MessageAttachment } from "./attachments"

/** Shared, deterministic wire format. Never include private keys in a request. */
export const MAX_MESSAGE_LENGTH = 8000
// 1 MiB of files, base64 in JSON and then base64 AES-GCM, plus caption/metadata.
// Stay below D1's 2 MB row limit, including routing fields.
export const MAX_PACKET_LENGTH = 1_950_000
export const MAX_SIGNAL_PACKET_LENGTH = 64000
export const MESSAGE_PAGE_SIZE = 4
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
  version: 2 | 3
  id: string
  sender: string
  recipient: string
  content: string
  attachments?: MessageAttachment[]
  timestamp: number
}

export function requestText(action: string, payload: unknown, proof: Omit<RequestProof, "signature">) {
  return JSON.stringify(["serotine:request:v2", action, proof.publicKey, proof.timestamp, proof.nonce, payload])
}

export function isEnvelope(value: unknown, sender: string, recipient: string): value is Envelope {
  if (!value || typeof value !== "object") return false
  const item = value as Envelope
  // Older clients reject v3 instead of acknowledging a caption and discarding its files.
  return ((item.version === 2 && item.attachments === undefined)
      || (item.version === 3 && validateAttachments(item.attachments) && item.attachments.length > 0))
    && typeof item.id === "string" && ID_PATTERN.test(item.id) && item.sender === sender && item.recipient === recipient
    && typeof item.content === "string" && item.content.length <= MAX_MESSAGE_LENGTH
    && (item.content.trim().length > 0 || (item.attachments?.length ?? 0) > 0)
    && Number.isSafeInteger(item.timestamp) && item.timestamp > 0 && item.timestamp <= Date.now() + AUTH_WINDOW_MS
}
