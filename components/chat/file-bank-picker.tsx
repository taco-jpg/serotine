"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { File as FileIcon, FolderHeart, Pencil, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { attachmentPreviewKind, formatFileSize, MAX_FILE_BYTES } from "@/lib/attachments"
import { BANK_MAX_BYTES, BANK_MAX_FILES, deleteBankFile, getBankFile, listBankFiles, renameBankFile, saveBankFiles, subscribeToFileBank, type BankFile } from "@/lib/file-bank"

interface FileBankPickerProps {
  owner: string
  disabled?: boolean
  onSelectFile: (file: File) => Promise<void>
}

function BankThumbnail({ entry }: { entry: BankFile }) {
  const [preview, setPreview] = useState<{ blob: Blob; url: string } | null>(null)
  const [failed, setFailed] = useState(false)
  const kind = attachmentPreviewKind(entry.mime)
  useEffect(() => {
    setFailed(false)
    if (kind !== "image" && kind !== "video") return
    const url = URL.createObjectURL(entry.blob)
    setPreview({ blob: entry.blob, url })
    return () => URL.revokeObjectURL(url)
  }, [entry.blob, kind])
  const url = preview?.blob === entry.blob ? preview.url : ""
  return <div className="flex h-28 w-full items-center justify-center overflow-hidden rounded-md bg-muted/50">
    {url && !failed && kind === "image" ? <img src={url} alt="" loading="lazy" className="h-full w-full object-contain" onError={() => setFailed(true)} />
      : url && !failed && kind === "video" ? <video src={url} muted playsInline preload="metadata" aria-label={`Video preview: ${entry.name}`} className="h-full w-full object-contain" onError={() => setFailed(true)} />
        : <FileIcon aria-hidden="true" className="size-9 text-muted-foreground" />}
  </div>
}

// Key the complete state and async lifecycle by identity; old blobs never flash after a switch.
export function FileBankPicker(props: FileBankPickerProps) {
  return <ScopedFileBankPicker key={props.owner} {...props} />
}

