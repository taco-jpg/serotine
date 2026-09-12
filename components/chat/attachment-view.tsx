"use client"

import { useEffect, useMemo, useState } from "react"
import { Download, FileText, LoaderCircle, Maximize2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import type { AttachmentMeta } from "@/lib/messaging-types"
import { assembleAttachment, attachmentPreviewKind, attachmentProgress, formatFileSize, isAttachmentMeta, safeFilename, type AttachmentChunk } from "@/lib/attachments"

export function AttachmentView({ metadata, chunks }: { metadata: AttachmentMeta; chunks: AttachmentChunk[] }) {
  const [result, setResult] = useState<{ key: string; url?: string; error?: string } | null>(null)
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null)
  // Incoming arrays may be rebuilt by the provider while their contents stay unchanged.
  const key = useMemo(() => JSON.stringify([metadata, chunks]), [metadata, chunks])
  const progress = attachmentProgress(metadata, chunks)
  const complete = progress === 100
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
  const name = safeFilename(metadata.name)
  const url = activeResult?.url
  const visual = preview === "image" || preview === "video"
  const previewFailed = !!url && failedPreviewUrl === url
  return <div className={`my-1 min-w-0 max-w-full space-y-2 rounded-xl border border-current/15 bg-background/20 p-2 ${visual ? "w-[32rem]" : "w-80"}`}>
    {!complete && <div role="status" className="space-y-1 text-xs">
      <span>Receiving file · {progress}%</span>
      <progress aria-label="File received" max={100} value={progress} className="h-1 w-full" />
    </div>}
    {complete && !activeResult && <p role="status" className="flex items-center gap-2 text-xs"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />Checking file…</p>}
    {activeResult?.error && <p role="alert" className="text-sm text-destructive">{activeResult.error}</p>}
    {url && !previewFailed && <>
      {preview === "image" && <Dialog key={url}>
        <DialogTrigger asChild><button type="button" aria-label={`Enlarge ${name}`} className="group relative block w-full cursor-zoom-in overflow-hidden rounded-lg bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2">
          <img src={url} alt={name} loading="lazy" decoding="async" className="block max-h-[min(28rem,65dvh)] w-full object-contain" onError={() => setFailedPreviewUrl(url)} />
          <span aria-hidden="true" className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/65 px-2 py-1 text-xs text-white"><Maximize2 className="size-3" />Enlarge</span>
        </button></DialogTrigger>
        <DialogContent className="max-w-6xl gap-3 p-3 sm:p-4">
          <DialogHeader><DialogTitle className="text-base leading-snug [overflow-wrap:anywhere]">{name}</DialogTitle><DialogDescription>{formatFileSize(metadata.size)} · Full image</DialogDescription></DialogHeader>
          <img src={url} alt={name} decoding="async" className="mx-auto block max-h-[calc(var(--app-height,100dvh)-12rem)] max-w-full rounded-lg object-contain" onError={() => setFailedPreviewUrl(url)} />
          <a href={url} download={name} className="inline-flex min-h-11 w-fit items-center gap-2 rounded-md px-2 text-sm underline underline-offset-4 focus-visible:outline-2"><Download className="size-4" aria-hidden="true" />Download original</a>
        </DialogContent>
      </Dialog>}
      {preview === "video" && <video controls playsInline preload="metadata" src={url} aria-label={`Play ${name}`} className="block max-h-[min(28rem,65dvh)] w-full rounded-lg bg-black object-contain" onError={() => setFailedPreviewUrl(url)}>Your browser cannot play this video. Download it below.</video>}
      {preview === "audio" && <audio controls preload="metadata" src={url} aria-label={metadata.kind === "voice" ? "Play voice message" : `Play ${name}`} className="w-full max-w-full" onError={() => setFailedPreviewUrl(url)}>Your browser cannot play this audio. Download it below.</audio>}
    </>}
    {previewFailed && <p role="status" className="px-1 text-xs">This {preview} cannot be previewed in your browser. You can still download the original below.</p>}
    <div className="flex min-w-0 items-center gap-2 px-1">
      {!visual && <FileText className="size-4 shrink-0" aria-hidden="true" />}
      <div className="min-w-0 flex-1">
        <p title={name} className="truncate text-xs font-medium">{name}</p>
        <p className="text-xs opacity-70">{metadata.kind === "voice" ? "Voice message · " : ""}{formatFileSize(metadata.size)}{metadata.mime === "image/gif" ? " · GIF" : ""}</p>
      </div>
      {url && <a href={url} download={name} aria-label={`Download ${name}`} title="Download original" className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-current/10 focus-visible:outline-2"><Download className="size-4" aria-hidden="true" /></a>}
    </div>
  </div>
}
