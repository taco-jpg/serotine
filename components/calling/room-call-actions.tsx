"use client"

import { Phone, PhoneOff, Settings2, Video } from "lucide-react"
import { useCalling } from "@/components/calling-provider"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { GroupState } from "@/lib/messaging-types"

export function roomCallActive(phase?: string) {
  return !!phase && !["idle", "ended", "failed"].includes(phase)
}

export function directCallActive(phase?: string) {
  return !!phase && !["idle", "ended", "declined", "unanswered", "busy", "failed"].includes(phase)
}

export function RoomCallActions({ group, disabled }: { group: GroupState; disabled?: boolean }) {
  const { roomEngine, roomSnapshot, snapshot, run, setSettingsOpen } = useCalling()
  const active = roomCallActive(roomSnapshot?.phase)
  const here = active && roomSnapshot?.target?.kind === "group" && roomSnapshot.target.group.id === group.id
  const occupied = active || directCallActive(snapshot?.phase)
  const unavailable = disabled || !roomEngine || !roomSnapshot?.supported || occupied
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button type="button" size="icon" variant="ghost" className="size-11" aria-label="Group voice and video call options" title="Group calls"><Phone className="size-4" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
      {here ? <DropdownMenuItem className="min-h-11" onSelect={() => { if (roomEngine) void run(() => roomEngine.leave()) }}><PhoneOff />Leave group call</DropdownMenuItem> : <>
        <DropdownMenuItem className="min-h-11" disabled={unavailable} onSelect={() => { if (roomEngine) void run(() => roomEngine.prepare({ kind: "group", group }, "audio")) }}><Phone />Join group voice call</DropdownMenuItem>
        <DropdownMenuItem className="min-h-11" disabled={unavailable} onSelect={() => { if (roomEngine) void run(() => roomEngine.prepare({ kind: "group", group }, "video")) }}><Video />Join group video call</DropdownMenuItem>
      </>}
      <p role="status" className="max-w-64 px-2 py-2 text-xs leading-5 text-muted-foreground">{!roomSnapshot?.supported ? "This browser does not support calling." : here ? "You are in this group’s call. Use the call bar to change devices or see participants." : occupied ? "Leave your current call before joining another." : disabled ? "Calls are available to current, accepted group members." : "Review your devices, then join the shared call. Up to 8 people can join from this menu; joining does not ring the group."}</p>
      <DropdownMenuSeparator />
      <DropdownMenuItem className="min-h-11" onSelect={() => requestAnimationFrame(() => setSettingsOpen(true))}><Settings2 />Call privacy and notifications</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}
