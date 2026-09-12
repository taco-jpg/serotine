"use client"

import { useEffect, useState } from "react"
import { Download, File, X } from "lucide-react"
import { attachmentToBlob, formatFileSize, isPreviewableImage, type MessageAttachment } from "@/lib/legacy-attachments"
import { MessageText } from "@/components/message-text"

function AttachmentCard({ attachment, query, mine, onRemove, disabled }: {
  attachment: MessageAttachment
  query: string
  mine: boolean
  onRemove?: () => void
  disabled?: boolean
}) {
  const [resource, setResource] = useState<{ attachment: MessageAttachment; url: string } | null>(null)
  const [failedImage, setFailedImage] = useState<MessageAttachment | null>(null)
  useEffect(() => {
    let url: string | undefined
    try {
      url = URL.createObjectURL(attachmentToBlob(attachment))
      setResource({ attachment, url })
    } catch { setResource(null) }
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [attachment])
  const url = resource?.attachment === attachment ? resource.url : undefined
  const previewable = isPreviewableImage(attachment)
  const label = `${attachment.name}, ${formatFileSize(attachment.size)}`
  return <li className={`min-w-0 overflow-hidden rounded-xl border ${mine ? "border-indigo-300/50 bg-white/40" : "border-zinc-700 bg-zinc-950/40"}`}>
    {previewable && <div className="flex h-48 min-w-40 items-center justify-center bg-black/5">
      {url && failedImage !== attachment
        ? <img src={url} alt={`Attachment preview: ${attachment.name}`} loading="lazy" decoding="async" className="h-full w-full object-contain" onError={() => setFailedImage(attachment)} />
        : <span className="px-3 text-xs opacity-70">{failedImage === attachment ? "Preview unavailable" : "Preparing preview…"}</span>}
    </div>}
    <div className="flex items-center gap-3 p-3">
      <File aria-hidden="true" className="size-5 shrink-0 opacity-60" />
      <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium"><MessageText content={attachment.name} query={query} /></p><p className="text-xs opacity-70">{formatFileSize(attachment.size)}{!url && " · Preview unavailable"}</p></div>
      {onRemove
        ? <button type="button" aria-label={`Remove ${label}`} disabled={disabled} className="flex size-9 shrink-0 items-center justify-center rounded-lg hover:bg-white/10 disabled:opacity-40" onClick={onRemove}><X aria-hidden="true" className="size-4" /></button>
        : url && <a href={url} download={attachment.name} aria-label={`Download ${label}`} className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${mine ? "hover:bg-indigo-200/80" : "hover:bg-zinc-800"}`}><Download aria-hidden="true" className="size-4" /></a>}
    </div>
  </li>
}

export function MessageAttachments({ attachments, query, mine }: { attachments: MessageAttachment[]; query: string; mine: boolean }) {
  return <ul aria-label={`${attachments.length} attached file${attachments.length === 1 ? "" : "s"}`} className="grid min-w-0 gap-2 whitespace-normal">
    {attachments.map((attachment, index) => <AttachmentCard key={index} attachment={attachment} query={query} mine={mine} />)}
  </ul>
}

export function PendingAttachments({ files, onRemove, disabled }: {
  files: { id: string; attachment: MessageAttachment }[]
  onRemove: (id: string) => void
  disabled: boolean
}) {
  return <ul aria-label="Files ready to send" className="grid max-h-60 gap-2 overflow-y-auto sm:grid-cols-2">
    {files.map(file => <AttachmentCard key={file.id} attachment={file.attachment} query="" mine={false} disabled={disabled} onRemove={() => onRemove(file.id)} />)}
  </ul>
}
