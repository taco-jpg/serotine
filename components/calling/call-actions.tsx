"use client"

import { useEffect, useState } from "react"
import { Loader2, Phone, RotateCw, Settings2, Video } from "lucide-react"
import { useCalling } from "@/components/calling-provider"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { CallAvailability } from "@/lib/call-types"

export function CallActions({ conversationId, disabled }: { conversationId: string; disabled?: boolean }) {
  const { engine, snapshot, run, setSettingsOpen } = useCalling()
  const [open, setOpen] = useState(false)
  const [availability, setAvailability] = useState<CallAvailability>("checking")
  const [check, setCheck] = useState(0)
  const occupied = !!snapshot && !["idle", "ended", "declined", "unanswered", "busy", "failed"].includes(snapshot.phase)
  useEffect(() => {
    if (!open || !engine) return
    let cancelled = false
    setAvailability("checking")
    void engine.availability(conversationId).then(value => { if (!cancelled) setAvailability(value) }).catch(() => { if (!cancelled) setAvailability("unavailable") })
    return () => { cancelled = true }
  }, [open, conversationId, engine, check])
  const unavailable = disabled || !engine || !snapshot?.supported || occupied || availability !== "available"
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger asChild><Button type="button" size="icon" variant="ghost" className="size-11" aria-label="Voice and video call options" title="Voice and video calls"><Phone className="size-4" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
      <DropdownMenuItem className="min-h-11" disabled={unavailable} onSelect={() => { if (engine) void run(() => engine.prepareOutgoing(conversationId, "audio")) }}><Phone />Voice call</DropdownMenuItem>
      <DropdownMenuItem className="min-h-11" disabled={unavailable} onSelect={() => { if (engine) void run(() => engine.prepareOutgoing(conversationId, "video")) }}><Video />Video call</DropdownMenuItem>
      <p role="status" className="max-w-64 px-2 py-2 text-xs leading-5 text-muted-foreground">{!snapshot?.supported ? "This browser does not support calling." : occupied ? "Finish your current call before starting another." : availability === "checking" ? <span className="flex items-center gap-2"><Loader2 className="size-3 animate-spin" />Checking calling support…</span> : availability === "unavailable" ? "Calling is unavailable or unconfirmed. Both people need an updated Serotine open." : "Review your microphone and camera before ringing."}</p>
      {snapshot?.supported && !occupied && availability === "unavailable" && <DropdownMenuItem className="min-h-11" onSelect={event => { event.preventDefault(); setCheck(value => value + 1) }}><RotateCw />Check calling support again</DropdownMenuItem>}
      <DropdownMenuSeparator />
      <DropdownMenuItem className="min-h-11" onSelect={() => requestAnimationFrame(() => setSettingsOpen(true))}><Settings2 />Call privacy and notifications</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}
