"use client"

import Link from "next/link"
import { Archive, BellOff, File, Mic, BarChart3, Users, UserRound, CheckCheck, Clock3, CircleAlert } from "lucide-react"
import { IdentityIcon } from "@/components/ui/identity-icon"
import type { ConversationRecord, MessageRecord } from "@/lib/messaging-types"
import { conversationHref } from "@/lib/conversation-route"

export function messagePreview(message?: MessageRecord): string {
  if (!message) return "Start a conversation"
  if (message.attachment?.kind === "voice") return message.content || "Voice message"
  if (message.attachment) return [message.attachment.name, message.content].filter(Boolean).join(" · ")
  if (message.poll) return `Poll: ${message.poll.question}`
  return message.content.replace(/\s+/g, " ").trim() || "Message"
}

function messageTime(timestamp: number) {
  const date = new Date(timestamp)
  if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return date.toLocaleDateString([], { month: "short", day: "numeric" })
}

export function ConversationRow({ conversation, selected, owner, actions, collapsed = false }: {
  conversation: ConversationRecord; selected: boolean; owner: string; actions?: React.ReactNode; collapsed?: boolean
}) {
  const last = conversation.lastMessage
  const outgoing = last?.senderPubKey === owner
  const groupStatus = conversation.kind === "group" && conversation.group && !conversation.members.includes(owner)
    ? conversation.members.length === 0 ? "Closed" : "Left group"
    : null
  const name = conversation.kind === "self" ? "Message yourself" : conversation.name
  const icon = conversation.kind === "group" ? <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Users className="size-4" /></span>
    : conversation.kind === "self" ? <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><UserRound className="size-4" /></span>
      : <IdentityIcon pubKey={conversation.id} size={32} />
  const rowStyle = selected ? "bg-primary/10 ring-1 ring-inset ring-primary/20" : "hover:bg-accent/80"
  if (collapsed) return <Link
    href={conversationHref(conversation.id)}
    aria-current={selected ? "page" : undefined}
    aria-label={`${name}${conversation.archived ? ", archived" : ""}${conversation.unreadCount > 0 ? `, ${conversation.unreadCount} unread messages` : ""}`}
    title={name}
    className={`relative flex size-11 shrink-0 items-center justify-center rounded-xl transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none ${rowStyle}`}
  >
    {icon}
    {conversation.unreadCount > 0 && <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-4 text-primary-foreground ring-2 ring-sidebar">{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</span>}
  </Link>
  return <div className={`group/row flex items-center gap-0.5 rounded-xl transition-colors motion-reduce:transition-none ${rowStyle}`}>
    <Link href={conversationHref(conversation.id)} aria-current={selected ? "page" : undefined} className="flex min-h-14 min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5"><span className={`truncate text-[13px] text-foreground ${conversation.unreadCount ? "font-semibold" : "font-medium"}`}>{name}</span>{conversation.archived && <Archive className="size-3 shrink-0 text-muted-foreground" aria-label="Archived" />}{conversation.notificationMode === "muted" && <BellOff className="size-3 shrink-0 text-muted-foreground" aria-label="Muted" />}<span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{last ? messageTime(last.timestamp) : ""}</span></span>
        <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          {groupStatus && <span className="shrink-0 text-[10px] text-amber-700 dark:text-amber-300">{groupStatus} ·</span>}
          {outgoing && last?.delivery === "pending" && <Clock3 className="size-3 shrink-0" aria-label="Queued" />}
          {(conversation.sendError || (outgoing && last?.delivery === "failed")) && <CircleAlert className="size-3 shrink-0 text-amber-700 dark:text-amber-300" aria-label="Delivery issue in this conversation" />}
          {outgoing && (last?.delivery === "delivered" || last?.delivery === "read") && <CheckCheck className={`size-3 shrink-0 ${last.delivery === "read" ? "text-primary" : ""}`} aria-label={last.delivery} />}
          {last?.attachment && (last.attachment.kind === "voice" ? <Mic className="size-3 shrink-0" /> : <File className="size-3 shrink-0" />)}
          {last?.poll && <BarChart3 className="size-3 shrink-0" />}
          <span className="truncate">{outgoing && conversation.kind !== "self" ? "You: " : ""}{last ? messagePreview(last) : conversation.kind === "self" ? "Send messages and files to yourself" : conversation.kind === "group" ? `${conversation.members.length} members` : "Start a conversation"}</span>
          {conversation.unreadCount > 0 && <span aria-label={`${conversation.unreadCount} unread messages`} className="ml-auto flex min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground">{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</span>}
        </span>
      </span>
    </Link>
    {actions}
  </div>
}
