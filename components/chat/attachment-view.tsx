"use client"

import { useEffect, useMemo, useState } from "react"
import { Download, FileText, LoaderCircle } from "lucide-react"
import type { AttachmentMeta } from "@/lib/messaging-types"
import { assembleAttachment, attachmentPreviewKind, attachmentProgress, formatFileSize, isAttachmentMeta, safeFilename, type AttachmentChunk } from "@/lib/attachments"

export function AttachmentView({ metadata, chunks }: { metadata: AttachmentMeta; chunks: AttachmentChunk[] }) {
  const [result, setResult] = useState<{ key: string; url?: string; error?: string } | null>(null)
  // Incoming arrays may be rebuilt by the provider while their contents stay unchanged.
  const key = useMemo(() => JSON.stringify([metadata, chunks]), [metadata, chunks])
  const complete = attachmentProgress(metadata, chunks) === 100
  const valid = isAttachmentMeta(metadata)
  useEffect(() => {
    if (!valid || !complete) return
    let disposed = false
    let objectUrl: string | undefined
    const [meta, pieces] = JSON.parse(key) as [AttachmentMeta, AttachmentChunk[]]
    assembleAttachment(meta, pieces).then(blob => {
      if (disposed) return
      objectUrl = URL.createObjectURL(blob)
      setResult({ key, url: objectUrl })
    }).catch(cause => {
      if (!disposed) setResult({ key, error: cause instanceof Error ? cause.message : "Unable to open this attachment." })
    })
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [key, complete, valid])

  if (!valid) return <p role="alert" className="text-sm text-destructive">This attachment has invalid details.</p>
  const activeResult = result?.key === key ? result : null
  const preview = attachmentPreviewKind(metadata.mime)
  return <div className="my-1 min-w-0 max-w-sm space-y-2 rounded-xl border border-current/15 bg-background/20 p-3">
    <div className="flex items-start gap-2">
      <FileText className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="break-all text-sm font-medium">{safeFilename(metadata.name)}</p>
        <p className="text-xs opacity-70">{metadata.kind === "voice" ? "Voice message · " : ""}{formatFileSize(metadata.size)}</p>
      </div>
    </div>
    {!complete && <div role="status" className="space-y-1 text-xs">
      <span>Receiving file · {attachmentProgress(metadata, chunks)}%</span>
      <progress aria-label="File received" max={100} value={attachmentProgress(metadata, chunks)} className="h-1 w-full" />
    </div>}
    {complete && !activeResult && <p role="status" className="flex items-center gap-2 text-xs"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />Checking file…</p>}
    {activeResult?.error && <p role="alert" className="text-sm text-destructive">{activeResult.error}</p>}
    {activeResult?.url && <>
      {preview === "image" && <img src={activeResult.url} alt={safeFilename(metadata.name)} loading="lazy" className="max-h-72 max-w-full rounded-lg object-contain" />}
      {preview === "audio" && <audio controls preload="metadata" src={activeResult.url} aria-label={metadata.kind === "voice" ? "Play voice message" : `Play ${safeFilename(metadata.name)}`} className="max-w-full">Your browser cannot play this audio. Download it below.</audio>}
      <a href={activeResult.url} download={safeFilename(metadata.name)} className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm underline underline-offset-4 focus-visible:outline-2">
        <Download className="size-4" aria-hidden="true" />Download
      </a>
    </>}
  </div>
}
