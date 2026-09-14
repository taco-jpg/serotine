"use client"

import { useEffect, useRef, useState } from "react"
import { Download, FileText, LoaderCircle, Maximize2, X } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import type { Identity } from "@/lib/identity"
import { downloadRemoteAttachment, MAX_AUTO_PREVIEW_BYTES, type AttachmentDownload } from "@/lib/file-upload-client"
import type { AttachmentMeta } from "@/lib/messaging-types"
import { assembleAttachment, attachmentPreviewKind, attachmentProgress, formatFileSize, isAttachmentMeta, safeFilename, type AttachmentChunk } from "@/lib/attachments"

type AttachmentSnapshot = { metadata: AttachmentMeta; chunks: AttachmentChunk[] }
const metadataFields = ["id", "name", "mime", "size", "chunks", "sha256", "kind", "duration"] as const
const sameChunks = (left: AttachmentChunk[], right: AttachmentChunk[]) => left.length === right.length
  && left.every((chunk, index) => chunk.index === right[index].index && chunk.data === right[index].data)

function snapshotAttachment(previous: AttachmentSnapshot | null, metadata: AttachmentMeta, chunks: AttachmentChunk[]): AttachmentSnapshot {
  const sameMetadata = previous && metadataFields.every(field => previous.metadata[field] === metadata[field])
  // Compare the existing base64 strings directly: serializing them here copies
  // tens of megabytes on every message update or keystroke in a media-heavy chat.
  if (sameMetadata && sameChunks(previous.chunks, chunks)) return previous
  // Keep a small immutable snapshot so replacement, mutation and missing pieces
  // invalidate the verified URL. Arrival order alone must not restart a GIF.
  const pieces = chunks.map(({ index, data }) => ({ index, data })).sort((a, b) => a.index - b.index)
  if (sameMetadata && sameChunks(previous.chunks, pieces)) return previous
  return { metadata: { ...metadata }, chunks: pieces }
}

