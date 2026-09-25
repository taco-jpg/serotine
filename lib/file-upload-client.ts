import { apiFetch } from "../native/shared/transport"
import { getNativeBridge } from "../native/shared/bridge"
import { nativeStorageLimits } from "./native-persistence"
import type { Identity } from "./identity"
import type { AttachmentMeta } from "./messaging-types"
import { createRequestProof } from "./request-auth"
import type { RetentionDescriptor } from "./retention-protocol"
import { cacheVerifiedAttachment, getVerifiedAttachment, isAttachmentUnavailable, markAttachmentUnavailable } from "./verified-attachment-cache"
import { MAX_FILE_BYTES, REMOTE_ATTACHMENT_CHUNK_BYTES, attachmentPreviewKind, isAttachmentMeta, normalizeMime,
  safeFilename, validateAttachmentFile, type AttachmentKind, type AttachmentProgress, type PreparedAttachment } from "./attachments"

export const MAX_MEMORY_DOWNLOAD_BYTES = 64 * 1024 * 1024
export const MAX_AUTO_PREVIEW_BYTES = 20 * 1024 * 1024
class AttachmentUnavailableError extends Error {}
const unavailableMessage = "This attachment is no longer available from the server, and this browser has no cached copy. Ask the sender to send it again."
const endpoint = "/api/files"
const encoder = new TextEncoder()
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")
const unhex = (value: string) => Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16))
export async function fileDigest(bytes: BufferSource): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))) }
const manifestDigest = (hashes: string[]) => fileDigest(encoder.encode(JSON.stringify(hashes)))

async function boundedBody(response: Response, maximum: number): Promise<ArrayBuffer> {
  if (!response.body) throw new Error("The file service returned an empty response.")
  const declared = response.headers.get("content-length")
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error("The file service returned too much data.")
  const reader = response.body.getReader(), pieces: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > maximum) { await reader.cancel(); throw new Error("The file service returned too much data.") }
      pieces.push(next.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.length }
  return bytes.buffer
}

async function transferRequest(identity: Identity, action: string, data: Record<string, unknown>, options: {
  body?: ArrayBuffer; signal?: AbortSignal; expectedBytes?: number; allowed?: () => void
} = {}): Promise<Record<string, unknown> | ArrayBuffer> {
  options.signal?.throwIfAborted()
  const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => controller.abort(new Error("The file transfer took too long. Retry when your connection improves.")), 120_000)
  try {
    const proof = await createRequestProof(action, data, identity.privateKey, identity.publicKey)
    const envelope = JSON.stringify({ version: 1, action, data, proof })
    options.allowed?.()
    const response = await apiFetch(endpoint, { method: options.body ? "PUT" : "POST", mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store",
      referrerPolicy: "no-referrer", headers: options.body
        ? { "Content-Type": "application/octet-stream", "X-Serotine-File-Request": envelope }
        : { "Content-Type": "application/json", Accept: options.expectedBytes === undefined ? "application/json" : "application/octet-stream" },
      body: options.body ?? envelope, signal: controller.signal }, options.allowed)
    if (response.ok && options.expectedBytes !== undefined) {
      if (!/^application\/octet-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("The file service returned an unexpected response.")
      const bytes = await boundedBody(response, options.expectedBytes)
      if (bytes.byteLength !== options.expectedBytes) throw new Error("The downloaded file is incomplete. Retry the download.")
      return bytes
    }
    const bytes = await boundedBody(response, 8192)
    let result: Record<string, unknown>
    try { result = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new Error("The file service is unavailable. Reload Serotine and retry.") }
    if (!response.ok || result?.success !== true) {
      if (action === "file:read" && response.status === 410) throw new AttachmentUnavailableError(unavailableMessage)
      const error = result?.error
      throw new Error(typeof error === "string" && error.length <= 300 && !/[<>]/.test(error) && ![...error].some(character => character.charCodeAt(0) < 32) ? error : "The file transfer could not finish. Retry the transfer.")
    }
    return result
  } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort) }
}

/** Older deployments retain their explicit small-file fallback. No failed upload falls back silently. */
export async function fileStorageAvailable(signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
  signal?.addEventListener("abort", abort, { once: true })
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const response = await apiFetch(endpoint, { method: "GET", mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal })
    if (response.status === 404) return false
    if (!response.ok) throw new Error("The file service is temporarily unavailable. Try attaching your file again.")
    const bytes = await boundedBody(response, 8192)
    let result: Record<string, unknown>
    try { result = JSON.parse(new TextDecoder().decode(bytes)) } catch { return false }
    if (result.success !== true || typeof result.available !== "boolean") throw new Error("The file service returned an unexpected response.")
    if (!result.available) return false
    if (result.chunkBytes !== REMOTE_ATTACHMENT_CHUNK_BYTES || result.maxFileBytes !== MAX_FILE_BYTES) throw new Error("Reload Serotine to use this server's file storage.")
    return true
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort) }
}

