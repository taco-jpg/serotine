import type { Identity } from "./identity"
import type { AttachmentMeta, GroupState, MessagingContextValue } from "./messaging-types"
import { MAX_EVENT_PACKET_LENGTH, MAX_MESSAGE_LENGTH, MAX_RETAINED_EVENT_BYTES, MAX_RETAINED_EVENT_COUNT, PUBLIC_KEY_PATTERN } from "./protocol"

export const MAX_FILE_BYTES = 1024 * 1024 * 1024
export const LEGACY_MAX_FILE_BYTES = 50 * 1024 * 1024
export const REMOTE_ATTACHMENT_CHUNK_BYTES = 4 * 1024 * 1024
export const ATTACHMENT_CHUNK_BYTES = 30 * 1024
export const MAX_ATTACHMENT_CHUNKS = Math.ceil(LEGACY_MAX_FILE_BYTES / ATTACHMENT_CHUNK_BYTES)
export type AttachmentChunk = { index: number; data: string }
export type AttachmentKind = "file" | "voice"
export type AttachmentProgress = (percent: number) => void
export type AttachmentCaption = { content: string; mentions?: string[] }

/** Keep one transfer within the existing relay budget, including group fanout. */
export function attachmentFileLimit(_group?: GroupState): number { return MAX_FILE_BYTES }

export function legacyAttachmentFileLimit(group?: GroupState): number {
  if (!group) return LEGACY_MAX_FILE_BYTES
  if (!Array.isArray(group.members) || group.members.length < 1 || group.members.length > 20) return 0
  const recipients = Math.max(1, group.members.length - 1)
  // Measure the signed group, including any extra fields accepted by an older
  // client. 4 KiB covers recipients and the remaining generated event fields.
  const envelopeBytes = 4096 + new TextEncoder().encode(JSON.stringify(group)).byteLength
  const plainBytes = ATTACHMENT_CHUNK_BYTES * 4 / 3 + envelopeBytes
  const packetBytes = 4 * Math.ceil((plainBytes + 16) / 3) + 44
  // Existing signed-event and relay bounds still apply to each individual chunk.
  if (plainBytes > 60000 || packetBytes > MAX_EVENT_PACKET_LENGTH) return 0
  // Reserve another full packet for metadata and round down for a clear UI cap.
  const chunks = Math.min(Math.floor(MAX_RETAINED_EVENT_COUNT / recipients), Math.floor(MAX_RETAINED_EVENT_BYTES / (recipients * packetBytes))) - 1
  const mib = 1024 * 1024
  return Math.min(LEGACY_MAX_FILE_BYTES, Math.floor(chunks * ATTACHMENT_CHUNK_BYTES / mib) * mib)
}

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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function normalizeMime(mime: string): string {
  const bare = mime.split(";")[0].trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(bare) && bare.length <= 100 ? bare : "application/octet-stream"
}

export function validateAttachmentFile(file: Pick<File, "size" | "name">, maxBytes = MAX_FILE_BYTES): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("This group's details are too large to attach files. Ask the group owner to update the group.")
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("This file has an invalid size.")
  if (file.size > Math.min(MAX_FILE_BYTES, maxBytes)) throw new Error(maxBytes < MAX_FILE_BYTES
    ? `This group supports files up to ${formatFileSize(maxBytes)} each. Choose a smaller file or send it in a direct chat.`
    : "Choose a file up to 1 GB.")
  if (typeof file.name !== "string") throw new Error("Choose a valid file.")
}