export function AttachmentView({ metadata, chunks, identity }: { metadata: AttachmentMeta; chunks: AttachmentChunk[]; identity?: Identity | null }) {
  const [result, setResult] = useState<{ snapshot: AttachmentSnapshot; url?: string; error?: string } | null>(null)
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null)
  const previousSnapshot = useRef<AttachmentSnapshot | null>(null)
  const valid = isAttachmentMeta(metadata)
  const snapshot = valid ? snapshotAttachment(previousSnapshot.current, metadata, chunks) : null
  previousSnapshot.current = snapshot
  const progress = attachmentProgress(metadata, chunks)
  const complete = progress === 100
  useEffect(() => {
    if (!snapshot || !complete || metadata.remote) return
    let disposed = false
    let objectUrl: string | undefined
    assembleAttachment(snapshot.metadata, snapshot.chunks).then(blob => {
      if (disposed) return
      objectUrl = URL.createObjectURL(blob)
      setResult({ snapshot, url: objectUrl })
    }).catch(cause => {
      if (!disposed) setResult({ snapshot, error: cause instanceof Error ? cause.message : "Unable to open this attachment." })
    })
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [snapshot, complete])

  if (!valid) return <p role="alert" className="text-sm text-destructive">This attachment has invalid details.</p>
  if (metadata.remote) return <RemoteAttachmentView key={metadata.id + metadata.sha256} metadata={metadata} identity={identity} />
  const activeResult = result?.snapshot === snapshot ? result : null
  const preview = attachmentPreviewKind(metadata.mime)
  const name = safeFilename(metadata.name)
  const url = activeResult?.url
  const visual = preview === "image" || preview === "video"
  const previewFailed = !!url && failedPreviewUrl === url
  return <div className={`min-w-0 max-w-full ${visual ? "w-[28rem]" : "w-80 rounded-lg border border-current/15 bg-background/20 px-2"}`}>
    {!complete && <div role="status" className="space-y-1 text-xs">
      <span>Receiving file · {progress}%</span>
      <progress aria-label="File received" max={100} value={progress} className="h-1 w-full" />
    </div>}
    {complete && !activeResult && <p role="status" className="flex items-center gap-2 text-xs"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />Checking file…</p>}
    {activeResult?.error && <p role="alert" className="text-sm text-destructive">{activeResult.error}</p>}
    {url && !previewFailed && <>
      {preview === "image" && <Dialog key={url}>
        <DialogTrigger asChild><button type="button" aria-label={`Enlarge ${name}`} className="group relative block min-h-11 min-w-11 w-full cursor-zoom-in overflow-hidden rounded-lg bg-black/10 focus-visible:outline-2 focus-visible:outline-offset-2">
          <img src={url} alt={name} loading="lazy" decoding="async" className="block max-h-[min(16rem,35dvh)] w-full object-contain" onError={() => setFailedPreviewUrl(url)} />
          <span aria-hidden="true" className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/65 px-2 py-1 text-xs text-white"><Maximize2 className="size-3" />Enlarge</span>
        </button></DialogTrigger>
        <DialogContent className="max-w-6xl gap-3 p-3 sm:p-4">
          <DialogHeader><DialogTitle className="text-base leading-snug [overflow-wrap:anywhere]">{name}</DialogTitle><DialogDescription>{formatFileSize(metadata.size)} · Full image</DialogDescription></DialogHeader>
          <img src={url} alt={name} decoding="async" className="mx-auto block max-h-[calc(var(--app-height,100dvh)-12rem)] max-w-full rounded-lg object-contain" onError={() => setFailedPreviewUrl(url)} />
          <a href={url} download={name} className="inline-flex min-h-11 w-fit items-center gap-2 rounded-md px-2 text-sm underline underline-offset-4 focus-visible:outline-2"><Download className="size-4" aria-hidden="true" />Download original</a>
        </DialogContent>
      </Dialog>}
      {preview === "video" && <video controls playsInline preload="metadata" src={url} aria-label={`Play ${name}`} className="block max-h-[min(16rem,35dvh)] w-full rounded-lg bg-black object-contain" onError={() => setFailedPreviewUrl(url)}>Your browser cannot play this video. Download it below.</video>}
      {preview === "audio" && <audio controls preload="metadata" src={url} aria-label={metadata.kind === "voice" ? "Play voice message" : `Play ${name}`} className="mt-2 w-full max-w-full" onError={() => setFailedPreviewUrl(url)}>Your browser cannot play this audio. Download it below.</audio>}
    </>}
    {previewFailed && <p role="status" className="px-1 text-xs">This {preview} cannot be previewed in your browser. You can still download the original below.</p>}
    <div className="flex min-h-8 min-w-0 items-center gap-2">
      {!visual && <FileText className="size-4 shrink-0" aria-hidden="true" />}
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <p title={name} className="min-w-0 truncate text-xs font-medium">{metadata.kind === "voice" ? "Voice message · " : ""}{name}</p>
        <p className="shrink-0 text-xs opacity-70">{formatFileSize(metadata.size)}{metadata.mime === "image/gif" ? " · GIF" : ""}</p>
      </div>
      {url && <a href={url} download={name} aria-label={`Download ${name}`} title="Download original" className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-current/10 focus-visible:outline-2"><Download className="size-4" aria-hidden="true" /></a>}
    </div>
  </div>
}


type DownloadSession = { descriptor: string; active: boolean; controller?: AbortController; resource?: AttachmentDownload; url?: string }
function RemoteAttachmentView({ metadata, identity }: { metadata: AttachmentMeta; identity?: Identity | null }) {
  const [state, setState] = useState<{ progress: number; loading?: boolean; url?: string; error?: string; saved?: boolean }>({ progress: 0 })
  const [previewFailed, setPreviewFailed] = useState(false)
  const sessionRef = useRef<DownloadSession | null>(null)
  // The descriptor is small (at most 256 hashes). A changed signed descriptor
  // invalidates an existing download immediately, including in-place mutations.
  const descriptor = JSON.stringify(metadata)
  const identityKey = identity?.publicKey
  const preview = attachmentPreviewKind(metadata.mime), name = safeFilename(metadata.name)
  const visual = preview === "image" || preview === "video"

  async function download(session: DownloadSession, autoPreview: boolean) {
    if (!identity || !session.active || session.descriptor !== descriptor || session.controller) return
    const controller = new AbortController()
    session.controller = controller
    setState({ progress: 0, loading: true })
    try {
      const resource = await downloadRemoteAttachment(metadata, identity, { preview: autoPreview, signal: controller.signal,
        onProgress: progress => { if (session.active) setState({ progress, loading: true }) } })
      if (!session.active || controller.signal.aborted) { await resource.dispose(); return }
      if (session.url) URL.revokeObjectURL(session.url)
      await session.resource?.dispose()
      session.resource = resource
      session.url = resource.blob ? URL.createObjectURL(resource.blob) : undefined
      setState({ progress: 100, url: session.url, saved: !resource.blob })
      // Memory/OPFS fallback needs an explicit browser download after verification.
      if (!autoPreview && session.url) {
        const link = document.createElement("a")
        link.href = session.url; link.download = name; link.click()
      }
    } catch (error) {
      if (session.active) setState({ progress: 0, error: controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError")
        ? undefined : error instanceof Error ? error.message : "The file could not be downloaded. Retry the download." })
    } finally { session.controller = undefined }
  }

  useEffect(() => {
    const session: DownloadSession = { descriptor, active: true }
    sessionRef.current = session
    setState({ progress: 0 }); setPreviewFailed(false)
    if (identity && preview && metadata.size <= MAX_AUTO_PREVIEW_BYTES) void download(session, true)
    return () => {
      session.active = false; session.controller?.abort()
      if (session.url) URL.revokeObjectURL(session.url)
      void session.resource?.dispose()
    }
    // The descriptor includes every download-affecting field; this prevents a
    // refreshed message object from restarting a large transfer while typing.
  }, [descriptor, identityKey])

  const currentDescriptor = sessionRef.current?.descriptor === descriptor
  const url = currentDescriptor ? state.url : undefined
  return <div className={`min-w-0 max-w-full ${visual && url ? "w-[28rem]" : "w-80 rounded-lg border border-current/15 bg-background/20 px-2"}`}>
    {state.loading && <div role="status" className="space-y-1 text-xs"><span>Downloading · {state.progress}%</span><progress aria-label="File downloaded" max={100} value={state.progress} className="h-1 w-full" /></div>}
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
    {state.saved && <p role="status" className="text-xs">File saved.</p>}
    {url && !previewFailed && <>
      {preview === "image" && <Dialog key={url}><DialogTrigger asChild><button type="button" aria-label={`Enlarge ${name}`} className="block min-h-11 min-w-11 w-full cursor-zoom-in overflow-hidden rounded-lg focus-visible:outline-2"><img src={url} alt={name} loading="lazy" decoding="async" className="block max-h-[min(16rem,35dvh)] w-full object-contain" onError={() => setPreviewFailed(true)} /></button></DialogTrigger><DialogContent className="max-w-6xl gap-3 p-3 sm:p-4"><DialogHeader><DialogTitle className="text-base [overflow-wrap:anywhere]">{name}</DialogTitle><DialogDescription>{formatFileSize(metadata.size)} · Full image</DialogDescription></DialogHeader><img src={url} alt={name} className="mx-auto block max-h-[calc(var(--app-height,100dvh)-12rem)] max-w-full object-contain" onError={() => setPreviewFailed(true)} /></DialogContent></Dialog>}
      {preview === "video" && <video controls playsInline preload="metadata" src={url} aria-label={`Play ${name}`} className="block max-h-[min(16rem,35dvh)] w-full rounded-lg object-contain" onError={() => setPreviewFailed(true)} />}
      {preview === "audio" && <audio controls preload="metadata" src={url} aria-label={metadata.kind === "voice" ? "Play voice message" : `Play ${name}`} className="mt-2 w-full max-w-full" onError={() => setPreviewFailed(true)} />}
    </>}
    {previewFailed && <p className="text-xs">This file cannot be previewed. Download the original below.</p>}
    <div className="flex min-h-11 min-w-0 items-center gap-2"><FileText className="size-4 shrink-0" aria-hidden="true" /><div className="min-w-0 flex-1"><p title={name} className="truncate text-xs font-medium">{metadata.kind === "voice" ? "Voice message · " : ""}{name}</p><p className="text-xs opacity-70">{formatFileSize(metadata.size)}</p></div>
      {state.loading ? <button type="button" aria-label={`Cancel downloading ${name}`} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-current/10" onClick={() => sessionRef.current?.controller?.abort()}><X className="size-4" /></button>
        : url ? <a href={url} download={name} aria-label={`Download ${name}`} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-current/10"><Download className="size-4" /></a>
          : <button type="button" disabled={!identity} aria-label={`Download ${name}`} className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-current/10 disabled:opacity-50" onClick={() => { if (sessionRef.current) void download(sessionRef.current, false) }}><Download className="size-4" /></button>}
    </div>
    {!url && !state.loading && !state.saved && <p className="pb-2 text-xs opacity-70">Download to keep a copy. {metadata.remote?.expiresAt ? `Available until ${new Date(metadata.remote.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}.` : "Files are available for 30 days after sending."}</p>}
  </div>
}
