/** Bounded, local-only profile image processing. No URL or declared MIME is trusted. */
export type ProfileMedia = {
  mime: "image/png" | "image/webp" | "image/gif"
  data: string
  still: string
  width: number
  height: number
  animated: boolean
  position?: number
}

export type ProfileMediaKind = "avatar" | "banner"
export const PROFILE_MEDIA_LIMITS = {
  inputBytes: 4 * 1024 * 1024,
  outputBytes: 128 * 1024,
  stillBytes: 32 * 1024,
  dimension: 4096,
  pixels: 16 * 1024 * 1024,
  frames: 80,
  durationMs: 20_000,
  animationPixels: 32 * 1024 * 1024,
  avatar: { width: 512, height: 512 },
  banner: { width: 1024, height: 512 },
} as const

export type ProfileImageInspection = {
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  width: number
  height: number
  frames: number
  durationMs: number
  /** Rebuilt raster container with metadata removed. */
  bytes: Uint8Array
  /** A standalone first GIF frame, so still previews never race animation playback. */
  firstFrame?: Uint8Array
}

function invalid(message = "This image is malformed or unsupported."): never { throw new Error(message) }
function requireBytes(b: Uint8Array, offset: number, count: number) {
  if (offset < 0 || count < 0 || offset + count > b.length) invalid()
}
function u16(b: Uint8Array, n: number) { requireBytes(b, n, 2); return b[n] | b[n + 1] << 8 }
function u24(b: Uint8Array, n: number) { requireBytes(b, n, 3); return b[n] | b[n + 1] << 8 | b[n + 2] << 16 }
function u32(b: Uint8Array, n: number, little = false) {
  requireBytes(b, n, 4)
  return new DataView(b.buffer, b.byteOffset + n, 4).getUint32(0, little)
}
function ascii(b: Uint8Array, start: number, end: number) { return String.fromCharCode(...b.subarray(start, end)) }
function combine(parts: Uint8Array[]) {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
function dimensions(width: number, height: number) {
  if (!width || !height || width > PROFILE_MEDIA_LIMITS.dimension || height > PROFILE_MEDIA_LIMITS.dimension
    || width * height > PROFILE_MEDIA_LIMITS.pixels) invalid("Images must be at most 4096 × 4096 pixels.")
}
function same(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((value, i) => value === b[i]) }

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function png(b: Uint8Array): ProfileImageInspection {
  const parts = [b.slice(0, 8)]
  let offset = 8, width = 0, height = 0, image = false, ended = false, chunks = 0
  while (offset < b.length) {
    if (++chunks > 2048) invalid()
    requireBytes(b, offset, 12)
    const size = u32(b, offset), tag = ascii(b, offset + 4, offset + 8), end = offset + 12 + size
    requireBytes(b, offset, 12 + size)
    if (!/^[A-Za-z]{4}$/.test(tag) || crc32(b.subarray(offset + 4, end - 4)) !== u32(b, end - 4)) invalid()
    if (chunks === 1 && tag !== "IHDR") invalid()
    if (tag === "IHDR") {
      if (chunks !== 1 || size !== 13) invalid()
      width = u32(b, offset + 8); height = u32(b, offset + 12); dimensions(width, height)
      const depth = b[offset + 16], color = b[offset + 17]
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!depths[color]?.includes(depth) || b[offset + 18] !== 0 || b[offset + 19] !== 0 || b[offset + 20] > 1) invalid()
    } else if (tag === "acTL" || tag === "fcTL" || tag === "fdAT") {
      invalid("Use GIF for animated profile images.")
    } else if (tag === "IDAT") { if (size) image = true }
    else if (tag === "IEND") { if (size || !image || end !== b.length) invalid(); ended = true }
    else if ((b[offset + 4] & 32) === 0 && tag !== "PLTE") invalid()
    // Only pixel-critical chunks survive; EXIF, text, ICC and other ancillary data do not.
    if (["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(tag)) parts.push(b.slice(offset, end))
    offset = end
  }
  if (!ended) invalid()
  return { mime: "image/png", width, height, frames: 1, durationMs: 0, bytes: combine(parts) }
}

function jpeg(b: Uint8Array): ProfileImageInspection {
  const parts = [b.slice(0, 2)]
  let offset = 2, width = 0, height = 0, scans = 0, ended = false
  while (offset < b.length) {
    const start = offset
    if (b[offset++] !== 0xff) invalid()
    while (b[offset] === 0xff) offset++
    const marker = b[offset++]
    if (marker === 0xd9) { if (offset !== b.length || !scans) invalid(); parts.push(b.slice(start, offset)); ended = true; break }
    if (marker === undefined || marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) invalid()
    const length = (b[offset] << 8) | b[offset + 1]
    if (length < 2) invalid()
    requireBytes(b, offset, length)
    const end = offset + length
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (width || length < 8 || b[offset + 2] !== 8) invalid()
      height = (b[offset + 3] << 8) | b[offset + 4]; width = (b[offset + 5] << 8) | b[offset + 6]
      dimensions(width, height)
    } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) invalid()
    // APPn (including EXIF/GPS, XMP, ICC) and comments are never passed to decoders or peers.
    if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) parts.push(b.slice(start, end))
    offset = end
    if (marker === 0xda) {
      if (!width || ++scans > 256) invalid()
      const entropyStart = offset
      while (offset < b.length) {
        if (b[offset] !== 0xff) { offset++; continue }
        if (b[offset + 1] === 0 || (b[offset + 1] >= 0xd0 && b[offset + 1] <= 0xd7)) { offset += 2; continue }
        break
      }
      parts.push(b.slice(entropyStart, offset))
    }
  }
  if (!ended || !width) invalid()
  return { mime: "image/jpeg", width, height, frames: 1, durationMs: 0, bytes: combine(parts) }
}

