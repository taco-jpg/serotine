import { getNativeBridge } from "@/native/shared/bridge"

export async function saveDownload(blob: Blob, name: string): Promise<boolean> {
  const native = getNativeBridge()
  if (native) {
    if (blob.size > 64 * 1024 ** 2) throw new Error("Installed-app exports currently support files up to 64 MiB.")
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ""
    for (let index = 0; index < bytes.length; index += 16384) binary += String.fromCharCode(...bytes.subarray(index, index + 16384))
    return (await native.saveFile({ name, mimeType: blob.type || "application/octet-stream", dataBase64: btoa(binary) })).saved
  }
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url; anchor.download = name
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return true
}
