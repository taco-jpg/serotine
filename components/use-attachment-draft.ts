"use client"

import { useEffect, useRef, useState } from "react"
import { fileToAttachment, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, validateAttachments, type MessageAttachment } from "@/lib/legacy-attachments"

interface PendingFile { id: string; attachment: MessageAttachment }
interface AttachmentDraft { key: string; files: PendingFile[] }

// File drafts stay in this tab, including across keyed conversation remounts.
const selections = new Map<string, PendingFile[]>()
const listeners = new Set<() => void>()
const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  if (selections.size) { event.preventDefault(); event.returnValue = "" }
}
function remember(key: string, files: PendingFile[]) {
  if (files.length) selections.set(key, files)
  else selections.delete(key)
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeunload", warnBeforeUnload)
    if (selections.size) window.addEventListener("beforeunload", warnBeforeUnload)
  }
  for (const listener of listeners) listener()
}

export function useAttachmentDraft(owner: string, peer: string) {
  const key = owner ? `${owner}:${peer}` : ""
  const scope = useRef<{ key: string; preparing: boolean } | null>(null)
  const [draft, setDraft] = useState<AttachmentDraft>({ key: "", files: [] })
  const [preparing, setPreparing] = useState(false)
  const [issue, setIssue] = useState("")

  useEffect(() => {
    const current = { key, preparing: false }
    scope.current = current
    const refresh = () => {
      if (scope.current === current) setDraft({ key, files: selections.get(key) ?? [] })
    }
    refresh(); setPreparing(false); setIssue("")
    listeners.add(refresh)
    return () => { listeners.delete(refresh); if (scope.current === current) scope.current = null }
  }, [key])

  const addFiles = async (files: File[]) => {
    const current = scope.current
    if (!key || !current || current.key !== key || current.preparing || !files.length) return
    const existing = selections.get(key) ?? []
    setIssue("")
    if (existing.length + files.length > MAX_ATTACHMENTS) {
      setIssue(`You can attach up to ${MAX_ATTACHMENTS} files per message. Remove a file before adding more.`)
      return
    }
    if (existing.reduce((total, file) => total + file.attachment.size, 0) + files.reduce((total, file) => total + file.size, 0) > MAX_ATTACHMENT_BYTES) {
      setIssue("These files exceed the 1 MiB total limit. Choose smaller files or send them in separate messages.")
      return
    }
    current.preparing = true; setPreparing(true)
    try {
      const attachments = await Promise.all(files.map(fileToAttachment))
      if (scope.current !== current) return
      // Re-read memory in case a previously submitted send finished during reading.
      const retained = selections.get(key) ?? []
      if (!validateAttachments([...retained.map(file => file.attachment), ...attachments])) throw new Error("Choose up to 4 valid files, totaling no more than 1 MiB.")
      remember(key, [...retained, ...attachments.map(attachment => ({ id: crypto.randomUUID(), attachment }))])
    } catch (cause) {
      if (scope.current === current) setIssue(cause instanceof Error ? cause.message : "These files could not be opened. Please select them again.")
    } finally {
      if (scope.current === current) { current.preparing = false; setPreparing(false) }
    }
  }

  const removeFile = (id: string) => {
    if (scope.current?.key !== key || scope.current.preparing) return
    remember(key, (selections.get(key) ?? []).filter(file => file.id !== id))
    setIssue("")
  }

  // Each completion removes only the exact submitted files. New selections made
  // after navigating away and back survive, even if they have identical names.
  const clearSubmittedAttachments = () => {
    if (!key || draft.key !== key) return
    const submitted = new Set(draft.files.map(file => file.id))
    if (submitted.size) remember(key, (selections.get(key) ?? []).filter(file => !submitted.has(file.id)))
  }

  return {
    files: draft.key === key ? draft.files : [],
    attachmentReady: !!key && draft.key === key,
    preparing, issue, addFiles, removeFile, clearSubmittedAttachments,
    isPreparing: () => scope.current?.preparing ?? false,
  }
}
