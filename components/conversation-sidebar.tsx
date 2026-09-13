"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useRef, useState } from "react"
import { Archive, ArchiveRestore, Bell, BellOff, File, Mic, BarChart3, Users, UserRound, CheckCheck, Clock3, CircleAlert, Hash, Loader2, MoreHorizontal } from "lucide-react"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { useCommunities } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { ConversationRecord, MessageRecord, NotificationMode } from "@/lib/messaging-types"
import type { CommunityRecord } from "@/lib/community-types"
import { formatMentionText } from "@/lib/mention-display"
import { communityHref, conversationHref } from "@/lib/conversation-route"

export function messagePreview(message?: MessageRecord, displayName?: (pub: string) => string): string {
  if (!message) return "Start a conversation"
  if (message.private) return message.expiresAt && message.expiresAt <= Date.now() ? "Private message expired" : message.secret ? "Private access key" : "Private message"
  if (message.attachment?.kind === "voice") return message.content || "Voice message"
  if (message.attachment) return [message.attachment.name, message.content].filter(Boolean).join(" · ")
  if (message.poll) return `Poll: ${message.poll.question}`
  const content = displayName ? formatMentionText(message.content, message.mentions || [], displayName) : message.content
  return content.replace(/\s+/g, " ").trim() || "Message"
}