function webp(b: Uint8Array): ProfileImageInspection {
  if (u32(b, 4, true) + 8 !== b.length) invalid()
  const parts: Uint8Array[] = []
  let offset = 12, width = 0, height = 0, canvasWidth = 0, canvasHeight = 0, alpha = false
  while (offset < b.length) {
    requireBytes(b, offset, 8)
    const tag = ascii(b, offset, offset + 4), size = u32(b, offset + 4, true), data = offset + 8, end = data + size + (size % 2)
    requireBytes(b, offset, end - offset)
    if (tag === "VP8X") {
      if (offset !== 12 || size !== 10 || (b[data] & 0xc1) || b[data + 1] || b[data + 2] || b[data + 3]) invalid()
      if (b[data] & 2) invalid("Use GIF for animated profile images.")
      canvasWidth = u24(b, data + 4) + 1; canvasHeight = u24(b, data + 7) + 1
      dimensions(canvasWidth, canvasHeight)
      const chunk = b.slice(offset, end)
      chunk[8] &= 0x10 // Keep alpha only; removed metadata must not remain advertised.
      parts.push(chunk)
    } else if (tag === "VP8 " || tag === "VP8L") {
      if (width) invalid()
      if (tag === "VP8 ") {
        if (size < 10 || (b[data] & 1) || b[data + 3] !== 0x9d || b[data + 4] !== 1 || b[data + 5] !== 0x2a) invalid()
        width = u16(b, data + 6) & 0x3fff; height = u16(b, data + 8) & 0x3fff
      } else {
        if (size < 5 || b[data] !== 0x2f || (b[data + 4] & 0xe0)) invalid()
        width = 1 + ((b[data + 1] | b[data + 2] << 8) & 0x3fff)
        height = 1 + ((b[data + 2] >> 6 | b[data + 3] << 2 | b[data + 4] << 10) & 0x3fff)
      }
      dimensions(width, height)
      parts.push(b.slice(offset, end))
    } else if (tag === "ALPH") {
      if (alpha || width || !canvasWidth || size < 1) invalid()
      alpha = true; parts.push(b.slice(offset, end))
    } else if (tag === "ANIM" || tag === "ANMF") invalid("Use GIF for animated profile images.")
    else if (!["EXIF", "XMP ", "ICCP"].includes(tag)) invalid()
    offset = end
  }
  if (!width || (canvasWidth && (canvasWidth !== width || canvasHeight !== height))) invalid()
  const header = b.slice(0, 12), payload = combine(parts)
  new DataView(header.buffer).setUint32(4, payload.length + 4, true)
  return { mime: "image/webp", width, height, frames: 1, durationMs: 0, bytes: combine([header, payload]) }
}

