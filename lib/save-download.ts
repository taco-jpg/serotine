import { getNativeBridge, isWindowsNative } from "@/native/shared/bridge"

export async function saveDownload(blob: Blob, name: string): Promise<boolean> {
  const native = getNativeBridge()
  if (native) {
    if (!isWindowsNative() && blob.size > 64 * 1024 ** 2) throw new Error("Installed-app exports currently support files up to 64 MiB.")
    const parts: string[] = []
    // Keep only a small byte buffer alongside the required IPC base64 string.
    // Three-byte-aligned chunks may be independently encoded and concatenated.
    for (let index = 0; index < blob.size; index += 0x6000) {
      const bytes = new Uint8Array(await blob.slice(index, index + 0x6000).arrayBuffer())
      parts.push(btoa(String.fromCharCode(...bytes)))
    }
    return (await native.saveFile({ name, mimeType: blob.type || "application/octet-stream", dataBase64: parts.join("") })).saved
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url; anchor.download = name
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