export function isAttachmentMeta(value: unknown): value is AttachmentMeta {
  if (!value || typeof value !== "object") return false
  const meta = value as AttachmentMeta
  return typeof meta.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(meta.id)
    && typeof meta.name === "string" && meta.name.length > 0 && meta.name.length <= 160
    && typeof meta.mime === "string" && meta.mime === normalizeMime(meta.mime)
    && Number.isSafeInteger(meta.size) && meta.size >= 0 && meta.size <= MAX_FILE_BYTES
    && (meta.remote === undefined
      ? meta.size <= LEGACY_MAX_FILE_BYTES && Number.isSafeInteger(meta.chunks) && meta.chunks === Math.max(1, Math.ceil(meta.size / ATTACHMENT_CHUNK_BYTES))
      : isRemoteAttachmentMeta(meta))
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
  validateAttachmentFile(file, LEGACY_MAX_FILE_BYTES)
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
  group?: GroupState, caption?: AttachmentCaption,
): Promise<string> {
  if (conversationId.startsWith("group:") && group?.id !== conversationId) throw new Error("Group details are unavailable. Reopen this conversation before attaching a file.")
  validateAttachmentFile(file, legacyAttachmentFileLimit(group))
  if (caption !== undefined && (!caption || typeof caption.content !== "string" || caption.content.length > MAX_MESSAGE_LENGTH)) throw new Error(`Use a caption up to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`)
  if (caption?.mentions !== undefined && (!Array.isArray(caption.mentions) || caption.mentions.length > 20 || !caption.mentions.every(pub => typeof pub === "string" && PUBLIC_KEY_PATTERN.test(pub)))) throw new Error("This caption has invalid mentions. Remove them and try again.")
  // Capture the text before reading the file so later draft edits cannot change it.
  const content = caption?.content.trim()
  const mentions = caption?.mentions?.length ? [...caption.mentions] : undefined
  const { metadata, chunks } = await prepareAttachment(file, kind, percent => onProgress?.(Math.round(percent * 0.1)))
  // Queue content first: a storage error cannot publish a permanently truncated attachment.
  for (let index = 0; index < chunks.length; index++) {
    await sendEvent(conversationId, "attachment-chunk", { attachmentId: metadata.id, ...chunks[index] })
    onProgress?.(10 + Math.round((index + 1) * 85 / chunks.length))
  }
  const messageId = await sendEvent(conversationId, "attachment", { attachment: metadata, replyTo, ...(content ? { content } : {}), ...(mentions ? { mentions } : {}) })
  onProgress?.(100)
  return messageId
}

export function attachmentProgress(metadata: AttachmentMeta, chunks: AttachmentChunk[]): number {
  if (!isAttachmentMeta(metadata)) return 0
  if (metadata.remote) return 100
  const indices = new Set(chunks.filter(chunk => Number.isInteger(chunk.index) && chunk.index >= 0 && chunk.index < metadata.chunks).map(chunk => chunk.index))
  return Math.min(100, Math.floor(indices.size * 100 / metadata.chunks))
}

