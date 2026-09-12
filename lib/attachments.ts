import type { AttachmentMeta, MessagingContextValue } from "./messaging-types"

export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const ATTACHMENT_CHUNK_BYTES = 30 * 1024
export const MAX_ATTACHMENT_CHUNKS = Math.ceil(MAX_FILE_BYTES / ATTACHMENT_CHUNK_BYTES)
export type AttachmentChunk = { index: number; data: string }
export type AttachmentKind = "file" | "voice"
export type AttachmentProgress = (percent: number) => void

export function safeFilename(name: string): string {
  const leaf = name.replace(/\\/g, "/").split("/").pop() || "attachment"
  const printable = Array.from(leaf, character => character.charCodeAt(0) < 32 || (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159) ? "_" : character).join("")
  const clean = printable.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 160)
  return clean && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? clean : `attachment-${clean || "file"}`
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function normalizeMime(mime: string): string {
  const bare = mime.split(";")[0].trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(bare) && bare.length <= 100 ? bare : "application/octet-stream"
}

export function validateAttachmentFile(file: Pick<File, "size" | "name">): void {
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("This file has an invalid size.")
  if (file.size > MAX_FILE_BYTES) throw new Error("Choose a file up to 2 MB.")
  if (typeof file.name !== "string") throw new Error("Choose a valid file.")
}

export function isAttachmentMeta(value: unknown): value is AttachmentMeta {
  if (!value || typeof value !== "object") return false
  const meta = value as AttachmentMeta
  return typeof meta.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(meta.id)
    && typeof meta.name === "string" && meta.name.length > 0 && meta.name.length <= 160
    && typeof meta.mime === "string" && meta.mime === normalizeMime(meta.mime)
    && Number.isSafeInteger(meta.size) && meta.size >= 0 && meta.size <= MAX_FILE_BYTES
    && Number.isSafeInteger(meta.chunks) && meta.chunks === Math.max(1, Math.ceil(meta.size / ATTACHMENT_CHUNK_BYTES))
    && typeof meta.sha256 === "string" && /^[a-f0-9]{64}$/.test(meta.sha256)
    && (meta.kind === "file" || meta.kind === "voice")
    && (meta.duration === undefined || (Number.isFinite(meta.duration) && meta.duration >= 0 && meta.duration <= 3600))
}

function encodeChunk(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 4096) binary += String.fromCharCode(...bytes.subarray(offset, offset + 4096))
  return btoa(binary)
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
}

export async function prepareAttachment(file: File, kind: AttachmentKind = "file", onProgress?: AttachmentProgress): Promise<{ metadata: AttachmentMeta; chunks: AttachmentChunk[] }> {
  validateAttachmentFile(file)
  onProgress?.(0)
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length !== file.size) throw new Error("The file changed while it was being read. Please select it again.")
  const metadata: AttachmentMeta = {
    id: crypto.randomUUID(), name: safeFilename(file.name), mime: normalizeMime(file.type), size: file.size,
    chunks: Math.max(1, Math.ceil(file.size / ATTACHMENT_CHUNK_BYTES)), sha256: await sha256(bytes), kind,
  }
  const chunks: AttachmentChunk[] = []
  for (let index = 0; index < metadata.chunks; index++) {
    chunks.push({ index, data: encodeChunk(bytes.subarray(index * ATTACHMENT_CHUNK_BYTES, (index + 1) * ATTACHMENT_CHUNK_BYTES)) })
    onProgress?.(Math.round((index + 1) * 100 / metadata.chunks))
  }
  return { metadata, chunks }
}

/** Each event is saved by the messaging engine before its background delivery. */
export async function sendAttachment(
  sendEvent: MessagingContextValue["sendEvent"], conversationId: string, file: File,
  kind: AttachmentKind = "file", onProgress?: AttachmentProgress, replyTo?: string,
): Promise<string> {
  const { metadata, chunks } = await prepareAttachment(file, kind, percent => onProgress?.(Math.round(percent * 0.1)))
  // Queue content first: a storage error cannot publish a permanently truncated attachment.
  for (let index = 0; index < chunks.length; index++) {
    await sendEvent(conversationId, "attachment-chunk", { attachmentId: metadata.id, ...chunks[index] })
    onProgress?.(10 + Math.round((index + 1) * 85 / chunks.length))
  }
  const messageId = await sendEvent(conversationId, "attachment", { attachment: metadata, replyTo })
  onProgress?.(100)
  return messageId
}

export function attachmentProgress(metadata: AttachmentMeta, chunks: AttachmentChunk[]): number {
  if (!isAttachmentMeta(metadata)) return 0
  const indices = new Set(chunks.filter(chunk => Number.isInteger(chunk.index) && chunk.index >= 0 && chunk.index < metadata.chunks).map(chunk => chunk.index))
  return Math.min(100, Math.floor(indices.size * 100 / metadata.chunks))
}

/** Only these native media formats are previewed. HTML, SVG and PDFs are download-only. */
export function attachmentPreviewKind(mime: string): "image" | "audio" | null {
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime)) return "image"
  if (["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/aac", "audio/flac"].includes(mime)) return "audio"
  return null
}

export async function assembleAttachment(metadata: AttachmentMeta, chunks: AttachmentChunk[]): Promise<Blob> {
  if (!isAttachmentMeta(metadata)) throw new Error("This attachment has invalid details.")
  if (chunks.length > metadata.chunks * 2) throw new Error("This attachment contains too many pieces.")
  const ordered = new Map<number, string>()
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index >= metadata.chunks || typeof chunk.data !== "string"
      || chunk.data.length > ATTACHMENT_CHUNK_BYTES * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)) {
      throw new Error("This attachment contains an invalid piece.")
    }
    if (ordered.has(chunk.index) && ordered.get(chunk.index) !== chunk.data) throw new Error("This attachment has conflicting pieces.")
    ordered.set(chunk.index, chunk.data)
  }
  if (ordered.size !== metadata.chunks) throw new Error("This attachment is still arriving.")
  const bytes = new Uint8Array(metadata.size)
  for (let index = 0; index < metadata.chunks; index++) {
    const encoded = ordered.get(index)!
    const binary = atob(encoded)
    const expected = Math.min(ATTACHMENT_CHUNK_BYTES, metadata.size - index * ATTACHMENT_CHUNK_BYTES)
    if (binary.length !== expected || btoa(binary) !== encoded) throw new Error("This attachment has an invalid piece size.")
    for (let offset = 0; offset < binary.length; offset++) bytes[index * ATTACHMENT_CHUNK_BYTES + offset] = binary.charCodeAt(offset)
  }
  if (await sha256(bytes) !== metadata.sha256) throw new Error("This attachment failed its integrity check. Ask the sender to send it again.")
  return new Blob([bytes], { type: attachmentPreviewKind(metadata.mime) ? metadata.mime : "application/octet-stream" })
}