/** Validate each GIF frame's full LZW stream before giving it to an image decoder. */
function checkGifPixels(data: Uint8Array, minimum: number, pixels: number, paletteSize: number) {
  if (minimum < 2 || minimum > 8) invalid()
  const clear = 1 << minimum, stop = clear + 1
  const lengths = new Uint16Array(4096), first = new Uint16Array(4096), maxColor = new Uint16Array(4096)
  for (let i = 0; i < clear; i++) { lengths[i] = 1; first[i] = i; maxColor[i] = i }
  let bits = minimum + 1, next = stop + 1, previous = -1, bit = 0, count = 0, initialized = false
  while (bit + bits <= data.length * 8) {
    let code = 0
    for (let i = 0; i < bits; i++, bit++) code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i
    if (code === clear) { bits = minimum + 1; next = stop + 1; previous = -1; initialized = true; continue }
    if (!initialized) invalid()
    if (code === stop) { if (count !== pixels) invalid(); return }
    const special = code === next && previous >= 0
    if ((!special && code >= next) || (previous < 0 && code >= clear)) invalid()
    const length = special ? lengths[previous] + 1 : lengths[code]
    const color = special ? maxColor[previous] : maxColor[code]
    if (!length || color >= paletteSize || (count += length) > pixels) invalid()
    const leading = special ? first[previous] : first[code]
    if (previous >= 0 && next < 4096) {
      lengths[next] = lengths[previous] + 1
      first[next] = first[previous]
      maxColor[next] = Math.max(maxColor[previous], leading)
      next++
      if (next === (1 << bits) && bits < 12) bits++
    }
    previous = code
  }
  invalid()
}

function gif(b: Uint8Array): ProfileImageInspection {
  requireBytes(b, 0, 13)
  const width = u16(b, 6), height = u16(b, 8)
  dimensions(width, height)
  // Animation dimensions are checked even for a one-frame GIF, before frame allocation.
  if (width > PROFILE_MEDIA_LIMITS.banner.width || height > PROFILE_MEDIA_LIMITS.banner.height) invalid("GIFs must be at most 1024 × 512 pixels.")
  const globalColors = b[10] & 0x80 ? 1 << ((b[10] & 7) + 1) : 0
  let offset = 13 + globalColors * 3, frames = 0, durationMs = 0, ended = false, loop = false
  requireBytes(b, 0, offset)
  const header = b.slice(0, offset)
  header.set([71, 73, 70, 56, 57, 97])
  const parts: Uint8Array[] = [header]
  let control: Uint8Array | undefined, firstFrame: Uint8Array | undefined
  function blocks() {
    const values: Uint8Array[] = []
    while (true) {
      requireBytes(b, offset, 1)
      const count = b[offset++]
      if (!count) return combine(values)
      requireBytes(b, offset, count)
      values.push(b.slice(offset, offset + count)); offset += count
    }
  }
  while (offset < b.length) {
    const start = offset, tag = b[offset++]
    if (tag === 0x3b) { if (!frames || control || offset !== b.length) invalid(); ended = true; parts.push(new Uint8Array([0x3b])); break }
    if (tag === 0x21) {
      requireBytes(b, offset, 1)
      const extension = b[offset++]
      if (extension === 0xf9) {
        requireBytes(b, offset, 6)
        if (control || b[offset] !== 4 || b[offset + 5] !== 0 || (b[offset + 1] & 0xe0) || ((b[offset + 1] >> 2) & 7) > 3) invalid()
        control = b.slice(start, offset + 6)
        control[3] &= ~2 // User-input waits have no role in a profile animation.
        offset += 6
      } else if (extension === 0xfe) { blocks() }
      else if (extension === 0xff) {
        requireBytes(b, offset, 12)
        if (b[offset++] !== 11) invalid()
        const app = ascii(b, offset, offset + 11); offset += 11
        const payload = blocks()
        if (app === "NETSCAPE2.0" || app === "ANIMEXTS1.0") {
          if (loop || frames || payload.length !== 3 || payload[0] !== 1) invalid()
          loop = true
          parts.push(new Uint8Array([0x21, 0xff, 11, 78, 69, 84, 83, 67, 65, 80, 69, 50, 46, 48, 3, 1, payload[1], payload[2], 0]))
        }
        // All other application extensions (including XMP) are discarded.
      } else invalid()
    } else if (tag === 0x2c) {
      requireBytes(b, offset, 9)
      const left = u16(b, offset), top = u16(b, offset + 2), frameWidth = u16(b, offset + 4), frameHeight = u16(b, offset + 6), packed = b[offset + 8]
      if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height || (packed & 0x18)) invalid()
      if (++frames > PROFILE_MEDIA_LIMITS.frames || frames * width * height > PROFILE_MEDIA_LIMITS.animationPixels) invalid("GIF animation has too many decoded frames or pixels.")
      const colors = packed & 0x80 ? 1 << ((packed & 7) + 1) : globalColors
      if (!colors || (control && (control[3] & 1) && control[6] >= colors)) invalid()
      offset += 9 + ((packed & 0x80) ? colors * 3 : 0)
      requireBytes(b, offset, 1)
      const minimum = b[offset++], compressed = blocks()
      checkGifPixels(compressed, minimum, frameWidth * frameHeight, colors)
      const delay = control ? u16(control, 4) : 0
      durationMs += delay < 2 ? 100 : delay * 10
      if (durationMs > PROFILE_MEDIA_LIMITS.durationMs) invalid("GIF animation must be at most 20 seconds per loop.")
      if (control) parts.push(control)
      const frame = b.slice(start, offset)
      parts.push(frame)
      if (!firstFrame) firstFrame = combine([header, ...(control ? [control] : []), frame, new Uint8Array([0x3b])])
      control = undefined
    } else invalid()
  }
  if (!ended) invalid()
  return { mime: "image/gif", width, height, frames, durationMs, bytes: combine(parts), firstFrame }
}