function chunkIv(prefix: string, index: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12)
  iv.set(unhex(prefix), 0)
  new DataView(iv.buffer).setUint32(8, index)
  return iv
}
function chunkAad(metadata: Pick<AttachmentMeta, "id" | "size" | "chunks">, index: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(["serotine-file-v1", metadata.id, metadata.size, metadata.chunks, index]))
}

function uploadReceipt(result: Record<string, unknown> | ArrayBuffer, uploadId: string, status: "staged" | "ready" | "published"): number {
  if (result instanceof ArrayBuffer || result.uploadId !== uploadId || result.status !== status
    || !Number.isSafeInteger(result.expiresAt) || Number(result.expiresAt) <= 0 || Number(result.expiresAt) > 8_640_000_000_000_000) {
    throw new Error("The file service returned invalid upload details. Retry the attachment.")
  }
  return Number(result.expiresAt)
}

/** Bind the published upload once to the exact outgoing message and intended
 * recipients before that encrypted message can enter the outbox. */
export async function registerAttachmentDelivery(identity: Identity, metadata: AttachmentMeta, messageId: string, recipients: string[], scope: RetentionDescriptor, allowed?: () => void): Promise<AttachmentMeta> {
  if (!isAttachmentMeta(metadata)) throw new Error("This attachment has invalid delivery details.")
  if (!metadata.remote) return metadata
  allowed?.()
  // Preserve the stable message binding even when registration succeeded but
  // the response/signing/queue step failed. A composer retry uses this same ID.
  metadata.remote.messageId = messageId
  const result = await transferRequest(identity, "file:delivery", { uploadId: metadata.id, messageId, manifestHash: metadata.sha256, recipients, scope }, { allowed })
  const expiresAt = uploadReceipt(result, metadata.id, "published")
  metadata.remote.expiresAt = expiresAt
  return { ...metadata, remote: { ...metadata.remote, messageId, expiresAt } }
}
async function acknowledgeVerifiedAttachment(metadata: AttachmentMeta, identity: Identity) {
  if (!metadata.remote?.messageId) return // Older uploads use their finite TTL.
  await transferRequest(identity, "file:received", { uploadId: metadata.id, messageId: metadata.remote.messageId,
    manifestHash: metadata.sha256, capability: metadata.remote.capability })
}

/** One 4 MiB slice at a time: never read/base64-encode the whole File. */
export async function stageUpload(file: File, identity: Identity, kind: AttachmentKind = "file", onProgress?: AttachmentProgress, signal?: AbortSignal, allowed?: () => void): Promise<PreparedAttachment> {
  validateAttachmentFile(file)
  if (!file.size) throw new Error("Empty files use the local attachment format.")
  signal?.throwIfAborted()
  const capability = hex(crypto.getRandomValues(new Uint8Array(32))), keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const metadata: AttachmentMeta = { id: crypto.randomUUID(), name: safeFilename(file.name), mime: normalizeMime(file.type), size: file.size,
    kind, chunks: Math.ceil(file.size / REMOTE_ATTACHMENT_CHUNK_BYTES), sha256: "", remote: { version: 1, chunkBytes: REMOTE_ATTACHMENT_CHUNK_BYTES,
      capability, key: hex(keyBytes), ivPrefix: hex(crypto.getRandomValues(new Uint8Array(8))), hashes: [] } }
  const remote = metadata.remote!, key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"])
  keyBytes.fill(0)
  let published = false, publishRequested = false, discarded = false
  const discard = async () => {
    if (discarded || publishRequested) return
    await transferRequest(identity, "file:delete", { uploadId: metadata.id })
    discarded = true
  }
  try {
    onProgress?.(0)
    uploadReceipt(await transferRequest(identity, "file:init", { uploadId: metadata.id, size: file.size, chunkCount: metadata.chunks,
      accessHash: await fileDigest(encoder.encode(capability)) }, { signal, allowed }), metadata.id, "staged")
    for (let index = 0; index < metadata.chunks; index++) {
      signal?.throwIfAborted()
      const start = index * remote.chunkBytes, expected = Math.min(remote.chunkBytes, file.size - start)
      const plain = await file.slice(start, start + expected).arrayBuffer()
      if (plain.byteLength !== expected) throw new Error("The file changed while reading it. Attach it again.")
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: chunkIv(remote.ivPrefix, index), additionalData: chunkAad(metadata, index) }, key, plain)
      new Uint8Array(plain).fill(0)
      const digest = await fileDigest(ciphertext)
      await transferRequest(identity, "file:chunk", { uploadId: metadata.id, index, size: ciphertext.byteLength, digest }, { body: ciphertext, signal, allowed })
      remote.hashes.push(digest)
      onProgress?.(Math.min(99, Math.floor((index + 1) * 99 / metadata.chunks)))
    }
    metadata.sha256 = await manifestDigest(remote.hashes)
    uploadReceipt(await transferRequest(identity, "file:complete", { uploadId: metadata.id }, { signal, allowed }), metadata.id, "ready")
    signal?.throwIfAborted()
    await cacheVerifiedAttachment(identity.publicKey, metadata, file).catch(() => undefined)
    onProgress?.(100)
    return { metadata, storage: "remote", discard,
      async publish() {
        if (discarded) throw new Error("This file draft was removed. Attach it again.")
        if (published) return
        publishRequested = true
        remote.expiresAt = uploadReceipt(await transferRequest(identity, "file:publish", { uploadId: metadata.id }, { allowed }), metadata.id, "published")
        published = true
      },
    }
  } catch (error) {
    // Cleanup uses its own request so cancelling the upload cannot cancel deletion.
    await discard().catch(() => undefined)
    throw error
  }
}

