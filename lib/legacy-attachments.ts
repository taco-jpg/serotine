/** Files travel inside the authenticated, encrypted message, never as public URLs. */
export const MAX_ATTACHMENT_BYTES = 1024 * 1024
export const MAX_ATTACHMENTS = 4
const MAX_NAME_LENGTH = 180
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

export interface MessageAttachment {
  name: string
  type: string
  size: number
  data: string
}

function safeName(name: string) {
  // Strip control characters from untrusted download names.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "_")
    .trim().slice(0, MAX_NAME_LENGTH) || "attachment"
}

function validBase64(data: string, size: number) {
  if (data.length !== 4 * Math.ceil(size / 3)) return false
  const padding = size % 3 === 0 ? 0 : 3 - size % 3
  const body = padding ? data.slice(0, -padding) : data
  if (/[^A-Za-z0-9+/]/.test(body) || data.slice(body.length) !== "=".repeat(padding)) return false
  // Reject noncanonical padding bits, so one byte sequence has one representation.
  const final = BASE64_ALPHABET.indexOf(body.at(-1) ?? "A")
  return padding === 2 ? (final & 15) === 0 : padding === 1 ? (final & 3) === 0 : true
}

export function validateAttachments(value: unknown): value is MessageAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return false
  let total = 0
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || Object.keys(item).length !== 4 || !["name", "type", "size", "data"].every(key => Object.hasOwn(item, key))
      || typeof item.name !== "string" || !item.name.length || item.name.length > MAX_NAME_LENGTH
      || safeName(item.name) !== item.name || item.name === "." || item.name === ".."
      || typeof item.type !== "string" || item.type.length > 127
      || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(item.type)
      || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_ATTACHMENT_BYTES
      || typeof item.data !== "string" || !validBase64(item.data, item.size)) return false
    total += item.size
    if (total > MAX_ATTACHMENT_BYTES) return false
  }
  return true
}

export async function fileToAttachment(file: File): Promise<MessageAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error("Files must fit within the 1 MiB total per message.")
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength !== file.size || bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("This file could not be read completely. Try selecting it again.")
  let binary = ""
  // Small slices avoid argument-stack overflow on larger files.
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  }
  const mime = file.type.toLowerCase()
  const name = safeName(file.name)
  const result = {
    name: name === "." || name === ".." ? "attachment" : name,
    type: mime.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : "application/octet-stream",
    size: bytes.length,
    data: globalThis.btoa(binary),
  }
  if (!validateAttachments([result])) throw new Error("This file could not be attached. Try selecting it again.")
  return result
}

export function isPreviewableImage(attachment: MessageAttachment): boolean {
  // Check both the declared type and signature. Active formats (SVG/HTML) are downloads only.
  let header: string
  try { header = globalThis.atob(attachment.data.slice(0, 24)) } catch { return false }
  switch (attachment.type) {
    case "image/png": return header.startsWith("\x89PNG\r\n\x1a\n")
    case "image/jpeg": return header.startsWith("\xff\xd8\xff")
    case "image/gif": return header.startsWith("GIF87a") || header.startsWith("GIF89a")
    case "image/webp": return header.startsWith("RIFF") && header.slice(8, 12) === "WEBP"
    default: return false
  }
}

export function attachmentToBlob(attachment: MessageAttachment): Blob {
  if (!validateAttachments([attachment])) throw new Error("This attachment is invalid and cannot be downloaded.")
  const binary = globalThis.atob(attachment.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: isPreviewableImage(attachment) ? attachment.type : "application/octet-stream" })
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(/\.0$/, "")} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MiB`
}