function ScopedFileBankPicker({ owner, disabled = false, onSelectFile }: FileBankPickerProps) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<BankFile[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState("")
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [editing, setEditing] = useState<BankFile | null>(null)
  const [name, setName] = useState("")
  const upload = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const openRef = useRef(false)
  const disabledRef = useRef(disabled)
  const busyRef = useRef(false)
  const loadId = useRef(0)
  const session = useRef(0)
  disabledRef.current = disabled

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; session.current++; loadId.current++ }
  }, [])

  const refresh = useCallback(async () => {
    if (!mounted.current || !openRef.current) return
    const attempt = ++loadId.current
    setLoading(true)
    try {
      const saved = await listBankFiles(owner)
      if (mounted.current && openRef.current && loadId.current === attempt) { setEntries(saved); setError("") }
    } catch (cause) {
      if (mounted.current && openRef.current && loadId.current === attempt) setError(cause instanceof Error ? cause.message : "Unable to load saved files.")
    } finally {
      if (mounted.current && openRef.current && loadId.current === attempt) setLoading(false)
    }
  }, [owner])

  useEffect(() => {
    if (!open) return
    void refresh()
    return subscribeToFileBank(owner, () => { void refresh() })
  }, [open, owner, refresh])

  function changeOpen(next: boolean) {
    if (next && disabledRef.current) return
    openRef.current = next
    session.current++
    loadId.current++
    setOpen(next)
    setError("")
    setNotice("")
    setEditing(null)
    if (!next) { setEntries([]); setQuery(""); setLoading(false) }
  }

  async function run(action: (current: () => boolean) => Promise<void>) {
    if (disabledRef.current || busyRef.current || !openRef.current) return
    const attempt = session.current
    const current = () => mounted.current && openRef.current && session.current === attempt
    busyRef.current = true
    setBusy(true)
    setError("")
    setNotice("")
    try { await action(current) }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : "Unable to update saved files.") }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  function addFiles(files: File[]) {
    if (!files.length) return
    void run(async current => {
      await saveBankFiles(owner, files)
      if (current()) { await refresh(); if (current()) setNotice(`${files.length === 1 ? "File" : `${files.length} files`} saved to your bank.`) }
    })
  }

  function choose(entry: BankFile) {
    void run(async current => {
      const file = await getBankFile(owner, entry.id)
      if (!current() || disabledRef.current) return
      await onSelectFile(file)
      if (current()) changeOpen(false)
    })
  }

  const unavailable = disabled || busy
  const filtered = entries.filter(entry => entry.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const bytes = entries.reduce((total, entry) => total + entry.size, 0)
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="icon" disabled={unavailable || !owner} aria-label="Open file bank" title="File bank"><FolderHeart aria-hidden="true" className="size-4" /></Button></DialogTrigger>
    <DialogContent className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>File bank</DialogTitle>
        <DialogDescription>Keep favorite GIFs and files ready to reuse. Saved in this browser for this identity; not included in backups. Choose a file to preview before sending.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap items-center gap-2">
        <Input type="search" aria-label="Search saved files" placeholder="Search saved files…" value={query} onChange={event => setQuery(event.target.value)} className="min-w-0 flex-1 basis-40" />
        <Button type="button" variant="outline" disabled={unavailable} onClick={() => upload.current?.click()}><Plus aria-hidden="true" className="size-4" />Add files</Button>
        <input ref={upload} type="file" multiple className="hidden" aria-label="Add files to your bank" disabled={unavailable} onChange={event => { addFiles(Array.from(event.target.files || [])); event.target.value = "" }} />
      </div>
      <p className="text-xs text-muted-foreground">{entries.length}/{BANK_MAX_FILES} files · {formatFileSize(bytes)} / {formatFileSize(BANK_MAX_BYTES)} · up to {formatFileSize(MAX_FILE_BYTES)} per file</p>
      {error && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{error}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>Reload files</Button></div>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      {editing && <form className="flex flex-wrap gap-2 rounded-lg border p-3" onSubmit={event => {
        event.preventDefault()
        void run(async current => { await renameBankFile(owner, editing.id, name); if (current()) { setEditing(null); await refresh() } })
      }}>
        <label className="w-full text-sm" htmlFor="file-bank-rename">Rename {editing.name}</label>
        <Input id="file-bank-rename" autoFocus maxLength={160} value={name} disabled={unavailable} onChange={event => setName(event.target.value)} className="min-w-0 flex-1 basis-40" />
        <Button type="submit" size="sm" disabled={unavailable || !name.trim()}>Save name</Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
      </form>}
      <div className="max-h-[45dvh] min-h-28 overflow-y-auto overscroll-contain">
        {loading && !entries.length ? <p role="status" className="py-8 text-center text-sm text-muted-foreground">Loading saved files…</p>
          : !filtered.length ? <p className="py-8 text-center text-sm text-muted-foreground">{query.trim() ? "No saved files match your search." : "Your bank is empty. Add a GIF, image, video, or file to get started."}</p>
            : <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">{filtered.map(entry => <li key={entry.id} className="min-w-0 rounded-lg border p-2">
              <button type="button" className="w-full rounded-md text-left focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50" disabled={unavailable} aria-label={`Choose ${entry.name}`} onClick={() => choose(entry)}>
                <BankThumbnail entry={entry} />
                <span className="mt-2 block truncate text-sm font-medium" title={entry.name}>{entry.name}</span>
                <span className="block text-xs text-muted-foreground">{formatFileSize(entry.size)}{entry.mime === "image/gif" ? " · GIF" : entry.mime.startsWith("video/") ? " · Video" : ""}</span>
              </button>
              <div className="mt-1 flex justify-end gap-1">
                <Button type="button" variant="ghost" size="icon" disabled={unavailable} aria-label={`Rename ${entry.name}`} title="Rename saved file" onClick={() => { setEditing(entry); setName(entry.name) }}><Pencil aria-hidden="true" className="size-3.5" /></Button>
                <Button type="button" variant="ghost" size="icon" disabled={unavailable} aria-label={`Remove ${entry.name} from bank`} title="Remove from bank" onClick={() => void run(async current => {
                  await deleteBankFile(owner, entry.id)
                  if (current()) { if (editing?.id === entry.id) setEditing(null); await refresh(); if (current()) setNotice("Removed from your bank. Sent messages are unchanged.") }
                })}><Trash2 aria-hidden="true" className="size-3.5" /></Button>
              </div>
            </li>)}</ul>}
      </div>
      {busy && <p role="status" className="text-xs text-muted-foreground">Working…</p>}
    </DialogContent>
  </Dialog>
}
