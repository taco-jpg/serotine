"use client"

import Link from "next/link"
import { ConnectionDetails } from "./connection-details"
import { useEffect, useRef, useState } from "react"
import { Camera, Expand, Loader2, Mic, MicOff, Phone, PhoneOff, RotateCw, Settings2, Shield, Video, VideoOff, Volume2, X } from "lucide-react"
import { useCalling } from "@/components/calling-provider"
import { useMessaging } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import type { CallPhase } from "@/lib/call-types"
import { CallRinger, type CallSoundStatus } from "@/lib/call-ringer"

const labels: Record<CallPhase, string> = { idle: "Ready", preparing: "Preparing devices", preview: "Ready to connect", incoming: "Incoming call", ringing: "Calling · Waiting for answer", connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting", ended: "Call ended", declined: "Call declined", unanswered: "No answer", busy: "Busy", failed: "Call failed" }
const terminal = (phase: CallPhase) => ["idle", "ended", "declined", "unanswered", "busy", "failed"].includes(phase)

function durationLabel(started: number | null, now: number) {
  if (!started) return "0:00"
  const seconds = Math.max(0, Math.floor((now - started) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`
}

function StreamVideo({ stream, label, mirror = false }: { stream: MediaStream | null; label: string; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.srcObject = stream
    if (stream) void node.play().catch(() => undefined)
    return () => { node.srcObject = null }
  }, [stream])
  return <figure className="relative min-w-0 overflow-hidden rounded-md border border-border bg-muted">
    <video ref={ref} autoPlay muted playsInline aria-label={label} className={`aspect-video w-full object-contain ${mirror ? "-scale-x-100" : ""}`} />
    <figcaption className="border-t border-border bg-card px-3 py-2 text-xs text-muted-foreground">{label}</figcaption>
  </figure>
}

function DeviceControls() {
  const { engine, snapshot, run } = useCalling()
  if (!engine || !snapshot) return null
  const microphones = snapshot.devices.filter(device => device.kind === "audioinput")
  const cameras = snapshot.devices.filter(device => device.kind === "videoinput")
  const editable = ["preview", "connecting", "connected", "reconnecting"].includes(snapshot.phase)
  return <div className="space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="min-h-11" disabled={!editable} aria-label={snapshot.microphoneMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={snapshot.microphoneMuted} onClick={() => engine.toggleMicrophone()}>{snapshot.microphoneMuted ? <MicOff /> : <Mic />}{snapshot.microphoneMuted ? "Mic muted" : "Mic on"}</Button>
      <Button type="button" variant="outline" className="min-h-11" disabled={!editable} aria-label={snapshot.cameraEnabled ? "Turn camera off" : "Turn camera on"} aria-pressed={snapshot.cameraEnabled} onClick={() => void run(() => engine.toggleCamera())}>{snapshot.cameraEnabled ? <Video /> : <VideoOff />}{snapshot.cameraEnabled ? "Camera on" : "Camera off"}</Button>
      {snapshot.cameraEnabled && <Button type="button" variant="outline" className="min-h-11" disabled={!editable} onClick={() => void run(() => engine.switchCamera())}><Camera />Switch camera</Button>}
    </div>
    {microphones.length > 0 && <div className="space-y-1"><Label htmlFor="call-microphone">Microphone</Label><select id="call-microphone" value={snapshot.microphoneId} disabled={!editable} onChange={event => void run(() => engine.selectMicrophone(event.target.value))} className="min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm"><option value="">System default</option>{microphones.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>}
    {cameras.length > 0 && snapshot.cameraEnabled && <div className="space-y-1"><Label htmlFor="call-camera">Camera</Label><select id="call-camera" value={snapshot.cameraId} disabled={!editable} onChange={event => void run(() => engine.selectCamera(event.target.value))} className="min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm"><option value="">System default</option>{cameras.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div>}
  </div>
}

function CallSettingsDialog() {
  const { engine, snapshot, settingsOpen, setSettingsOpen, error } = useCalling()
  if (!engine || !snapshot) return null
  return <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>Call privacy and notifications</DialogTitle><DialogDescription>These preferences apply to this identity on this browser.</DialogDescription></DialogHeader>
      <label className="flex min-h-11 cursor-pointer items-start gap-3"><input type="checkbox" className="mt-1 size-5 shrink-0 accent-primary" checked={snapshot.settings.silenceIncoming} onChange={event => engine.updateSettings({ silenceIncoming: event.target.checked })} /><span><span className="block text-sm font-medium">Silence all incoming calls</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Messaging stays on. Muted and archived conversations also stay silent.</span></span></label>
      <p className="border-t border-border pt-4 text-sm text-muted-foreground">Calls prefer a direct connection and use Cloudflare TURN when needed. Your network address may be visible to the other participants. Audio and video stay encrypted between your devices.</p>
      <p className="text-sm text-muted-foreground">Cloudflare relays encrypted WebRTC packets when a direct route is unavailable. Audio and video never pass through Serotine’s signaling server.</p>
      <div className="space-y-2 border-t border-border pt-4 text-xs leading-5 text-muted-foreground"><p>Both people need Serotine open and running. A closed or suspended browser may miss calls, and switching apps on a phone can interrupt them.</p><p>Serotine does not record calls. The other participant can still record externally. The signaling service can see connection timing and who is calling, but does not carry call audio or video.</p></div>
      <ConnectionDetails connection={snapshot.connection} />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" className="min-h-11" onClick={() => setSettingsOpen(false)}>Done</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

export function CallingSurface() {
  const { engine, snapshot, roomSnapshot, error: sharedError, clearError, run, setSettingsOpen } = useCalling()
  const profiles = useMessaging()
  const peerLabel = profiles.contacts.find(contact => contact.pub === snapshot?.peer)?.alias || profiles.getProfile(snapshot?.peer || "").displayName || snapshot?.peerLabel || "Contact"
  const error = roomSnapshot && roomSnapshot.phase !== "idle" ? null : sharedError
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(0)
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [soundStatus, setSoundStatus] = useState<CallSoundStatus>("blocked")
  const audio = useRef<HTMLAudioElement>(null)
  const ringer = useRef<CallRinger | null>(null)
  useEffect(() => {
    if (!engine) return
    const next = new CallRinger({ onStatusChange: setSoundStatus })
    ringer.current = next
    setSoundStatus(next.getStatus())
    const sync = () => next.setCall(engine.getSnapshot())
    const unsubscribe = engine.subscribe(sync)
    const dispose = () => next.dispose()
    sync()
    // Unlock on ordinary page interactions, without prompting for media access.
    window.addEventListener("click", next.unlock, true)
    window.addEventListener("keydown", next.unlock, true)
    window.addEventListener("pagehide", dispose)
    window.addEventListener("serotine:identity-changing", dispose)
    return () => {
      unsubscribe(); next.dispose()
      if (ringer.current === next) ringer.current = null
      window.removeEventListener("click", next.unlock, true)
      window.removeEventListener("keydown", next.unlock, true)
      window.removeEventListener("pagehide", dispose)
      window.removeEventListener("serotine:identity-changing", dispose)
    }
  }, [engine])
  useEffect(() => {
    if (!snapshot?.connectedAt || terminal(snapshot.phase)) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [snapshot?.connectedAt, snapshot?.phase])
  useEffect(() => {
    const node = audio.current
    if (!node) return
    node.srcObject = snapshot?.remoteStream ?? null
    setAudioBlocked(false)
    if (snapshot?.remoteStream) void node.play().catch(() => setAudioBlocked(true))
    return () => { node.srcObject = null }
  }, [snapshot?.remoteStream])
  useEffect(() => { if (!snapshot || terminal(snapshot.phase)) setExpanded(false) }, [snapshot?.phase])
  if (!engine || !snapshot) return null
  const hasCall = snapshot.phase !== "idle"
  const finished = terminal(snapshot.phase)
  const preflight = ["preparing", "preview"].includes(snapshot.phase)
  const active = ["connecting", "connected", "reconnecting"].includes(snapshot.phase)
  const duration = durationLabel(snapshot.connectedAt, now)
  const busy = snapshot.phase === "preparing"
  const retry = () => { if (snapshot.peer) void run(() => engine.prepareOutgoing(snapshot.peer!, snapshot.mode)) }

  return <>
    <audio ref={audio} autoPlay aria-label="Remote call audio" />
    {(hasCall || error) && <section aria-label="Current call" className="border-b border-border bg-card px-2 py-1.5 text-card-foreground shadow-sm sm:px-4">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1">
        {hasCall && <div className="min-w-0 flex-1 basis-36">
          <p className="flex min-w-0 items-center gap-2 text-sm font-medium">{snapshot.mode === "video" ? <Video className="size-4 shrink-0" /> : <Phone className="size-4 shrink-0" />}<Link className="truncate hover:underline" href={`/chat/${snapshot.peer}`}>{peerLabel}</Link></p>
          <p role="status" aria-live={snapshot.phase === "incoming" ? "assertive" : "polite"} className="text-xs text-muted-foreground">{labels[snapshot.phase]}{snapshot.phase === "incoming" ? ` · ${snapshot.mode === "video" ? "Video" : "Voice"}` : snapshot.connectedAt ? ` · ${duration}` : ""}</p>
        </div>}
        <div className="flex max-w-full flex-wrap items-center gap-1">
          {snapshot.phase === "incoming" && <>
            <Button type="button" variant="outline" className="min-h-11" onClick={() => void run(() => engine.decline())}><PhoneOff />Decline</Button>
            <Button type="button" className="min-h-11" onClick={() => void run(() => engine.prepareIncoming("audio"))}><Phone />{snapshot.mode === "video" ? "Answer audio" : "Answer"}</Button>
            {snapshot.mode === "video" && <Button type="button" className="min-h-11" onClick={() => void run(() => engine.prepareIncoming("video"))}><Video />Answer video</Button>}
          </>}
          {active && <>
            <Button type="button" variant="outline" className="min-h-11 px-2 text-xs" aria-label={snapshot.microphoneMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={snapshot.microphoneMuted} onClick={() => engine.toggleMicrophone()}>{snapshot.microphoneMuted ? <MicOff /> : <Mic />}{snapshot.microphoneMuted ? "Mic muted" : "Mic on"}</Button>
            <Button type="button" variant="outline" className="min-h-11 px-2 text-xs" aria-label={snapshot.cameraEnabled ? "Turn camera off" : "Turn camera on"} aria-pressed={snapshot.cameraEnabled} onClick={() => void run(() => engine.toggleCamera())}>{snapshot.cameraEnabled ? <Video /> : <VideoOff />}{snapshot.cameraEnabled ? "Camera on" : "Camera off"}</Button>
            <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Expand call and device settings" title="Expand call and device settings" onClick={() => setExpanded(true)}><Expand /></Button>
          </>}
          {hasCall && !finished && snapshot.phase !== "incoming" && <Button type="button" variant="destructive" className="min-h-11" aria-label={active ? "End call" : "Cancel call"} onClick={() => void run(() => engine.end())}><PhoneOff />{active ? "End" : "Cancel"}</Button>}
          {finished && hasCall && snapshot.peer && <Button type="button" variant="outline" className="min-h-11" onClick={retry}><RotateCw />Call again</Button>}
          {hasCall && <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Call privacy and notifications" onClick={() => setSettingsOpen(true)}><Settings2 /></Button>}
          {finished && <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Dismiss call status" onClick={() => { engine.dismiss(); clearError() }}><X /></Button>}
        </div>
        {snapshot.phase === "incoming" && <p className="w-full text-xs text-muted-foreground">Answer to review your devices. Your microphone and camera are off until you choose to answer.</p>}
        {snapshot.phase === "ringing" && <p className="w-full text-xs text-muted-foreground">Waiting for {peerLabel} to answer in Serotine. Calls need both pages open.</p>}
        {["incoming", "ringing"].includes(snapshot.phase) && soundStatus !== "ready" && <div className="flex w-full flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{soundStatus === "blocked" ? "Your browser has paused call sounds." : "Call sounds are unavailable in this browser. The call controls still work."}</span>{soundStatus === "blocked" && <Button type="button" variant="outline" className="min-h-11" onClick={() => ringer.current?.unlock()}><Volume2 />Enable call sounds</Button>}</div>}
        {(snapshot.error || error) && <p role="alert" className="w-full break-words text-xs text-destructive">{error || snapshot.error}</p>}
        <ConnectionDetails connection={snapshot.connection} />
        {snapshot.notice && <p role="status" className="w-full break-words text-xs text-muted-foreground">{snapshot.notice}</p>}
        {audioBlocked && <Button type="button" variant="outline" className="min-h-11" onClick={() => { void audio.current?.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true)) }}>Play call audio</Button>}
      </div>
    </section>}

    <Dialog open={preflight} onOpenChange={open => { if (!open) void run(() => engine.end()) }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>{snapshot.direction === "incoming" ? "Answer" : "Call"} {peerLabel}</DialogTitle><DialogDescription>Review your devices before connecting. No media is sent until the call is accepted.</DialogDescription></DialogHeader>
        {busy ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Checking the calling connection and preparing your {snapshot.mode === "video" ? "microphone and camera" : "microphone"}. Allow device access if your browser asks.</p> : <>
          {snapshot.cameraEnabled ? <StreamVideo stream={snapshot.localStream} label="Your camera preview · Only you can see this" mirror /> : <p className="flex min-h-24 items-center justify-center gap-2 rounded-md border border-border bg-muted text-sm text-muted-foreground"><VideoOff className="size-5" />Camera off</p>}
          <DeviceControls />
        </>}
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Shield className="size-4 shrink-0" />Direct encrypted call · Your network address may be visible to the other participant.</p>
        {snapshot.notice && <p role="status" className="text-sm text-muted-foreground">{snapshot.notice}</p>}
        {(error || snapshot.error) && <p role="alert" className="text-sm text-destructive">{error || snapshot.error}</p>}
        <p className="text-xs leading-5 text-muted-foreground">Both people need Serotine open. Keep this page active on a phone to avoid interruptions.</p>
        <DialogFooter><Button type="button" variant="outline" className="min-h-11" onClick={() => void run(() => engine.end())}>Cancel</Button><Button type="button" className="min-h-11" disabled={busy || snapshot.phase !== "preview"} onClick={() => void run(() => engine.connectPreview())}>{snapshot.mode === "video" ? <Video /> : <Phone />}{snapshot.direction === "incoming" ? "Accept and connect" : "Start call"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={expanded && active} onOpenChange={setExpanded}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader><DialogTitle>Call with {peerLabel}</DialogTitle><DialogDescription>{labels[snapshot.phase]} · {duration}. Collapse this view to keep chatting.</DialogDescription></DialogHeader>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {snapshot.remoteCameraEnabled ? <StreamVideo stream={snapshot.remoteStream} label={peerLabel} /> : <div className="flex min-h-28 items-center justify-center gap-2 rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground"><VideoOff className="size-5 shrink-0" /><span>{peerLabel} · Camera off</span></div>}
          {snapshot.cameraEnabled ? <StreamVideo stream={snapshot.localStream} label="You" mirror /> : <div className="flex min-h-28 items-center justify-center gap-2 rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground"><VideoOff className="size-5" />Your camera is off</div>}
        </div>
        <p className="text-xs text-muted-foreground">{peerLabel}: {snapshot.remoteMicrophoneMuted ? "Microphone muted" : "Microphone on"}</p>
        <DeviceControls />
        {(error || snapshot.error) && <p role="alert" className="text-sm text-destructive">{error || snapshot.error}</p>}
        {snapshot.notice && <p role="status" className="text-sm text-muted-foreground">{snapshot.notice}</p>}
        {audioBlocked && <Button type="button" variant="outline" className="min-h-11" onClick={() => { void audio.current?.play().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true)) }}>Play call audio</Button>}
        <DialogFooter><Button type="button" variant="outline" className="min-h-11" onClick={() => setExpanded(false)}>Collapse call</Button><Button type="button" variant="destructive" className="min-h-11" onClick={() => void run(() => engine.end())}><PhoneOff />End call</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <CallSettingsDialog />
  </>
}
