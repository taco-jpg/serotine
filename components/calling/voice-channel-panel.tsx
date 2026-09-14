"use client"

import { Mic, MicOff, Phone, PhoneOff, Settings2, Users, Video } from "lucide-react"
import { useCalling } from "@/components/calling-provider"
import { directCallActive, roomCallActive } from "@/components/calling/room-call-actions"
import { Button } from "@/components/ui/button"
import { communityStateSnapshot } from "@/lib/community-protocol"
import type { CommunityChannel, CommunityRecord } from "@/lib/community-types"

export function VoiceChannelPanel({ community, channel, disabled, restriction }: { community: CommunityRecord; channel: CommunityChannel; disabled?: boolean; restriction?: string }) {
  const { roomEngine, roomSnapshot, snapshot, run, setSettingsOpen } = useCalling()
  const active = roomCallActive(roomSnapshot?.phase)
  const target = roomSnapshot?.target
  const here = active && target?.kind === "channel" && target.community.id === community.id && target.channelId === channel.id
  const occupied = active || directCallActive(snapshot?.phase)
  const unavailable = disabled || !roomEngine || !roomSnapshot?.supported || occupied
  const join = () => { if (roomEngine) void run(() => roomEngine.prepare({ kind: "channel", community: communityStateSnapshot(community), channelId: channel.id }, "audio")) }
  return <section aria-label={`Voice channel ${channel.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="space-y-3">
        <span className="flex size-12 items-center justify-center rounded-md border border-border bg-card text-primary"><Mic className="size-6" /></span>
        <div><p className="mb-1 text-xs text-muted-foreground">Voice channel</p><h2 className="break-words text-2xl font-medium tracking-tight">{channel.name}</h2></div>
        <p className="max-w-xl text-sm leading-6 text-muted-foreground">Join a live conversation with members of {community.name}. Review your microphone before joining. Voice channels use audio only. Up to 8 people can be in the channel at once.</p>
        <div className="flex flex-wrap gap-2">
          {here ? <Button type="button" variant="destructive" className="min-h-11" onClick={() => { if (roomEngine) void run(() => roomEngine.leave()) }}><PhoneOff />Leave voice channel</Button> : <Button type="button" className="min-h-11" disabled={unavailable} onClick={join}><Phone />Join voice channel</Button>}
          <Button type="button" variant="outline" className="min-h-11" onClick={() => setSettingsOpen(true)}><Settings2 />Call settings</Button>
        </div>
        {disabled && <p role="status" className="text-sm text-muted-foreground">{restriction || "You need current channel access to join this voice channel."}</p>}
        {!disabled && !roomSnapshot?.supported && <p role="status" className="text-sm text-muted-foreground">This browser does not support calling.</p>}
        {!disabled && occupied && !here && <p role="status" className="text-sm text-muted-foreground">Leave your current call before joining this channel.</p>}
      </div>
      {here && roomSnapshot && ["joining", "joined"].includes(roomSnapshot.phase) && <div className="space-y-3 border-t border-border pt-5">
        <h3 className="flex items-center gap-2 text-sm font-medium"><Users className="size-4" />In this channel · {roomSnapshot.participants.length + 1}/8</h3>
        <ul className="grid min-w-0 gap-2 sm:grid-cols-2">
          <li className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card p-3 text-sm">{roomSnapshot.microphoneMuted ? <MicOff aria-label="Microphone muted" className="size-4 shrink-0 text-muted-foreground" /> : <Mic aria-label="Microphone on" className="size-4 shrink-0 text-primary" />}<span className="min-w-0 flex-1 truncate">You</span>{roomSnapshot.cameraEnabled && <Video aria-label="Camera on" className="size-4 shrink-0 text-muted-foreground" />}</li>
          {roomSnapshot.participants.map(participant => <li key={`${participant.publicKey}:${participant.sessionId}`} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-card p-3 text-sm">{participant.microphoneMuted ? <MicOff aria-label="Microphone muted" className="size-4 shrink-0 text-muted-foreground" /> : <Mic aria-label="Microphone on" className="size-4 shrink-0 text-primary" />}<span className="min-w-0 flex-1"><span className="block truncate">{participant.label}</span><span className="text-xs text-muted-foreground">{participant.phase === "connected" ? "Connected" : participant.phase === "reconnecting" ? "Reconnecting…" : participant.phase === "failed" ? "Connection failed" : "Connecting…"}</span></span>{participant.cameraEnabled && <Video aria-label="Camera on" className="size-4 shrink-0 text-muted-foreground" />}</li>)}
        </ul>
        <p className="text-xs leading-5 text-muted-foreground">The call stays open while you browse channels. Use the call bar to see video, change devices, or leave.</p>
      </div>}
      {!here && <p className="border-t border-border pt-5 text-xs leading-5 text-muted-foreground">Joining opens the shared voice room without ringing other members. Keep Serotine open during the call.</p>}
    </div>
  </section>
}
