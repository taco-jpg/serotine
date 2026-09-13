"use client"

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from "react"
import { File as FileIcon, FolderPlus, Mic, Paperclip, Settings2, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MAX_FILE_BYTES, attachmentPreviewKind, formatFileSize, safeFilename, validateAttachmentFile, type AttachmentCaption, type AttachmentKind, type AttachmentProgress } from "@/lib/attachments"
import { bindFileInputEvents } from "./file-input-events"
import { compactAttachment } from "@/lib/compact-attachment"
import { AutoCompactFilesSetting, useAutoCompactFiles } from "./use-auto-compact-files"
import { FileBankPicker } from "./file-bank-picker"
import { GifPicker } from "./gif-picker"
import { saveBankFiles } from "@/lib/file-bank"

const RECORDING_LIMIT_SECONDS = 300
const MAX_QUEUED_FILES = 8
type PendingFile = { id: number; file: File; kind: AttachmentKind; originalBytes?: number }

export type AttachmentComposerState = { count: number; unavailable: boolean }
export type AttachmentComposerHandle = {
  getState: () => AttachmentComposerState
  sendAll: (caption: AttachmentCaption, onFirstSent: () => void) => Promise<void>
}

function AttachmentPreview({ item }: { item: PendingFile }) {
  const [url, setUrl] = useState("")
  const previewKind = attachmentPreviewKind(item.file.type.split(";")[0])
  useEffect(() => {
    if (!previewKind) return
    const objectUrl = URL.createObjectURL(item.file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [item.file, previewKind])

  if (url && previewKind === "image") return <img src={url} alt={safeFilename(item.file.name)} className="h-24 w-full rounded object-contain" />
  if (url && previewKind === "video") return <video controls playsInline preload="metadata" src={url} aria-label={`Preview ${safeFilename(item.file.name)}`} className="h-24 w-full rounded object-contain" />
  if (url && previewKind === "audio") return <audio controls preload="metadata" src={url} aria-label={`Preview ${safeFilename(item.file.name)}`} className="h-10 w-full" />
  return <div className="flex h-12 items-center justify-center text-muted-foreground"><FileIcon aria-hidden="true" className="size-7" /></div>
}

export function AttachmentComposer({ owner = "", disabled = false, maxFileBytes = MAX_FILE_BYTES, captureRef, pasteRef, composerRef, onStateChange, onSend, onSelectGif, extraActions, toolbarHint, toolbarVisible = true, toolbarId, children }: {
  owner?: string
  disabled?: boolean
  maxFileBytes?: number
  captureRef?: RefObject<HTMLDivElement | null>
  pasteRef?: RefObject<HTMLTextAreaElement | null>
  composerRef?: RefObject<AttachmentComposerHandle | null>
  onStateChange?: (state: AttachmentComposerState) => void
  onSend: (file: File, kind: AttachmentKind, onProgress?: AttachmentProgress, caption?: AttachmentCaption) => Promise<unknown>
  onSelectGif?: (url: string) => void
  extraActions?: ReactNode
  toolbarHint?: ReactNode
  toolbarVisible?: boolean
  toolbarId?: string
  children?: ReactNode
}) {
  const input = useRef<HTMLInputElement>(null)
  const localTarget = useRef<HTMLDivElement>(null)
  const queueRef = useRef<PendingFile[]>([])
  const nextFileId = useRef(0)
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const preparationId = useRef(0)
  const preparingRef = useRef(false)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const requestingRef = useRef(false)
  const recordingRef = useRef(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const discardRecording = useRef(false)
  const requestId = useRef(0)
  const [queue, setQueue] = useState<PendingFile[]>([])
  const selected = queue[0]
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [requesting, setRequesting] = useState(false)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [savingToBank, setSavingToBank] = useState(false)
  const [savedToBank, setSavedToBank] = useState<File | null>(null)
  const [autoCompact, setAutoCompact] = useAutoCompactFiles()

  function releaseMicrophone(expectedStream = stream.current) {
    expectedStream?.getTracks().forEach(track => track.stop())
    if (stream.current === expectedStream) stream.current = null
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestId.current++
      preparationId.current++
      discardRecording.current = true
      if (recorder.current?.state !== "inactive") recorder.current?.stop()
      recorder.current = null
      releaseMicrophone()
    }
  }, [])

  const getState = useCallback((): AttachmentComposerState => ({
    count: queueRef.current.length,
    unavailable: !mounted.current || disabledRef.current || busyRef.current || preparingRef.current || recordingRef.current || requestingRef.current,
  }), [])

  useEffect(() => {
    onStateChange?.(getState())
  }, [queue, busy, preparing, recording, requesting, disabled, getState, onStateChange])

  useEffect(() => {
    if (!recording) return
    const started = Date.now()
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000)
      setSeconds(elapsed)
      if (elapsed >= RECORDING_LIMIT_SECONDS && recorder.current?.state === "recording") recorder.current.stop()
    }, 250)
    return () => clearInterval(timer)
  }, [recording])

  const replaceQueue = useCallback((files: PendingFile[]) => {
    queueRef.current = files
    setQueue(files)
  }, [])

  const chooseFiles = useCallback(async (files: File[]) => {
    if (!files.length || getState().unavailable) return false
    const attempt = ++preparationId.current
    preparingRef.current = true
    setPreparing(true)
    setError("")
    try {
      if (queueRef.current.length + files.length > MAX_QUEUED_FILES) throw new Error(`You can queue up to ${MAX_QUEUED_FILES} files. Send or remove a file before adding more.`)
      const prepared: PendingFile[] = []
      for (const original of files) {
        validateAttachmentFile(original, autoCompact ? MAX_FILE_BYTES : maxFileBytes)
        const result = await compactAttachment(original, autoCompact)
        if (!mounted.current || preparationId.current !== attempt) return false
        validateAttachmentFile(result.file, maxFileBytes)
        prepared.push({ id: nextFileId.current++, file: result.file, kind: "file", ...(result.compacted ? { originalBytes: result.originalBytes } : {}) })
      }
      replaceQueue([...queueRef.current, ...prepared])
      setError("")
      pasteRef?.current?.focus()
      return true
    } catch (cause) {
      if (mounted.current && preparationId.current === attempt) setError(cause instanceof Error ? cause.message : "Unable to select this file.")
      return false
    } finally {
      if (preparationId.current === attempt) {
        preparingRef.current = false
        if (mounted.current) setPreparing(false)
      }
    }
  }, [getState, autoCompact, replaceQueue, maxFileBytes, pasteRef])

  useEffect(() => {
    const target = captureRef?.current || localTarget.current
    const pasteTarget = pasteRef?.current || localTarget.current
    if (!target || !pasteTarget) return
    return bindFileInputEvents(target, pasteTarget, {
      canAccept: () => !getState().unavailable,
      onFiles: files => { void chooseFiles(files) },
      onDragging: setDragging,
      onUnavailable: () => setError("Attachments are currently unavailable. Finish preparing, sending, or recording, then try again."),
    })
  }, [captureRef, pasteRef, getState, chooseFiles])

  useEffect(() => {
    if (disabled || busy || preparing || recording || requesting) setDragging(false)
  }, [disabled, busy, preparing, recording, requesting])

  async function startRecording() {
    if (getState().unavailable || queueRef.current.length) return
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Voice recording is not available in this browser. You can attach an audio file instead.")
      return
    }
    const attempt = ++requestId.current
    setError("")
    requestingRef.current = true
    setRequesting(true)
    discardRecording.current = false
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current || requestId.current !== attempt) { media.getTracks().forEach(track => track.stop()); return }
      stream.current = media
      const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"].find(type => MediaRecorder.isTypeSupported(type))
      const instance = new MediaRecorder(media, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 })
      recorder.current = instance
      const pieces: BlobPart[] = []
      let totalBytes = 0
      instance.ondataavailable = event => {
        if (requestId.current !== attempt || !mounted.current || discardRecording.current || !event.data.size) return
        totalBytes += event.data.size
        if (totalBytes > maxFileBytes) {
          discardRecording.current = true
          if (mounted.current) setError(`The recording reached ${formatFileSize(maxFileBytes)}. Please record a shorter message.`)
          if (instance.state === "recording") instance.stop()
          return
        }
        pieces.push(event.data)
        if (totalBytes > maxFileBytes - 64 * 1024 && instance.state === "recording") instance.stop()
      }
      instance.onerror = () => {
        releaseMicrophone(media)
        if (requestId.current !== attempt) return
        discardRecording.current = true
        recordingRef.current = false
        if (mounted.current) { setRecording(false); setError("Recording failed. Please try again.") }
      }
      instance.onstop = () => {
        releaseMicrophone(media)
        if (recorder.current === instance) recorder.current = null
        if (!mounted.current || requestId.current !== attempt) return
        recordingRef.current = false
        setRecording(false)
        if (discardRecording.current) return
        if (!totalBytes) { setError("No audio was recorded. Please try again."); return }
        const type = instance.mimeType || "audio/webm"
        const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"
        const file = new File(pieces, `voice-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type })
        replaceQueue([{ id: nextFileId.current++, file, kind: "voice" }])
        pasteRef?.current?.focus()
      }
      instance.start(500)
      setSeconds(0)
      recordingRef.current = true
      setRecording(true)
    } catch (cause) {
      releaseMicrophone()
      if (mounted.current && requestId.current === attempt) setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser settings, or attach an audio file." : "Unable to access your microphone.")
    } finally {
      if (mounted.current && requestId.current === attempt) {
        requestingRef.current = false
        setRequesting(false)
      }
    }
  }

  function cancelRecording() {
    requestId.current++
    discardRecording.current = true
    if (recorder.current?.state === "recording") recorder.current.stop()
    releaseMicrophone()
    requestingRef.current = false
    recordingRef.current = false
    setRequesting(false)
    setRecording(false)
  }

  const sendAll = useCallback(async (caption: AttachmentCaption, onFirstSent: () => void) => {
    if (getState().unavailable || !queueRef.current.length) return
    const files = [...queueRef.current]
    busyRef.current = true
    setBusy(true)
    setProgress(0)
    setError("")
    try {
      for (const [index, item] of files.entries()) {
        if (!mounted.current) break
        setProgress(0)
        validateAttachmentFile(item.file, maxFileBytes)
        await onSend(item.file, item.kind, percent => { if (mounted.current) setProgress(percent) }, index === 0 ? caption : undefined)
        queueRef.current = queueRef.current.filter(pending => pending !== item)
        if (mounted.current) setQueue(queueRef.current)
        if (index === 0) onFirstSent()
        if (!mounted.current) break
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to send this file. Please try again.")
      throw cause
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }, [getState, maxFileBytes, onSend])

  useImperativeHandle(composerRef, () => ({ getState, sendAll }), [getState, sendAll])

  async function saveSelectedToBank() {
    if (!owner || !selected || savingToBank) return
    setSavingToBank(true); setError("")
    try {
      await saveBankFiles(owner, [selected.file])
      if (mounted.current) setSavedToBank(selected.file)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to save this file to your bank.")
    } finally { if (mounted.current) setSavingToBank(false) }
  }

  const unavailable = disabled || busy || preparing || recording || requesting
  return <div ref={localTarget} className={`flex min-w-0 flex-col gap-2 rounded-lg ${dragging ? "bg-accent ring-2 ring-primary" : ""}`}>
    <input ref={input} type="file" multiple className="hidden" aria-label="Choose attachments" disabled={unavailable} onChange={event => { void chooseFiles(Array.from(event.target.files || [])); event.target.value = "" }} />
    {preparing && <p role="status" className="text-xs text-muted-foreground">Preparing attachments…</p>}
    {dragging && <p role="status" className="text-sm font-medium">Drop files to preview before sending</p>}
    {(requesting || recording) && <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
      <p role="status" className="mr-auto text-sm">{requesting ? "Waiting for microphone permission…" : `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</p>
      {recording && <Button type="button" size="sm" variant="outline" onClick={() => { if (recorder.current?.state === "recording") recorder.current.stop() }}><Square aria-hidden="true" />Stop & preview</Button>}
      <Button type="button" size="sm" variant="ghost" onClick={cancelRecording}><X aria-hidden="true" />Cancel</Button>
    </div>}
    {!!queue.length && <div className="space-y-2">
      <ul aria-label="Pending attachments" className="flex max-h-64 gap-2 overflow-auto pb-1">
        {queue.map(item => <li key={item.id} className="relative w-40 shrink-0 space-y-1 rounded-lg border border-border bg-muted/40 p-2">
          <Button type="button" variant="secondary" size="icon" className="absolute right-1 top-1 z-10 size-6 rounded-full" disabled={unavailable} aria-label={`Remove ${safeFilename(item.file.name)}`} onClick={() => {
            if (getState().unavailable) return
            replaceQueue(queueRef.current.filter(pending => pending !== item)); setError(""); pasteRef?.current?.focus()
          }}><X aria-hidden="true" className="size-3" /></Button>
          <AttachmentPreview item={item} />
          <p className="truncate text-xs font-medium" title={safeFilename(item.file.name)}>{item.kind === "voice" ? "Voice message" : safeFilename(item.file.name)}</p>
          <p className="text-xs text-muted-foreground">{formatFileSize(item.file.size)}</p>
          {item.originalBytes !== undefined && <p className="text-xs text-muted-foreground">Compacted from {formatFileSize(item.originalBytes)} · extract .gz to open</p>}
        </li>)}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <p role="status" className="text-xs text-muted-foreground">{queue.length} {queue.length === 1 ? "attachment" : "attachments"} ready · add text or send as is</p>
        {owner && selected && <Button type="button" size="sm" variant="ghost" disabled={savingToBank || savedToBank === selected.file} onClick={() => void saveSelectedToBank()}><FolderPlus aria-hidden="true" />{savingToBank ? "Saving…" : savedToBank === selected.file ? "Saved to bank" : "Save to bank"}</Button>}
      </div>
    </div>}
    {busy && <div role="status" className="text-xs"><span>Sending attachments · {progress}%</span><progress className="h-1 w-full" value={progress} max={100} aria-label="File prepared for sending" /></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {children}
    <div id={toolbarId} className={`${toolbarVisible ? "flex" : "hidden"} flex-wrap items-center gap-1`}>
      <Button type="button" variant="ghost" size="icon" aria-label="Attach files" title="Attach files" disabled={unavailable} onClick={() => input.current?.click()}><Paperclip aria-hidden="true" className="size-4" /></Button>
      {onSelectGif && <GifPicker disabled={unavailable} onSelectGif={onSelectGif} />}
      {owner && <FileBankPicker owner={owner} disabled={unavailable} onSelectFile={async file => { if (!await chooseFiles([file])) throw new Error("Unable to queue this file. Send or remove a queued file, then try again.") }} />}
      <Button type="button" variant="ghost" size="icon" aria-label="Record voice message" title="Record voice message" disabled={unavailable || queue.length > 0} onClick={() => void startRecording()}><Mic aria-hidden="true" className="size-4" /></Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Attachment settings" title="Attachment settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}><Settings2 aria-hidden="true" className="size-4" /></Button>
      {extraActions}
      {!!queue.length && <span className="ml-1 text-xs text-muted-foreground">{queue.length} queued</span>}
      {toolbarHint && <div className="ml-auto text-xs text-muted-foreground">{toolbarHint}</div>}
    </div>
    <div className={settingsOpen && toolbarVisible ? "space-y-2 rounded-lg border border-border bg-card p-3" : "hidden"}>
      <p className="text-xs text-muted-foreground">Files up to {formatFileSize(maxFileBytes)} each{maxFileBytes < MAX_FILE_BYTES ? " in this group" : ""}. You can also drop files into the chat or paste them into the message box.</p>
      {maxFileBytes < MAX_FILE_BYTES && <p className="text-xs text-muted-foreground">Larger groups have a smaller limit because files are sent separately to each member. Direct chats support {formatFileSize(MAX_FILE_BYTES)}.</p>}
      <AutoCompactFilesSetting enabled={autoCompact} onChange={setAutoCompact} disabled={unavailable} />
    </div>
  </div>
}
