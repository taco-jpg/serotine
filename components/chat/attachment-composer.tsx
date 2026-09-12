"use client"

import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import { Mic, Paperclip, Send, Settings2, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MAX_FILE_BYTES, attachmentPreviewKind, formatFileSize, safeFilename, validateAttachmentFile, type AttachmentKind, type AttachmentProgress } from "@/lib/attachments"
import { bindFileInputEvents } from "./file-input-events"
import { compactAttachment } from "@/lib/compact-attachment"
import { AutoCompactFilesSetting, useAutoCompactFiles } from "./use-auto-compact-files"

const RECORDING_LIMIT_SECONDS = 300
const MAX_QUEUED_FILES = 8
type PendingFile = { file: File; kind: AttachmentKind; originalBytes?: number }

export function AttachmentComposer({ disabled = false, captureRef, pasteRef, onSend }: {
  disabled?: boolean
  captureRef?: RefObject<HTMLDivElement | null>
  pasteRef?: RefObject<HTMLTextAreaElement | null>
  onSend: (file: File, kind: AttachmentKind, onProgress?: AttachmentProgress) => Promise<unknown>
}) {
  const input = useRef<HTMLInputElement>(null)
  const localTarget = useRef<HTMLDivElement>(null)
  const queueRef = useRef<PendingFile[]>([])
  const preparationId = useRef(0)
  const preparingRef = useRef(false)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const discardRecording = useRef(false)
  const requestId = useRef(0)
  const [queue, setQueue] = useState<PendingFile[]>([])
  const selected = queue[0]
  const [previewUrl, setPreviewUrl] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [requesting, setRequesting] = useState(false)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
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

  useEffect(() => {
    if (!selected || !attachmentPreviewKind(selected.file.type.split(";")[0])) return
    const url = URL.createObjectURL(selected.file)
    setPreviewUrl(url)
    return () => { URL.revokeObjectURL(url); setPreviewUrl("") }
  }, [selected])

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
    if (!files.length || disabled || busyRef.current || preparingRef.current || recording || requesting) return
    const attempt = ++preparationId.current
    preparingRef.current = true
    setPreparing(true)
    setError("")
    try {
      if (queueRef.current.length + files.length > MAX_QUEUED_FILES) throw new Error(`You can queue up to ${MAX_QUEUED_FILES} files. Send or remove a file before adding more.`)
      const prepared: PendingFile[] = []
      for (const original of files) {
        const result = await compactAttachment(original, autoCompact)
        if (!mounted.current || preparationId.current !== attempt) return
        validateAttachmentFile(result.file)
        prepared.push({ file: result.file, kind: "file", ...(result.compacted ? { originalBytes: result.originalBytes } : {}) })
      }
      replaceQueue([...queueRef.current, ...prepared])
      setError("")
    } catch (cause) {
      if (mounted.current && preparationId.current === attempt) setError(cause instanceof Error ? cause.message : "Unable to select this file.")
    } finally {
      if (preparationId.current === attempt) {
        preparingRef.current = false
        if (mounted.current) setPreparing(false)
      }
    }
  }, [disabled, recording, requesting, autoCompact, replaceQueue])

  useEffect(() => {
    const target = captureRef?.current || localTarget.current
    const pasteTarget = pasteRef?.current || localTarget.current
    if (!target || !pasteTarget) return
    return bindFileInputEvents(target, pasteTarget, {
      canAccept: () => !disabled && !busyRef.current && !preparingRef.current && !recording && !requesting,
      onFiles: files => { void chooseFiles(files) },
      onDragging: setDragging,
      onUnavailable: () => setError("Attachments are currently unavailable. Finish preparing, sending, or recording, then try again."),
    })
  }, [captureRef, pasteRef, disabled, recording, requesting, chooseFiles])

  useEffect(() => {
    if (disabled || busy || preparing || recording || requesting) setDragging(false)
  }, [disabled, busy, preparing, recording, requesting])

  async function startRecording() {
    if (disabled || busyRef.current || preparingRef.current || recording || requesting || queueRef.current.length) return
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Voice recording is not available in this browser. You can attach an audio file instead.")
      return
    }
    const attempt = ++requestId.current
    setError("")
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
        if (totalBytes > MAX_FILE_BYTES) {
          discardRecording.current = true
          if (mounted.current) setError(`The recording reached ${formatFileSize(MAX_FILE_BYTES)}. Please record a shorter message.`)
          if (instance.state === "recording") instance.stop()
          return
        }
        pieces.push(event.data)
        if (totalBytes > MAX_FILE_BYTES - 64 * 1024 && instance.state === "recording") instance.stop()
      }
      instance.onerror = () => {
        releaseMicrophone(media)
        if (requestId.current !== attempt) return
        discardRecording.current = true
        if (mounted.current) { setRecording(false); setError("Recording failed. Please try again.") }
      }
      instance.onstop = () => {
        releaseMicrophone(media)
        if (recorder.current === instance) recorder.current = null
        if (!mounted.current || requestId.current !== attempt) return
        setRecording(false)
        if (discardRecording.current) return
        if (!totalBytes) { setError("No audio was recorded. Please try again."); return }
        const type = instance.mimeType || "audio/webm"
        const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"
        const file = new File(pieces, `voice-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`, { type })
        replaceQueue([{ file, kind: "voice" }])
      }
      instance.start(500)
      setSeconds(0)
      setRecording(true)
    } catch (cause) {
      releaseMicrophone()
      if (mounted.current && requestId.current === attempt) setError(cause instanceof DOMException && cause.name === "NotAllowedError" ? "Microphone access was denied. Allow it in your browser settings, or attach an audio file." : "Unable to access your microphone.")
    } finally { if (mounted.current && requestId.current === attempt) setRequesting(false) }
  }

  function cancelRecording() {
    requestId.current++
    discardRecording.current = true
    if (recorder.current?.state === "recording") recorder.current.stop()
    releaseMicrophone()
    setRequesting(false)
    setRecording(false)
  }

  async function sendSelected() {
    if (!selected || disabled || busyRef.current || preparingRef.current) return
    busyRef.current = true
    setBusy(true)
    setProgress(0)
    setError("")
    try {
      await onSend(selected.file, selected.kind, percent => { if (mounted.current) setProgress(percent) })
      if (mounted.current) replaceQueue(queueRef.current.filter(item => item !== selected))
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to send this file. Please try again.")
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  const unavailable = disabled || busy || preparing || recording || requesting
  return <div ref={localTarget} className={`min-w-0 space-y-2 rounded-lg p-1 ${dragging ? "bg-accent ring-2 ring-primary" : ""}`}>
    <input ref={input} type="file" multiple className="hidden" aria-label="Choose attachments" disabled={unavailable} onChange={event => { void chooseFiles(Array.from(event.target.files || [])); event.target.value = "" }} />
    <div className="flex flex-wrap items-center gap-1">
      <Button type="button" variant="ghost" size="icon" aria-label="Attach files" title="Attach files" disabled={unavailable} onClick={() => input.current?.click()}><Paperclip aria-hidden="true" className="size-4" /></Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Record voice message" title="Record voice message" disabled={unavailable || queue.length > 0} onClick={() => void startRecording()}><Mic aria-hidden="true" className="size-4" /></Button>
      <Button type="button" variant="ghost" size="icon" aria-label="Attachment settings" title="Attachment settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}><Settings2 aria-hidden="true" className="size-4" /></Button>
      {!!queue.length && <span className="ml-1 text-xs text-muted-foreground">{queue.length} queued</span>}
    </div>
    <div className={settingsOpen ? "space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3" : "sr-only"}>
      <p className="text-xs text-muted-foreground">Files up to {formatFileSize(MAX_FILE_BYTES)} each. You can also drop files into the chat or paste them into the message box.</p>
      <AutoCompactFilesSetting enabled={autoCompact} onChange={setAutoCompact} disabled={unavailable} />
    </div>
    {preparing && <p role="status" className="text-xs text-muted-foreground">Preparing attachments…</p>}
    {dragging && <p role="status" className="text-sm font-medium">Drop files to preview before sending</p>}
    {(requesting || recording) && <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
      <p role="status" className="mr-auto text-sm">{requesting ? "Waiting for microphone permission…" : `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</p>
      {recording && <Button type="button" size="sm" variant="outline" onClick={() => { if (recorder.current?.state === "recording") recorder.current.stop() }}><Square aria-hidden="true" />Stop & preview</Button>}
      <Button type="button" size="sm" variant="ghost" onClick={cancelRecording}><X aria-hidden="true" />Cancel</Button>
    </div>}
    {selected && <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
      {queue.length > 1 && <p role="status" className="text-xs text-muted-foreground">{queue.length} files queued · send them one at a time</p>}
      <p className="break-all text-sm font-medium">{selected.kind === "voice" ? "Voice message" : safeFilename(selected.file.name)} <span className="font-normal text-muted-foreground">· {formatFileSize(selected.file.size)}</span></p>
      {selected.originalBytes !== undefined && <p className="text-xs text-muted-foreground">Compacted from {formatFileSize(selected.originalBytes)} · recipients can extract the .gz file</p>}
      {previewUrl && attachmentPreviewKind(selected.file.type.split(";")[0]) === "image" && <img src={previewUrl} alt="Attachment preview" className="max-h-32 rounded-md object-contain" />}
      {previewUrl && attachmentPreviewKind(selected.file.type.split(";")[0]) === "audio" && <audio controls preload="metadata" src={previewUrl} aria-label="Preview voice or audio attachment" className="max-w-full" />}
      {busy && <div role="status" className="text-xs"><span>Preparing to send · {progress}%</span><progress className="h-1 w-full" value={progress} max={100} aria-label="File prepared for sending" /></div>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy || preparing || disabled} onClick={() => void sendSelected()}><Send aria-hidden="true" />{busy ? "Preparing…" : selected.kind === "voice" ? "Send voice message" : "Send file"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy || preparing} onClick={() => { replaceQueue(queueRef.current.filter(item => item !== selected)); setError("") }}><X aria-hidden="true" />Remove</Button>
      </div>
      {queue.length > 1 && <ul className="space-y-1 border-t pt-2">{queue.slice(1).map((item, index) => <li key={index} className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate">{safeFilename(item.file.name)} · {formatFileSize(item.file.size)}</span><Button type="button" variant="ghost" size="sm" disabled={busy || preparing} aria-label={`Remove ${safeFilename(item.file.name)}`} onClick={() => replaceQueue(queueRef.current.filter(pending => pending !== item))}><X aria-hidden="true" /></Button></li>)}</ul>}
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}