function messageTime(timestamp: number) {
  const date = new Date(timestamp)
  if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

export function ConversationRow({ conversation, selected, owner, actions, displayName, collapsed = false, href, icon: customIcon, preview }: {
  conversation: ConversationRecord; selected: boolean; owner: string; actions?: React.ReactNode; displayName?: (pub: string) => string; collapsed?: boolean
  href?: string; icon?: React.ReactNode; preview?: string
}) {
  const last = conversation.lastMessage
  const outgoing = last?.senderPubKey === owner
  const groupStatus = conversation.kind === "group" && conversation.group && !conversation.members.includes(owner)
    ? conversation.members.length === 0 ? "Closed" : "Left group"
    : null
  const name = conversation.kind === "self" ? "Message yourself" : conversation.name
  const secondaryText = selected ? "text-sidebar-accent-foreground" : "text-muted-foreground"
  const icon = customIcon || (conversation.kind === "group" ? <span className="flex size-8 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background text-primary"><Users className="size-4" /></span>
    : conversation.kind === "self" ? <span className="flex size-8 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background text-primary"><UserRound className="size-4" /></span>
      : <IdentityIcon pubKey={conversation.id} size={32} />)
  const rowStyle = selected ? "border-sidebar-ring bg-sidebar-accent" : "border-transparent hover:bg-accent/80"
  if (collapsed) return <Link
    href={href || conversationHref(conversation.id)}
    aria-current={selected ? "page" : undefined}
    aria-label={`${name}${conversation.archived ? ", archived" : ""}${conversation.unreadCount > 0 ? `, ${conversation.unreadCount} unread messages` : ""}`}
    title={name}
    className={`relative flex size-11 shrink-0 items-center justify-center rounded-[4px] border-l-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none ${rowStyle}`}
  >
    {icon}
    {conversation.unreadCount > 0 && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-[3px] bg-primary px-1 text-[9px] font-semibold leading-4 text-primary-foreground ring-2 ring-sidebar">{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</span>}
  </Link>
  return <div className={`group/row flex items-center gap-0.5 rounded-[4px] border-l-2 transition-colors motion-reduce:transition-none ${rowStyle}`}>
    <Link href={href || conversationHref(conversation.id)} aria-current={selected ? "page" : undefined} className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-[4px] px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5"><span className={`truncate text-[13px] text-foreground ${conversation.unreadCount ? "font-semibold" : "font-medium"}`}>{name}</span>{conversation.archived && <Archive className="size-3 shrink-0 text-muted-foreground" aria-label="Archived" />}{conversation.notificationMode === "muted" && <BellOff className="size-3 shrink-0 text-muted-foreground" aria-label="Muted" />}<span className={`ml-auto shrink-0 tabular-nums text-[11px] ${secondaryText}`}>{last ? messageTime(last.timestamp) : ""}</span></span>
        <span className={`flex items-center gap-1 text-xs ${secondaryText}`}>
          {groupStatus && <span className="shrink-0 text-[10px] text-destructive">{groupStatus} ·</span>}
          {outgoing && last?.delivery === "pending" && <Clock3 className="size-3 shrink-0" aria-label="Queued" />}
          {(conversation.sendError || (outgoing && last?.delivery === "failed")) && <CircleAlert className="size-3 shrink-0 text-destructive" aria-label="Delivery issue in this conversation" />}
          {outgoing && (last?.delivery === "delivered" || last?.delivery === "read") && <CheckCheck className={`size-3 shrink-0 ${last.delivery === "read" ? "text-primary" : ""}`} aria-label={last.delivery} />}
          {last?.attachment && (last.attachment.kind === "voice" ? <Mic className="size-3 shrink-0" /> : <File className="size-3 shrink-0" />)}
          {last?.poll && <BarChart3 className="size-3 shrink-0" />}
          <span className="truncate">{outgoing && conversation.kind !== "self" ? "You: " : ""}{preview ?? (last ? messagePreview(last, displayName) : conversation.kind === "self" ? "Send messages and files to yourself" : conversation.kind === "group" ? `${conversation.members.length} members` : "Start a conversation")}</span>
          {conversation.unreadCount > 0 && <span aria-label={`${conversation.unreadCount} unread messages`} className="ml-auto flex min-w-5 shrink-0 items-center justify-center rounded-[3px] bg-primary px-1.5 py-0.5 font-semibold tabular-nums text-[10px] text-primary-foreground">{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</span>}
        </span>
      </span>
    </Link>
    {actions}
  </div>
}

/** Communities use the same full-size, unread-aware inbox row as other conversations. */
export function CommunityRow({ community, selected, owner, displayName, collapsed = false, archived = false, actions }: {
  community: CommunityRecord; selected: boolean; owner: string; displayName?: (pub: string) => string; collapsed?: boolean; archived?: boolean; actions?: React.ReactNode
}) {
  const last = community.lastMessage
  const channel = community.channels.find(item => item.id === last?.channelId)
  const preview = last ? `${channel ? `#${channel.name} · ` : ""}${last.hidden ? "Message hidden by a moderator." : messagePreview(last, displayName)}` : `${community.effectiveMembers.length} members · ${community.channels.length} channels`
  const conversation: ConversationRecord = {
    id: community.id, name: community.name, kind: "group", members: community.effectiveMembers,
    unreadCount: community.unreadCount, lastMessage: last?.hidden ? { ...last, attachment: undefined, poll: undefined } : last,
    updatedAt: community.updatedAt, notificationMode: community.notificationMode, blocked: false, request: false, archived,
  }
  return <ConversationRow conversation={conversation} selected={selected} owner={owner} displayName={displayName} collapsed={collapsed}
    href={communityHref(community.id)} preview={preview} actions={actions}
    icon={<span className="flex size-8 shrink-0 items-center justify-center rounded-[4px] border border-border bg-background text-primary"><Hash className="size-4" aria-label="Community" /></span>} />
}

export function CommunityInboxActions({ community, archived, selected, onError, onNotice }: {
  community: CommunityRecord; archived: boolean; selected: boolean; onError: (message: string) => void; onNotice: (message: string) => void
}) {
  const api = useCommunities()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  async function run(action: () => Promise<unknown>, notice: string) {
    if (locked.current) return
    locked.current = true; setBusy(true); onError("")
    try { await action(); onNotice(notice) }
    catch (cause) { onError(cause instanceof Error ? cause.message : "This community could not be updated. Try again.") }
    finally { locked.current = false; setBusy(false) }
  }
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="mr-1 size-11 shrink-0 text-muted-foreground md:size-8" aria-label={`Options for ${community.name}`} title="Community options" aria-busy={busy} disabled={busy || !api.ready}>{busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}</Button></DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="[&_[role=menuitem]]:min-h-11">
      <DropdownMenuItem onSelect={() => void run(async () => { await api.archiveCommunity(community.id, !archived); if (!archived && selected) router.replace("/chat") }, archived ? "Community restored to your inbox." : "Community archived. Your membership and messages are saved.")}>{archived ? <ArchiveRestore /> : <Archive />}{archived ? "Restore to inbox" : "Archive community"}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuSub><DropdownMenuSubTrigger><Bell />Notifications</DropdownMenuSubTrigger><DropdownMenuSubContent><DropdownMenuRadioGroup value={community.notificationMode} onValueChange={mode => void run(() => api.setNotificationMode(community.id, mode as NotificationMode), "Community notifications updated.")}>
        <DropdownMenuRadioItem value="all">All messages</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="mentions">Mentions only</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="muted">Muted</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup></DropdownMenuSubContent></DropdownMenuSub>
    </DropdownMenuContent>
  </DropdownMenu>
}