/** Inspect actual bytes; throws for URLs, SVG/HTML, bad containers or excessive complexity. */
export function inspectProfileImage(bytes: Uint8Array): ProfileImageInspection {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > PROFILE_MEDIA_LIMITS.inputBytes) invalid("Choose an image no larger than 4 MiB.")
  if (same(bytes.subarray(0, 8), new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))) return png(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(bytes)
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return webp(bytes)
  if (["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6))) return gif(bytes)
  invalid("Choose a PNG, JPEG, static WebP, or GIF image.")
}

function base64(bytes: Uint8Array) {
  let binary = ""
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  return btoa(binary)
}
function unbase64(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maxBytes / 3) * 4
    || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid()
  const binary = atob(value)
  if (binary.length > maxBytes || btoa(binary) !== value) invalid()
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

/** Synchronous container validation. Receive paths must also await verifyProfileMedia before display. */
export function validateProfileMedia(value: unknown): value is ProfileMedia {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const item = value as Record<string, unknown>
    if (Object.keys(item).some(key => !["mime", "data", "still", "width", "height", "animated", "position"].includes(key))
      || !["image/png", "image/webp", "image/gif"].includes(item.mime as string)
      || typeof item.animated !== "boolean" || (item.position !== undefined && (typeof item.position !== "number" || !Number.isFinite(item.position) || item.position < 0 || item.position > 100))) return false
    const data = unbase64(item.data, PROFILE_MEDIA_LIMITS.outputBytes), still = unbase64(item.still, PROFILE_MEDIA_LIMITS.stillBytes)
    if (data.length + still.length > PROFILE_MEDIA_LIMITS.outputBytes) return false
    const info = inspectProfileImage(data), preview = inspectProfileImage(still)
    return info.mime === item.mime && info.width === item.width && info.height === item.height
      && info.width <= PROFILE_MEDIA_LIMITS.banner.width && info.height <= PROFILE_MEDIA_LIMITS.banner.height
      && item.animated === (info.frames > 1) && same(info.bytes, data)
      && preview.mime === "image/png" && preview.width <= 192 && preview.height <= 192 && same(preview.bytes, still)
  } catch { return false }
}

async function decodeImage(bytes: Uint8Array, mime: string): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime })
  if (typeof createImageBitmap === "function") {
    return new Promise((resolve, reject) => {
      let expired = false
      const timeout = setTimeout(() => { expired = true; reject(new Error("Image decoding took too long.")) }, 8000)
      createImageBitmap(blob).then(bitmap => {
        clearTimeout(timeout)
        if (expired) { bitmap.close(); return }
        resolve({ source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() })
      }, () => { clearTimeout(timeout); reject(new Error("This image cannot be decoded.")) })
    })
  }
  if (typeof Image === "undefined") invalid("Image processing requires a browser.")
  const url = URL.createObjectURL(blob), image = new Image()
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); URL.revokeObjectURL(url); image.onload = null; image.onerror = null }
    const timeout = setTimeout(() => { cleanup(); image.src = ""; reject(new Error("Image decoding took too long.")) }, 8000)
    image.onload = () => { cleanup(); resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = "" } }) }
    image.onerror = () => { cleanup(); reject(new Error("This image cannot be decoded.")) }
    image.src = url
  })
}

