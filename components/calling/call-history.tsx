"use client"

import { useEffect, useRef, useState } from "react"
import { Phone, Trash2, Video } from "lucide-react"
import { useMessaging } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"
import { deleteCallHistory, getCallHistory } from "@/lib/messaging-store"
import type { CallHistoryRecord } from "@/lib/call-history"
import { PUBLIC_KEY_PATTERN } from "@/lib/protocol"

function summary(row: CallHistoryRecord) {
  if (row.outcome === "ended" && row.durationSeconds > 0) return `${Math.floor(row.durationSeconds / 60)}:${String(row.durationSeconds % 60).padStart(2, "0")}`
  if (row.outcome === "unanswered") return row.direction === "incoming" ? "Missed" : "No answer"
  if (row.outcome === "ended" || row.outcome === "cancelled") return "Cancelled"
  return row.outcome[0].toUpperCase() + row.outcome.slice(1)
}

export function CallHistory({ conversationId }: { conversationId: string }) {
  const { identity, ready } = useMessaging()
  const owner = identity?.publicKey
  if (!ready || !owner || !PUBLIC_KEY_PATTERN.test(conversationId) || owner === conversationId) return null
  return <ConversationCallHistory key={`${owner}:${conversationId}`} owner={owner} conversationId={conversationId} />
}

function ConversationCallHistory({ owner, conversationId }: { owner: string; conversationId: string }) {
  const [rows, setRows] = useState<CallHistoryRecord[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [limit, setLimit] = useState(20)
  const [deleting, setDeleting] = useState<string | null>(null)
  const removed = useRef(new Set<string>())
  useEffect(() => {
    let active = true, reading = false
    const read = async () => {
      if (reading) return
      reading = true
      try {
        const data = await getCallHistory(owner)
        if (active) {
          setRows(data.records.filter(row => row.peer === conversationId && !removed.current.has(row.id)).reverse())
          setLoadError(null)
        }
      } catch { if (active) setLoadError("Call history could not be loaded.") }
      finally { reading = false }
    }
    const refresh = () => { void read() }
    const event = (event: Event) => { if ((event as CustomEvent).detail?.owner === owner) refresh() }
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh() }, 5000)
    window.addEventListener("serotine:events", event)
    window.addEventListener("focus", refresh)
    refresh()
    return () => { active = false; clearInterval(timer); window.removeEventListener("serotine:events", event); window.removeEventListener("focus", refresh) }
  }, [owner, conversationId])
  const error = actionError || loadError
  if (!rows.length && !error) return null
  return <details className="mb-3 rounded-md border border-border px-3 py-2 text-xs text-muted-foreground" data-call-history>
    <summary className="cursor-pointer py-1 font-medium">Call history{rows.length ? ` (${rows.length})` : ""}</summary>
    {error && <p role="alert" className="py-2">{error}</p>}
    <ul className="mt-1 divide-y divide-border">
      {rows.slice(0, limit).map(row => <li key={row.id} className="flex min-w-0 items-center gap-2 py-1.5">
        {row.mode === "video" ? <Video className="size-4 shrink-0" aria-hidden /> : <Phone className="size-4 shrink-0" aria-hidden />}
        <div className="min-w-0 flex-1">
          <p>{row.direction === "incoming" ? "Incoming" : "Outgoing"} {row.mode === "video" ? "video" : "voice"} call · {summary(row)}</p>
          <time dateTime={new Date(row.startedAt).toISOString()} className="text-[11px]">{new Date(row.startedAt).toLocaleString()}</time>
        </div>
        <Button variant="ghost" size="icon" className="size-9 shrink-0" disabled={!!deleting} aria-label="Delete call entry" title="Delete this call entry on this device" onClick={async () => {
          setDeleting(row.id); setActionError(null)
          try {
            await deleteCallHistory(owner, row.id)
            removed.current.add(row.id)
            setRows(current => current.filter(item => item.id !== row.id))
          } catch { setActionError("The call entry could not be deleted. Try again.") }
          finally { setDeleting(null) }
        }}><Trash2 className="size-3.5" aria-hidden /></Button>
      </li>)}
    </ul>
    {rows.length > limit && <Button variant="ghost" size="sm" onClick={() => setLimit(value => value + 20)}>Show older calls</Button>}
    <p className="pt-1 text-[11px]">Saved on this device and included in full backups. Private calls leave no entry.</p>
  </details>
}
