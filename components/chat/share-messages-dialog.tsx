"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Share2, X } from "lucide-react"
import { useCommunities, useMessaging } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { canPostToCommunityChannel } from "@/lib/community-protocol"
import { MAX_SHARED_MESSAGES, sharedMessagesFromSelection, type ShareSource, type ShareDestination } from "@/lib/shared-messages"
import type { MessageRecord } from "@/lib/messaging-types"
import { SharedMessageBundle } from "./shared-message-bundle"

export function toggleSharedSelection(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(value => value !== id) : ids.length < MAX_SHARED_MESSAGES ? [...ids, id] : ids
}

export function MessageSelectionToolbar({ source, messages, selected, onCancel }: {
  source: ShareSource
  messages: readonly (MessageRecord & { channelId?: string; hidden?: boolean })[]
  selected: string[]
  onCancel: () => void
}) {
  const [open, setOpen] = useState(false)
  return <><div role="region" aria-label="Message selection" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
    <span role="status" className="min-w-0 flex-1 text-sm">{selected.length}/{MAX_SHARED_MESSAGES} selected</span>
    <Button size="sm" disabled={!selected.length} onClick={() => setOpen(true)}><Share2 className="size-4" />Share selected</Button>
    <Button size="sm" variant="ghost" onClick={onCancel}><X className="size-4" />Cancel selection</Button>
  </div>{open && <ShareMessagesDialog source={source} messages={messages} selected={selected} onClose={() => setOpen(false)} onComplete={onCancel} />}</>
}

function ShareMessagesDialog({ source, messages, selected, onClose, onComplete }: {
  source: ShareSource
  messages: readonly (MessageRecord & { channelId?: string; hidden?: boolean })[]
  selected: string[]
  onClose: () => void
  onComplete: () => void
}) {
  const messaging = useMessaging(), communities = useCommunities()
  const owner = messaging.identity?.publicKey
  const [snapshot] = useState(() => {
    try { return { bundle: sharedMessagesFromSelection(messages, source, selected), ids: [...selected], error: "" } }
    catch (cause) { return { bundle: null, ids: [...selected], error: cause instanceof Error ? cause.message : "Review your selection." } }
  })
  const [destinationKey, setDestinationKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(snapshot.error)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const destinations = useMemo(() => [
    ...messaging.conversations.filter(conversation => !conversation.request && !conversation.blocked && conversation.members.includes(owner || "") && !messaging.getPrivateMode(conversation.id))
      .map(conversation => ({ key: conversation.id, label: conversation.name, destination: { conversationId: conversation.id } as ShareDestination })),
    ...communities.model.communities.filter(community => community.joined && !community.deleted && community.members.length === community.effectiveMembers.length)
      .flatMap(community => community.channels.filter(channel => canPostToCommunityChannel(community, owner || "", channel.id)).map(channel => ({
        key: `${community.id}:${channel.id}`, label: `${community.name} / #${channel.name}`, destination: { conversationId: community.id, channelId: channel.id } as ShareDestination,
      }))),
  ], [messaging, communities.model.communities, owner])
  const destination = destinations.find(item => item.key === destinationKey)
  const send = async () => {
    if (busy || !destination || !snapshot.bundle || !messaging.ready) return
    setBusy(true); setError("")
    try {
      await messaging.shareMessages(source, snapshot.ids, destination.destination, snapshot.bundle)
      if (mounted.current) onComplete()
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "These messages could not be shared.") }
    finally { if (mounted.current) setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>Share selected messages</DialogTitle><DialogDescription>Review the copy and choose who will receive it. Source edits or deletion will not change a copy already shared.</DialogDescription></DialogHeader>
    {snapshot.bundle && <div className="max-h-[40dvh] overflow-y-auto"><SharedMessageBundle bundle={snapshot.bundle} /></div>}
    <p className="text-xs leading-relaxed text-muted-foreground">Only selected text, sender address labels, timestamps, and file names/sizes are copied. File bytes and access keys are excluded. Local contact names and optional profile fields are not shared.</p>
    <label className="space-y-2 text-sm font-medium">Destination<select aria-label="Share destination" className="mt-2 h-10 w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm" disabled={busy} value={destinationKey} onChange={event => setDestinationKey(event.target.value)}><option value="">Choose a conversation or channel</option>{destinations.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
    {!destinations.length && <p className="text-sm text-muted-foreground">There are no available destinations. Accept or create a conversation first.</p>}
    {destination && <p className="break-words text-sm">Send this copy to <strong>{destination.label}</strong>.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || !snapshot.bundle || !destination || !messaging.ready} onClick={() => void send()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Share2 className="size-4" />}Send shared copy</Button></DialogFooter>
  </DialogContent></Dialog>
}