export type DownloadSink = { write(bytes: Uint8Array<ArrayBuffer>): Promise<unknown>; close(): Promise<unknown>; abort(reason?: unknown): Promise<unknown> }

/** Verify each encrypted part and its AEAD binding before writing bounded plaintext to disk. */
export async function streamAttachmentDownload(metadata: AttachmentMeta, identity: Identity, sink: DownloadSink,
  onProgress?: AttachmentProgress, signal?: AbortSignal): Promise<void> {
  try {
    if (!isAttachmentMeta(metadata) || !metadata.remote) throw new Error("This attachment has invalid download details.")
    const remote = metadata.remote
    if (await manifestDigest(remote.hashes) !== metadata.sha256) throw new Error("This attachment failed its integrity check. Ask the sender to send it again.")
    const key = await crypto.subtle.importKey("raw", unhex(remote.key), "AES-GCM", false, ["decrypt"])
    onProgress?.(0)
    for (let index = 0; index < metadata.chunks; index++) {
      signal?.throwIfAborted()
      const expected = Math.min(remote.chunkBytes, metadata.size - index * remote.chunkBytes)
      const ciphertext = await transferRequest(identity, "file:read", { uploadId: metadata.id, index, capability: remote.capability }, { expectedBytes: expected + 16, signal }) as ArrayBuffer
      if (await fileDigest(ciphertext) !== remote.hashes[index]) throw new Error("This file failed its integrity check. Retry or ask the sender to send it again.")
      let plain: ArrayBuffer
      try { plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: chunkIv(remote.ivPrefix, index), additionalData: chunkAad(metadata, index) }, key, ciphertext) }
      catch { throw new Error("This file failed its encryption check. Ask the sender to send it again.") }
      signal?.throwIfAborted()
      if (plain.byteLength !== expected) throw new Error("This attachment has an invalid piece size.")
      const bytes = new Uint8Array(plain)
      try { await sink.write(bytes) } finally { bytes.fill(0) }
      onProgress?.(Math.floor((index + 1) * 100 / metadata.chunks))
    }
    signal?.throwIfAborted()
    await sink.close()
  } catch (error) {
    if (error instanceof AttachmentUnavailableError) await markAttachmentUnavailable(identity.publicKey, metadata).catch(() => undefined)
    await sink.abort(error).catch(() => undefined); throw error
  }
}

async function assertRemoteAvailable(metadata: AttachmentMeta, identity: Identity) {
  if ((metadata.remote?.expiresAt !== undefined && metadata.remote.expiresAt <= Date.now())
    || await isAttachmentUnavailable(identity.publicKey, metadata).catch(() => false)) throw new AttachmentUnavailableError(unavailableMessage)
}

export type AttachmentDownload = { blob?: Blob; dispose(): Promise<void> }
type SaveWindow = Window & { showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }> }

