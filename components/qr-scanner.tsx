"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { Camera, QrCode, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { parseContactCode } from "@/lib/contact-code"

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_IMAGE_SIDE = 1600

function pixels(source: CanvasImageSource, width: number, height: number) {
  if (!width || !height) throw new Error("The image could not be read.")
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(width, height))
  const canvas = document.createElement("canvas")
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new Error("Image scanning is unavailable in this browser.")
  context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return context.getImageData(0, 0, canvas.width, canvas.height)
}

function cameraError(cause: unknown) {
  const name = cause instanceof Error ? cause.name : ""
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access was blocked. Allow camera access or upload a QR image."
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "No camera was found. Upload a QR image instead."
  return "The camera could not start. Try again or upload a QR image."
}

export function QrScanner({ onScan, disabled = false }: { onScan: (value: string) => void | Promise<void>; disabled?: boolean }) {
  const id = useId()
  const [expanded, setExpanded] = useState(false)
  const [camera, setCamera] = useState<"idle" | "starting" | "live">("idle")
  const [reading, setReading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const video = useRef<HTMLVideoElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generation = useRef(0)
  const mounted = useRef(false)
  const stop = useCallback(() => {
    generation.current++
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    stream.current?.getTracks().forEach(track => track.stop())
    stream.current = null
    if (video.current) video.current.srcObject = null
  }, [])
  useEffect(() => {
    mounted.current = true
    const pause = () => {
      if (document.visibilityState === "hidden") { stop(); setCamera("idle"); setReading(false) }
    }
    document.addEventListener("visibilitychange", pause)
    return () => { mounted.current = false; stop(); document.removeEventListener("visibilitychange", pause) }
  }, [stop])
  useEffect(() => {
    if (disabled) { stop(); setCamera("idle"); setReading(false); setExpanded(false) }
  }, [disabled, stop])
  const active = (ticket: number) => mounted.current && generation.current === ticket
  const accept = async (data: string, ticket: number) => {
    const address = await parseContactCode(data)
    if (!active(ticket)) return
    await onScan(address)
    if (!active(ticket)) return
    stop(); setCamera("idle"); setReading(false); setExpanded(false); setError(null)
    setStatus("QR code read. Review the address, then choose Add.")
  }

  const startCamera = async () => {
    stop(); const ticket = generation.current
    setError(null); setStatus(null); setCamera("starting")
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCamera("idle"); setError("Camera scanning needs HTTPS and a supported browser. You can upload a QR image instead."); return
    }
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } } })
      if (!active(ticket)) { acquired.getTracks().forEach(track => track.stop()); return }
      stream.current = acquired
      const element = video.current
      if (!element) { stop(); setCamera("idle"); return }
      element.srcObject = acquired
      await element.play()
      if (!active(ticket)) return
      const { default: decode } = await import("jsqr")
      if (!active(ticket)) return
      setCamera("live")
      const scan = async () => {
        if (!active(ticket)) return
        try {
          if (element.readyState >= 2 && element.videoWidth) {
            const frame = pixels(element, element.videoWidth, element.videoHeight)
            const result = decode(frame.data, frame.width, frame.height, { inversionAttempts: "attemptBoth" })
            if (result) { await accept(result.data, ticket); return }
          }
          if (active(ticket)) timer.current = setTimeout(() => void scan(), 250)
        } catch (cause) {
          if (active(ticket)) { stop(); setCamera("idle"); setError(cause instanceof Error ? cause.message : "This QR code could not be read.") }
        }
      }
      void scan()
    } catch (cause) {
      if (active(ticket)) { stop(); setCamera("idle"); setError(cameraError(cause)) }
    }
  }

  const readImage = async (file: File) => {
    stop(); const ticket = generation.current
    setCamera("idle"); setReading(true); setError(null); setStatus(null)
    let url: string | null = null
    try {
      if (file.size > MAX_IMAGE_BYTES) throw new Error("Choose a QR image no larger than 10 MiB.")
      if (!/^image\/(png|jpeg|webp|gif|bmp)$/i.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP, GIF, or BMP QR image.")
      const element = new Image()
      url = URL.createObjectURL(file)
      element.src = url
      await element.decode()
      if (!active(ticket)) return
      const { default: decode } = await import("jsqr")
      if (!active(ticket)) return
      const frame = pixels(element, element.naturalWidth, element.naturalHeight)
      const result = decode(frame.data, frame.width, frame.height, { inversionAttempts: "attemptBoth" })
      if (!result) throw new Error("No QR code was found. Use a clear image showing the whole code.")
      await accept(result.data, ticket)
    } catch (cause) {
      if (active(ticket)) setError(cause instanceof Error && cause.name !== "EncodingError" ? cause.message : "The image could not be read. Try another QR image.")
    } finally {
      if (url) URL.revokeObjectURL(url)
      if (active(ticket)) setReading(false)
    }
  }

  const cancel = () => { stop(); setCamera("idle"); setReading(false); setExpanded(false); setError(null); setStatus(null) }
  return <div className="min-w-0 space-y-2">
    {!expanded ? <Button type="button" size="sm" variant="outline" disabled={disabled} aria-expanded={false} aria-controls={`${id}-scanner`} onClick={() => { setExpanded(true); setError(null); setStatus(null) }}><QrCode className="size-4" />Scan QR code</Button>
      : <div id={`${id}-scanner`} className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">Scan a Serotine contact QR code with your camera or choose an image. Images are read on this device.</p>
        <video ref={video} playsInline muted aria-label="QR camera preview" className={camera === "idle" ? "hidden" : "aspect-video w-full rounded-md bg-black object-cover"} />
        <div className="flex flex-wrap gap-2">
          {camera === "idle" ? <Button type="button" size="sm" variant="outline" disabled={disabled || reading} onClick={() => void startCamera()}><Camera className="size-4" />Use camera</Button>
            : <Button type="button" size="sm" variant="outline" onClick={() => { stop(); setCamera("idle") }}>Stop camera</Button>}
          <Button type="button" size="sm" variant="outline" disabled={disabled || reading} onClick={() => fileInput.current?.click()}><Upload className="size-4" />Upload QR image</Button>
          <Button type="button" size="sm" variant="ghost" onClick={cancel}>Cancel scan</Button>
        </div>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" aria-label="QR image" className="sr-only" tabIndex={-1} disabled={disabled || reading} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void readImage(file) }} />
        {(camera !== "idle" || reading) && <p role="status" className="text-xs text-muted-foreground">{reading ? "Reading QR image…" : camera === "starting" ? "Starting camera…" : "Point the camera at the whole QR code."}</p>}
      </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {status && <p role="status" className="text-xs text-primary">{status}</p>}
  </div>
}