/** Only these native media formats are previewed. HTML, SVG and PDFs are download-only. */
export function attachmentPreviewKind(mime: string): "image" | "audio" | "video" | null {
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime)) return "image"
  if (["audio/webm", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/wav", "audio/x-wav", "audio/aac", "audio/flac"].includes(mime)) return "audio"
  if (["video/mp4", "video/webm", "video/ogg", "video/quicktime"].includes(mime)) return "video"
  return null
}

export async function assembleAttachment(metadata: AttachmentMeta, chunks: AttachmentChunk[]): Promise<Blob> {
  if (!isAttachmentMeta(metadata)) throw new Error("This attachment has invalid details.")
  if (metadata.remote) throw new Error("This attachment must be downloaded from file storage.")
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


function isRemoteAttachmentMeta(meta: AttachmentMeta): boolean {
  const remote = meta.remote
  return !!remote && typeof remote === "object" && remote.version === 1
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(meta.id) && remote.chunkBytes === REMOTE_ATTACHMENT_CHUNK_BYTES
    && Number.isSafeInteger(meta.chunks) && meta.size > 0 && meta.chunks === Math.ceil(meta.size / remote.chunkBytes)
    && typeof remote.capability === "string" && /^[a-f0-9]{64}$/.test(remote.capability)
    && typeof remote.key === "string" && /^[a-f0-9]{64}$/.test(remote.key)
    && typeof remote.ivPrefix === "string" && /^[a-f0-9]{16}$/.test(remote.ivPrefix)
    && (remote.expiresAt === undefined || (Number.isSafeInteger(remote.expiresAt) && remote.expiresAt > 0 && remote.expiresAt <= 8_640_000_000_000_000))
    && Array.isArray(remote.hashes) && remote.hashes.length === meta.chunks
    && remote.hashes.every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
}

export type PreparedAttachment = {
  metadata: AttachmentMeta
  /** Uploads ciphertext are ready, or the legacy file has only been prepared locally. */
  storage: "remote" | "local"
  publish(): Promise<void>
  discard(): Promise<void>
}

/** Stage while composing; recipients cannot retrieve/decrypt a draft before Send. */
export async function stageAttachment(
  sendEvent: MessagingContextValue["sendEvent"], conversationId: string, file: File, identity: Identity,
  kind: AttachmentKind = "file", onProgress?: AttachmentProgress, signal?: AbortSignal, group?: GroupState,
): Promise<PreparedAttachment> {
  validateAttachmentFile(file)
  if (conversationId.startsWith("group:") && group?.id !== conversationId) throw new Error("Group details are unavailable. Reopen this conversation before attaching a file.")
  signal?.throwIfAborted()
  const { fileStorageAvailable, stageUpload } = await import("./file-upload-client")
  if (file.size > 0 && await fileStorageAvailable(signal)) return stageUpload(file, identity, kind, onProgress, signal)
  const legacyLimit = legacyAttachmentFileLimit(group)
  if (file.size > legacyLimit) throw new Error(`This server needs file storage configured for files up to 1 GB. Its current limit for this conversation is ${formatFileSize(legacyLimit)}.`)
  // Keeping eight prepared base64 arrays could retain hundreds of MiB. The
  // legacy fallback holds only its disk-backed File until the explicit Send.
  const metadata: AttachmentMeta = { id: crypto.randomUUID(), name: safeFilename(file.name), mime: normalizeMime(file.type), size: file.size,
    chunks: Math.max(1, Math.ceil(file.size / ATTACHMENT_CHUNK_BYTES)), sha256: "0".repeat(64), kind }
  let original: File | undefined = file
  let discarded = false, publishRequested = false, hashed = false, sent = 0
  signal?.throwIfAborted()
  onProgress?.(100)
  return { metadata, storage: "local",
    async publish() {
      if (discarded || !original) throw new Error("This file draft was removed. Attach it again.")
      publishRequested = true
      if (!hashed) {
        // WebCrypto's digest API is not incremental; this one transient legacy
        // buffer stays capped at 50 MiB and is never retained by a queued draft.
        const bytes = new Uint8Array(await original.arrayBuffer())
        if (bytes.byteLength !== metadata.size) throw new Error("The file changed while reading it. Attach it again.")
        try { metadata.sha256 = await sha256(bytes) } finally { bytes.fill(0) }
        hashed = true
      }
      for (; sent < metadata.chunks; sent++) {
        const start = sent * ATTACHMENT_CHUNK_BYTES
        const bytes = new Uint8Array(await original.slice(start, start + ATTACHMENT_CHUNK_BYTES).arrayBuffer())
        if (bytes.length !== Math.min(ATTACHMENT_CHUNK_BYTES, metadata.size - start)) throw new Error("The file changed while reading it. Attach it again.")
        await sendEvent(conversationId, "attachment-chunk", { attachmentId: metadata.id, index: sent, data: encodeChunk(bytes) })
      }
    },
    async discard() { if (!publishRequested) { discarded = true; original = undefined } },
  }
}

export async function publishAttachment(
  sendEvent: MessagingContextValue["sendEvent"], conversationId: string, prepared: PreparedAttachment,
  replyTo?: string, caption?: AttachmentCaption,
): Promise<string> {
  if (!isAttachmentMeta(prepared.metadata)) throw new Error("This attachment has invalid details.")
  if (caption !== undefined && (!caption || typeof caption.content !== "string" || caption.content.length > MAX_MESSAGE_LENGTH)) throw new Error(`Use a caption up to ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`)
  if (caption?.mentions !== undefined && (!Array.isArray(caption.mentions) || caption.mentions.length > 20 || !caption.mentions.every(pub => typeof pub === "string" && PUBLIC_KEY_PATTERN.test(pub)))) throw new Error("This caption has invalid mentions. Remove them and try again.")
  const content = caption?.content.trim(), mentions = caption?.mentions?.length ? [...caption.mentions] : undefined
  await prepared.publish()
  if (!isAttachmentMeta(prepared.metadata)) throw new Error("This attachment has invalid details after upload.")
  return sendEvent(conversationId, "attachment", { attachment: prepared.metadata, replyTo, ...(content ? { content } : {}), ...(mentions ? { mentions } : {}) })
}