/** Call directly from a click to retain the browser's user gesture for its save picker. */
export async function downloadRemoteAttachment(metadata: AttachmentMeta, identity: Identity, options: {
  preview?: boolean; onProgress?: AttachmentProgress; signal?: AbortSignal
} = {}): Promise<AttachmentDownload> {
  if (!isAttachmentMeta(metadata) || !metadata.remote) throw new Error("This attachment has invalid download details.")
  const nativeLimit = nativeStorageLimits()?.fileBytes
  if (nativeLimit && metadata.size > nativeLimit) throw new Error("This file exceeds the installed beta's 16 MiB limit. Open it in the browser client instead.")
  const mime = attachmentPreviewKind(metadata.mime) ? metadata.mime : "application/octet-stream"
  const saveWindow = typeof window !== "undefined" ? window as SaveWindow : undefined
  if (!options.preview && !getNativeBridge() && saveWindow?.showSaveFilePicker) {
    const handle = await saveWindow.showSaveFilePicker({ suggestedName: safeFilename(metadata.name) })
    options.signal?.throwIfAborted()
    const writer = await handle.createWritable()
    const saved = await getVerifiedAttachment(identity.publicKey, metadata).catch(() => undefined)
    if (saved) {
      const reader = saved.stream().getReader()
      try { while (true) { options.signal?.throwIfAborted(); const piece = await reader.read(); if (piece.done) break; await writer.write(piece.value) }; await writer.close() }
      catch (error) { await writer.abort(error).catch(() => undefined); throw error }
      finally { reader.releaseLock() }
    } else {
      try { await assertRemoteAvailable(metadata, identity) } catch (error) { await writer.abort(error).catch(() => undefined); throw error }
      await streamAttachmentDownload(metadata, identity, writer, options.onProgress, options.signal)
    }
    await acknowledgeVerifiedAttachment(metadata, identity).catch(() => undefined)
    return { dispose: async () => undefined }
  }
  const cached = await getVerifiedAttachment(identity.publicKey, metadata).catch(() => undefined)
  if (cached) {
    // Retry a lost acknowledgement only on the next explicit/open-preview use,
    // never by introducing polling. Cached bytes remain usable after expiry.
    await acknowledgeVerifiedAttachment(metadata, identity).catch(() => undefined)
    return { blob: cached, dispose: async () => undefined }
  }
  await assertRemoteAvailable(metadata, identity)
  if (metadata.size <= MAX_MEMORY_DOWNLOAD_BYTES) {
    const pieces: ArrayBuffer[] = []
    await streamAttachmentDownload(metadata, identity, {
      async write(bytes) { pieces.push(bytes.slice().buffer) }, async close() {}, async abort() { pieces.length = 0 },
    }, options.onProgress, options.signal)
    const blob = new Blob(pieces, { type: mime })
    pieces.length = 0
    // Without a durable local copy (quota/privacy mode), keep the server copy
    // until its finite expiry. A preview alone is never delivery completion.
    try { await cacheVerifiedAttachment(identity.publicKey, metadata, blob); await acknowledgeVerifiedAttachment(metadata, identity) }
    catch { /* Showing a verified in-memory download still works. */ }
    return { blob, dispose: async () => undefined }
  }
  // OPFS File objects remain disk-backed. Never concatenate a 1 GiB download in RAM.
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) throw new Error("This browser cannot save large files safely. Use a browser with file saving support, such as Chrome or Edge.")
  const estimate = await navigator.storage.estimate()
  if (estimate.quota !== undefined && estimate.usage !== undefined && estimate.quota - estimate.usage < metadata.size + REMOTE_ATTACHMENT_CHUNK_BYTES) throw new Error("Your browser needs more free storage to download this file. Free some space or use a browser with a save-file picker.")
  const directory = await navigator.storage.getDirectory(), tempName = `serotine-download-${crypto.randomUUID()}`
  const file = await directory.getFileHandle(tempName, { create: true })
  const dispose = async () => { await directory.removeEntry(tempName).catch(() => undefined) }
  try {
    const writer = await file.createWritable()
    await streamAttachmentDownload(metadata, identity, writer, options.onProgress, options.signal)
    const blob = (await file.getFile()).slice(0, metadata.size, mime)
    try { await cacheVerifiedAttachment(identity.publicKey, metadata, blob); await acknowledgeVerifiedAttachment(metadata, identity) }
    catch { /* Retain until TTL if the durable cache cannot be committed. */ }
    return { blob, dispose }
  } catch (error) { await dispose(); throw error }
}
