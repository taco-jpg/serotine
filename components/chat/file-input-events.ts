/** File input is scoped to a conversation, with paste limited to its composer. */
export function filesFromTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const files = Array.from(transfer.files)
  if (files.length) return files
  return Array.from(transfer.items || []).flatMap(item => {
    if (item.kind !== "file") return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

export function bindFileInputEvents(dropTarget: HTMLElement, pasteTarget: HTMLElement, callbacks: {
  canAccept: () => boolean
  onFiles: (files: File[]) => void
  onDragging: (dragging: boolean) => void
  onUnavailable: () => void
}): () => void {
  let depth = 0
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types || []).includes("Files")
  const stopDragging = () => { depth = 0; callbacks.onDragging(false) }
  const enter = (event: DragEvent) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    depth++
    callbacks.onDragging(callbacks.canAccept())
  }
  const over = (event: DragEvent) => {
    if (!hasFiles(event)) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = callbacks.canAccept() ? "copy" : "none"
  }
  const leave = () => {
    depth = Math.max(0, depth - 1)
    if (!depth) callbacks.onDragging(false)
  }
  const drop = (event: DragEvent) => {
    if (!hasFiles(event)) return
    // Even while disabled, keep a file drop from navigating away from the chat.
    event.preventDefault()
    stopDragging()
    if (!callbacks.canAccept()) { callbacks.onUnavailable(); return }
    const files = filesFromTransfer(event.dataTransfer)
    if (files.length) callbacks.onFiles(files)
  }
  const paste = (event: ClipboardEvent) => {
    const files = filesFromTransfer(event.clipboardData)
    // Ordinary text, including text copied from a message, keeps normal behavior.
    if (!files.length) return
    event.preventDefault()
    if (!callbacks.canAccept()) { callbacks.onUnavailable(); return }
    callbacks.onFiles(files)
  }
  dropTarget.addEventListener("dragenter", enter)
  dropTarget.addEventListener("dragover", over)
  dropTarget.addEventListener("dragleave", leave)
  dropTarget.addEventListener("drop", drop)
  dropTarget.addEventListener("dragend", stopDragging)
  pasteTarget.addEventListener("paste", paste)
  return () => {
    dropTarget.removeEventListener("dragenter", enter)
    dropTarget.removeEventListener("dragover", over)
    dropTarget.removeEventListener("dragleave", leave)
    dropTarget.removeEventListener("drop", drop)
    dropTarget.removeEventListener("dragend", stopDragging)
    pasteTarget.removeEventListener("paste", paste)
  }
}
