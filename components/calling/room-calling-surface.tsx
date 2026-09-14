"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { Camera, Expand, Loader2, Mic, MicOff, Phone, PhoneOff, RotateCw, Settings2, Shield, Users, Video, VideoOff, Volume2, X } from "lucide-react"
import { useCalling } from "@/components/calling-provider"
import { roomCallActive } from "@/components/calling/room-call-actions"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"

const phaseLabels: Record<string, string> = { idle: "Ready", preparing: "Preparing devices", preview: "Review your devices", joining: "Joining call", joined: "In call", ended: "You left the call", failed: "Call failed" }
const participantLabels: Record<string, string> = { connecting: "Connecting", connected: "Connected", reconnecting: "Reconnecting", failed: "Connection failed" }

function durationLabel(started: number | null, now: number) {
  const seconds = started ? Math.max(0, Math.floor((now - started) / 1000)) : 0
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

function RoomAudio({ stream, label, participantId, elements, onBlocked }: { stream: MediaStream | null; label: string; participantId: string; elements: Map<string, HTMLAudioElement>; onBlocked: (id: string, blocked: boolean) => void }) {
  const ref = useRef<HTMLAudioElement>(null)
  const [blocked, setBlocked] = useState(false)
  const play = () => { const node = ref.current; if (node?.srcObject) void node.play().then(() => setBlocked(false)).catch(() => setBlocked(true)) }
  useEffect(() => { onBlocked(participantId, blocked) }, [participantId, blocked, onBlocked])
  useEffect(() => {
    const node = ref.current
    if (!node) return
    elements.set(participantId, node)
    node.srcObject = stream
    setBlocked(false)
    const start = () => { if (stream?.getAudioTracks().length) void node.play().then(() => setBlocked(false)).catch(() => setBlocked(true)) }
    start()
    stream?.addEventListener("addtrack", start)
    return () => { stream?.removeEventListener("addtrack", start); node.srcObject = null; elements.delete(participantId); onBlocked(participantId, false) }
  }, [stream, participantId, elements, onBlocked])
  return <><audio ref={ref} autoPlay onPlay={() => setBlocked(false)} aria-label={`Call audio from ${label}`} />{blocked && <div role="status" className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-2 py-2 text-xs sm:px-4"><span className="min-w-0 break-words">Your browser paused audio from {label}.</span><Button type="button" variant="outline" className="min-h-11 max-w-full whitespace-normal text-left text-xs" onClick={play}><Volume2 className="shrink-0" />Play audio from {label}</Button></div>}</>
}

function RoomVideo({ stream, label, mirror }: { stream: MediaStream | null; label: string; mirror?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  const [blocked, setBlocked] = useState(false)
  const play = () => { const node = ref.current; if (node?.srcObject) void node.play().then(() => setBlocked(false)).catch(() => setBlocked(true)) }
  useEffect(() => {
    const node = ref.current
    if (!node) return
    node.srcObject = stream
    setBlocked(false)
    const start = () => { if (stream?.getVideoTracks().length) void node.play().then(() => setBlocked(false)).catch(() => setBlocked(true)) }
    start()
    stream?.addEventListener("addtrack", start)
    return () => { stream?.removeEventListener("addtrack", start); node.srcObject = null }
  }, [stream])
  return <div className="min-w-0 bg-muted">
    <video ref={ref} autoPlay muted playsInline aria-label={`${label} video`} className={`aspect-video w-full object-contain ${mirror ? "-scale-x-100" : ""}`} />
    {blocked && <div className="space-y-2 p-3"><p role="status" className="text-xs text-muted-foreground">Your browser paused this video.</p><Button type="button" variant="outline" className="min-h-11 w-full" onClick={play}>Play video</Button></div>}
  </div>
}

function ParticipantTile({ stream, label, microphoneMuted, cameraEnabled, status, error, local, voiceOnly }: { stream: MediaStream | null; label: string; microphoneMuted: boolean; cameraEnabled: boolean; status: string; error?: string | null; local?: boolean; voiceOnly?: boolean }) {
  return <figure className="min-w-0 overflow-hidden rounded-md border border-border bg-card">
    {!voiceOnly && (cameraEnabled ? <RoomVideo stream={stream} label={label} mirror={local} /> : <div className="flex aspect-video min-h-24 items-center justify-center gap-2 bg-muted p-4 text-sm text-muted-foreground"><VideoOff className="size-5 shrink-0" />Camera off</div>)}
    <figcaption className={`space-y-1 px-3 py-2 ${voiceOnly ? "" : "border-t border-border"}`}><p className="flex min-w-0 items-center gap-2 text-sm">{microphoneMuted ? <MicOff aria-label="Microphone muted" className="size-4 shrink-0 text-muted-foreground" /> : <Mic aria-label="Microphone on" className="size-4 shrink-0 text-primary" />}<span className="min-w-0 truncate">{label}</span></p><p className="text-xs text-muted-foreground">{status}</p>{error && <p role="status" className="break-words text-xs text-destructive">{error}</p>}</figcaption>
  </figure>
}

function RoomDeviceControls() {
  const { roomEngine: engine, roomSnapshot: snapshot, run } = useCalling()
  if (!engine || !snapshot) return null
  const editable = ["preview", "joining", "joined"].includes(snapshot.phase)
  const voiceOnly = snapshot.target?.kind === "channel"
  const microphones = snapshot.devices.filter(device => device.kind === "audioinput")
  const cameras = snapshot.devices.filter(device => device.kind === "videoinput")
  return <div className="min-w-0 space-y-3">
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" className="min-h-11" disabled={!editable} aria-label={snapshot.microphoneMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={snapshot.microphoneMuted} onClick={() => engine.toggleMicrophone()}>{snapshot.microphoneMuted ? <MicOff /> : <Mic />}{snapshot.microphoneMuted ? "Mic muted" : "Mic on"}</Button>
      {!voiceOnly && <Button type="button" variant="outline" className="min-h-11" disabled={!editable} aria-label={snapshot.cameraEnabled ? "Turn camera off" : "Turn camera on"} aria-pressed={snapshot.cameraEnabled} onClick={() => void run(() => engine.toggleCamera())}>{snapshot.cameraEnabled ? <Video /> : <VideoOff />}{snapshot.cameraEnabled ? "Camera on" : "Camera off"}</Button>}
      {!voiceOnly && snapshot.cameraEnabled && <Button type="button" variant="outline" className="min-h-11" disabled={!editable} onClick={() => void run(() => engine.switchCamera())}><Camera />Switch camera</Button>}
    </div>
    {microphones.length > 0 && <div className="space-y-1"><Label htmlFor="room-call-microphone">Microphone</Label><select id="room-call-microphone" value={snapshot.microphoneId} disabled={!editable} onChange={event => void run(() => engine.selectMicrophone(event.target.value))} className="min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm"><option value="">System default</option>{microphones.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>}
    {!voiceOnly && snapshot.cameraEnabled && cameras.length > 0 && <div className="space-y-1"><Label htmlFor="room-call-camera">Camera</Label><select id="room-call-camera" value={snapshot.cameraId} disabled={!editable} onChange={event => void run(() => engine.selectCamera(event.target.value))} className="min-h-11 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm"><option value="">System default</option>{cameras.map((device, index) => <option key={device.deviceId || index} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div>}
  </div>
}

export function RoomCallingSurface() {
  const { roomEngine: engine, roomSnapshot: snapshot, error, clearError, run, setSettingsOpen } = useCalling()
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(0)
  const audioElements = useRef(new Map<string, HTMLAudioElement>())
  const [audioBlocked, setAudioBlocked] = useState<Record<string, boolean>>({})
  const reportAudioBlocked = useCallback((id: string, blocked: boolean) => setAudioBlocked(previous => previous[id] === blocked ? previous : { ...previous, [id]: blocked }), [])
  useEffect(() => {
    if (!snapshot?.joinedAt || snapshot.phase !== "joined") return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [snapshot?.joinedAt, snapshot?.phase])
  useEffect(() => { if (!roomCallActive(snapshot?.phase)) setExpanded(false) }, [snapshot?.phase])
  if (!engine || !snapshot || snapshot.phase === "idle") return null
  const preflight = snapshot.phase === "preparing" || snapshot.phase === "preview"
  const active = snapshot.phase === "joining" || snapshot.phase === "joined"
  const finished = !roomCallActive(snapshot.phase)
  const target = snapshot.target
  const voiceOnly = target?.kind === "channel"
  const href = target?.kind === "group" ? `/chat/${target.group.id}` : target?.kind === "channel" ? `/chat/communities#${new URLSearchParams({ id: target.community.id, channel: target.channelId })}` : null
  const duration = durationLabel(snapshot.joinedAt, now)
  const count = snapshot.participants.length + 1
  const retry = () => { if (target) void run(() => engine.prepare(target, snapshot.mode)) }
  const blockedAudio = snapshot.participants.some(participant => audioBlocked[`${participant.publicKey}:${participant.sessionId}`])
  const playAudio = () => { for (const [id, node] of audioElements.current) void node.play().then(() => reportAudioBlocked(id, false)).catch(() => reportAudioBlocked(id, true)) }

  return <>
    <section aria-label="Current group call" className="border-b border-border bg-card text-card-foreground shadow-sm">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 sm:px-4">
        <div className="min-w-0 flex-1 basis-32"><p className="flex min-w-0 items-center gap-2 text-sm font-medium"><Users className="size-4 shrink-0" />{href ? <Link href={href} className="truncate hover:underline">{snapshot.targetLabel}</Link> : <span className="truncate">{snapshot.targetLabel || "Group call"}</span>}</p><p role="status" className="text-xs text-muted-foreground">{phaseLabels[snapshot.phase]}{snapshot.phase === "joined" ? ` · ${count}/8 people · ${duration}` : ""}</p></div>
        <div className="flex max-w-full flex-wrap items-center gap-1">
          {active && <>
            <Button type="button" variant="outline" className="min-h-11 min-w-11 px-2 text-xs" aria-label={snapshot.microphoneMuted ? "Unmute microphone" : "Mute microphone"} title={snapshot.microphoneMuted ? "Unmute microphone" : "Mute microphone"} aria-pressed={snapshot.microphoneMuted} onClick={() => engine.toggleMicrophone()}>{snapshot.microphoneMuted ? <MicOff /> : <Mic />}<span className="hidden sm:inline">{snapshot.microphoneMuted ? "Mic muted" : "Mic on"}</span></Button>
            {!voiceOnly && <Button type="button" variant="outline" className="min-h-11 min-w-11 px-2 text-xs" aria-label={snapshot.cameraEnabled ? "Turn camera off" : "Turn camera on"} title={snapshot.cameraEnabled ? "Turn camera off" : "Turn camera on"} aria-pressed={snapshot.cameraEnabled} onClick={() => void run(() => engine.toggleCamera())}>{snapshot.cameraEnabled ? <Video /> : <VideoOff />}<span className="hidden sm:inline">{snapshot.cameraEnabled ? "Camera on" : "Camera off"}</span></Button>}
            <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Show call participants and devices" title="Show call participants and devices" onClick={() => setExpanded(true)}><Expand /></Button>
          </>}
          {!finished && <Button type="button" variant="destructive" className="min-h-11 px-3" aria-label={active ? "Leave call" : "Cancel joining call"} onClick={() => void run(() => engine.leave())}><PhoneOff />{active ? "Leave" : "Cancel"}</Button>}
          {finished && target && <Button type="button" variant="outline" className="min-h-11" onClick={retry}><RotateCw />Rejoin</Button>}
          <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Call privacy and notifications" title="Call privacy and notifications" onClick={() => setSettingsOpen(true)}><Settings2 /></Button>
          {finished && <Button type="button" variant="ghost" size="icon" className="size-11" aria-label="Dismiss group call" onClick={() => { engine.dismiss(); clearError() }}><X /></Button>}
        </div>
        {snapshot.notice && <p role="status" className="basis-full break-words text-xs text-muted-foreground">{snapshot.notice}</p>}
        {(error || snapshot.error) && <p role="alert" className="basis-full break-words text-xs text-destructive">{error || snapshot.error}</p>}
      </div>
      {snapshot.participants.map(participant => <RoomAudio key={`${participant.publicKey}:${participant.sessionId}`} participantId={`${participant.publicKey}:${participant.sessionId}`} stream={participant.stream} label={participant.label} elements={audioElements.current} onBlocked={reportAudioBlocked} />)}
    </section>

    <Dialog open={preflight} onOpenChange={open => { if (!open) void run(() => engine.leave()) }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>Join {snapshot.targetLabel}</DialogTitle><DialogDescription>Review your microphone{voiceOnly ? "" : " and camera"}. Other members receive your media only after you choose Join call.</DialogDescription></DialogHeader>
        {snapshot.phase === "preparing" ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Waiting for microphone{snapshot.mode === "video" ? " and camera" : ""} permission…</p> : <>
          <ParticipantTile stream={snapshot.localStream} label="You" microphoneMuted={snapshot.microphoneMuted} cameraEnabled={snapshot.cameraEnabled} status={voiceOnly ? "Your microphone is not shared yet" : "Only you can see this preview"} local voiceOnly={voiceOnly} />
          <RoomDeviceControls />
        </>}
        <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground"><Shield className="mt-0.5 size-4 shrink-0" /><span>Calls connect directly between participants. Other participants may see your network address. Audio and video stay encrypted between your devices. Some restrictive networks cannot connect.</span></p>
        <p className="text-xs leading-5 text-muted-foreground">Up to 8 people can join. Keep Serotine open during the call. Joining does not ring other members.</p>
        {snapshot.notice && <p role="status" className="text-sm text-muted-foreground">{snapshot.notice}</p>}
        {(error || snapshot.error) && <p role="alert" className="text-sm text-destructive">{error || snapshot.error}</p>}
        <DialogFooter><Button type="button" variant="outline" className="min-h-11" onClick={() => void run(() => engine.leave())}>Cancel</Button><Button type="button" className="min-h-11" disabled={snapshot.phase !== "preview"} onClick={() => void run(() => engine.joinPreview())}><Phone />Join call</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={expanded && active} onOpenChange={setExpanded}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader><DialogTitle>{snapshot.targetLabel}</DialogTitle><DialogDescription>{count}/8 participants · {duration}. Collapse this view to keep chatting.</DialogDescription></DialogHeader>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <ParticipantTile stream={snapshot.localStream} label="You" microphoneMuted={snapshot.microphoneMuted} cameraEnabled={snapshot.cameraEnabled} status={snapshot.phase === "joining" ? "Joining call" : "In call"} local voiceOnly={voiceOnly} />
          {snapshot.participants.map(participant => <ParticipantTile key={`${participant.publicKey}:${participant.sessionId}`} stream={participant.stream} label={participant.label} microphoneMuted={participant.microphoneMuted} cameraEnabled={participant.cameraEnabled} status={participantLabels[participant.phase]} error={participant.error} voiceOnly={voiceOnly} />)}
        </div>
        {snapshot.participants.length === 0 && snapshot.phase === "joined" && <p role="status" className="text-sm text-muted-foreground">You are the first here. Other members can join from the {target?.kind === "channel" ? "voice channel" : "group’s call menu"}.</p>}
        <RoomDeviceControls />
        {blockedAudio && <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">Your browser paused call audio.</p><Button type="button" variant="outline" className="min-h-11" onClick={playAudio}><Volume2 />Play call audio</Button></div>}
        {(error || snapshot.error) && <p role="alert" className="text-sm text-destructive">{error || snapshot.error}</p>}
        <DialogFooter><Button type="button" variant="outline" className="min-h-11" onClick={() => setExpanded(false)}>Collapse call</Button><Button type="button" variant="destructive" className="min-h-11" onClick={() => void run(() => engine.leave())}><PhoneOff />Leave call</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