function canvasFor(source: CanvasImageSource, width: number, height: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height), canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext("2d")
  if (!context) invalid("This browser cannot process images.")
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}
function encodedCanvas(canvas: HTMLCanvasElement, mime: "image/png" | "image/webp", quality?: number) {
  const url = canvas.toDataURL(mime, quality), split = url.indexOf(",")
  const actual = url.startsWith("data:image/webp;base64,") ? "image/webp" : "image/png"
  if (split < 0 || (!url.startsWith("data:image/png;base64,") && actual !== "image/webp")) invalid("This browser cannot encode images.")
  return { mime: actual as "image/png" | "image/webp", bytes: inspectProfileImage(unbase64(url.slice(split + 1), PROFILE_MEDIA_LIMITS.inputBytes)).bytes }
}

/** Re-encodes static images; GIF frames/timing survive while private metadata does not. */
export async function prepareProfileMedia(file: Blob, kind: ProfileMediaKind): Promise<ProfileMedia> {
  if (!(file instanceof Blob) || file.size > PROFILE_MEDIA_LIMITS.inputBytes || !file.size) invalid("Choose an image no larger than 4 MiB.")
  const info = inspectProfileImage(new Uint8Array(await file.arrayBuffer())), bounds = PROFILE_MEDIA_LIMITS[kind]
  if (!bounds) invalid()
  if (info.mime === "image/gif" && (info.width > bounds.width || info.height > bounds.height)) invalid(`GIF ${kind}s must be at most ${bounds.width} × ${bounds.height} pixels.`)
  const decoded = await decodeImage(info.firstFrame ?? info.bytes, info.mime)
  try {
    if (decoded.width !== info.width || decoded.height !== info.height) invalid()
    let still: Uint8Array | undefined
    for (const size of [192, 128, 96, 64, 32]) {
      const candidate = encodedCanvas(canvasFor(decoded.source, info.width, info.height, size, size), "image/png").bytes
      if (candidate.length <= PROFILE_MEDIA_LIMITS.stillBytes) { still = candidate; break }
    }
    if (!still) invalid("Could not make a small image preview.")
    if (info.mime === "image/gif") {
      if (info.bytes.length + still.length > PROFILE_MEDIA_LIMITS.outputBytes) invalid("Processed GIF and preview must fit within 128 KiB. Choose a smaller or shorter GIF.")
      return { mime: info.mime, data: base64(info.bytes), still: base64(still), width: info.width, height: info.height, animated: info.frames > 1, position: 50 }
    }
    for (const scale of [1, 0.75, 0.5, 0.25]) {
      const canvas = canvasFor(decoded.source, info.width, info.height, bounds.width * scale, bounds.height * scale)
      for (const quality of [0.85, 0.65, 0.45]) {
        const result = encodedCanvas(canvas, "image/webp", quality)
        if (result.bytes.length + still.length <= PROFILE_MEDIA_LIMITS.outputBytes) {
          return { mime: result.mime, data: base64(result.bytes), still: base64(still), width: canvas.width, height: canvas.height, animated: false, position: 50 }
        }
      }
    }
    invalid("Could not reduce this image to 128 KiB. Choose a smaller image.")
  } finally { decoded.close() }
}

/** Validate an untrusted incoming media field, including actual browser raster decoding. */
export async function verifyProfileMedia(value: unknown): Promise<ProfileMedia> {
  if (!validateProfileMedia(value)) invalid("Invalid profile image.")
  const snapshot = { ...value }
  const info = inspectProfileImage(unbase64(snapshot.data, PROFILE_MEDIA_LIMITS.outputBytes))
  const preview = inspectProfileImage(unbase64(snapshot.still, PROFILE_MEDIA_LIMITS.stillBytes))
  for (const candidate of [info, preview]) {
    const decoded = await decodeImage(candidate.firstFrame ?? candidate.bytes, candidate.mime)
    try { if (decoded.width !== candidate.width || decoded.height !== candidate.height) invalid() }
    finally { decoded.close() }
  }
  return snapshot
}
