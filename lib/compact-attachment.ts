import { MAX_FILE_BYTES, safeFilename, validateAttachmentFile } from "./attachments"

/** Keep compression work bounded even when a very compressible input is larger than the send limit. */
export const MAX_COMPACT_INPUT_BYTES = 50 * 1024 * 1024

export type CompactedAttachment = { file: File; compacted: boolean; originalBytes: number }

// Keep useful media previews and avoid recompressing common compressed containers.
const COMPRESSED_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|mp3|m4a|aac|ogg|opus|flac|wav|mp4|m4v|webm|mov|mkv|avi|zip|gz|gzip|tgz|bz2|xz|7z|rar|zst|br|pdf|docx|xlsx|pptx|odt|ods|odp|epub|woff2?)$/i
const COMPRESSED_MIME = /^(?:image\/|audio\/|video\/|application\/(?:zip|gzip|x-gzip|x-7z-compressed|x-rar-compressed|x-bzip2|x-xz|zstd|pdf)(?:;|$))/i

/**
 * Lossless compaction produces an ordinary downloadable .gz file. The attachment
 * protocol stays unchanged, and callers still require an explicit send action.
 */
export async function compactAttachment(file: File, enabled: boolean): Promise<CompactedAttachment> {
  const original = (): CompactedAttachment => {
    validateAttachmentFile(file)
    return { file, compacted: false, originalBytes: file.size }
  }
  if (!enabled) return original()
  if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.name !== "string") return original()
  if (file.size > MAX_COMPACT_INPUT_BYTES) throw new Error("Auto compact accepts source files up to 50 MB. Choose a smaller file.")
  if (COMPRESSED_EXTENSION.test(file.name) || COMPRESSED_MIME.test(file.type) || typeof CompressionStream === "undefined") return original()

  // Changing the download format is only worthwhile for savings of at least
  // 1 KiB and 5%. Never keep a compressed output above the normal send limit.
  const targetBytes = Math.min(MAX_FILE_BYTES, file.size - 1024, Math.floor(file.size * 0.95))
  if (targetBytes < 0) return original()
  let compacted: File | undefined
  try {
    const reader = file.stream().pipeThrough(new CompressionStream("gzip")).getReader()
    const parts: ArrayBuffer[] = []
    let total = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > targetBytes) {
          await reader.cancel()
          return original()
        }
        parts.push(new Uint8Array(value).buffer)
      }
      compacted = new File(parts, `${safeFilename(file.name).slice(0, 157)}.gz`, {
        type: "application/gzip", lastModified: file.lastModified,
      })
    } finally {
      reader.releaseLock()
    }
  } catch {
    // Browsers without working gzip support can still attach an ordinary file.
    return original()
  }
  validateAttachmentFile(compacted)
  return { file: compacted, compacted: true, originalBytes: file.size }
}
