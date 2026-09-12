"use client"

import { useEffect, useRef, useState } from "react"
import { Mic, Paperclip, Send, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MAX_FILE_BYTES, attachmentPreviewKind, formatFileSize, safeFilename, validateAttachmentFile, type AttachmentKind, type AttachmentProgress } from "@/lib/attachments"

const RECORDING_LIMIT_SECONDS = 300

export function AttachmentComposer({ disabled = false, onSend }: {
  disabled?: boolean
  onSend: (file: File, kind: AttachmentKind, onProgress?: AttachmentProgress) => Promise<unknown>
}) {
  const input = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const busyRef = useRef(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const discardRecording = useRef(false)
  const requestId = useRef(0)
  const [selected, setSelected] = useState<{ file: File; kind: AttachmentKind } | null>(null)
  const [previewUrl, setPreviewUrl] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(0)
  const [requesting, setRequesting] = useState(false)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [dragging, setDragging] = useState(false)

  function releaseMicrophone(expectedStream = stream.current) {
    expectedStream?.getTracks().forEach(track => track.stop())
    if (stream.current === expectedStream) stream.current = null
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      requestId.current++
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

  function chooseFile(file?: File) {
    if (!file || disabled || busyRef.current || recording || requesting) return
    try {
      validateAttachmentFile(file)
      setSelected({ file, kind: "file" })
      setError("")
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to select this file.") }
  }

  async function startRecording() {
    if (disabled || busyRef.current || recording || requesting) return
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
          if (mounted.current) setError("The recording reached 2 MB. Please record a shorter message.")
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
        setSelected({ file, kind: "voice" })
      }
      instance.start(500)
      setSelected(null)
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
    if (!selected || disabled || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setProgress(0)
    setError("")
    try {
      await onSend(selected.file, selected.kind, percent => { if (mounted.current) setProgress(percent) })
      if (mounted.current) setSelected(null)
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Unable to send this file. Please try again.")
    } finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }

  const unavailable = disabled || busy || recording || requesting
  return <div className={`min-w-0 space-y-2 rounded-lg p-1 ${dragging ? "bg-accent ring-2 ring-primary" : ""}`}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); setDragging(!unavailable) } }}
    onDragLeave={() => setDragging(false)}
    onDrop={event => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]) }}
    onPaste={event => { const file = event.clipboardData.files[0]; if (file) { event.preventDefault(); chooseFile(file) } }}>
    <input ref={input} type="file" className="hidden" aria-label="Choose an attachment" disabled={unavailable} onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = "" }} />
    <div className="flex flex-wrap items-center gap-1">
      <Button type="button" variant="ghost" size="sm" disabled={unavailable} onClick={() => input.current?.click()}><Paperclip aria-hidden="true" />Attach</Button>
      <Button type="button" variant="ghost" size="sm" disabled={unavailable} onClick={() => void startRecording()}><Mic aria-hidden="true" />Voice</Button>
      <span className="text-xs text-muted-foreground">Up to 2 MB · drop or paste a file here</span>
    </div>
    {(requesting || recording) && <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
      <p role="status" className="mr-auto text-sm">{requesting ? "Waiting for microphone permission…" : `Recording ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</p>
      {recording && <Button type="button" size="sm" variant="outline" onClick={() => { if (recorder.current?.state === "recording") recorder.current.stop() }}><Square aria-hidden="true" />Stop & preview</Button>}
      <Button type="button" size="sm" variant="ghost" onClick={cancelRecording}><X aria-hidden="true" />Cancel</Button>
    </div>}
    {selected && <div className="space-y-2 rounded-lg border bg-muted/40 p-3">
      <p className="break-all text-sm font-medium">{selected.kind === "voice" ? "Voice message" : safeFilename(selected.file.name)} <span className="font-normal text-muted-foreground">· {formatFileSize(selected.file.size)}</span></p>
      {previewUrl && attachmentPreviewKind(selected.file.type.split(";")[0]) === "image" && <img src={previewUrl} alt="Attachment preview" className="max-h-32 rounded-md object-contain" />}
      {previewUrl && attachmentPreviewKind(selected.file.type.split(";")[0]) === "audio" && <audio controls preload="metadata" src={previewUrl} aria-label="Preview voice or audio attachment" className="max-w-full" />}
      {busy && <div role="status" className="text-xs"><span>Preparing to send · {progress}%</span><progress className="h-1 w-full" value={progress} max={100} aria-label="File prepared for sending" /></div>}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || disabled} onClick={() => void sendSelected()}><Send aria-hidden="true" />{busy ? "Preparing…" : selected.kind === "voice" ? "Send voice message" : "Send file"}</Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setSelected(null); setError("") }}><X aria-hidden="true" />Cancel</Button>
      </div>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}
