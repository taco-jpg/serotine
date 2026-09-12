"use client"

import Link from "next/link"
import { BellOff, File, Mic, BarChart3, Users, UserRound, CheckCheck, Clock3, CircleAlert } from "lucide-react"
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

export function ConversationRow({ conversation, selected, owner, actions }: {
  conversation: ConversationRecord; selected: boolean; owner: string; actions?: React.ReactNode
}) {
  const last = conversation.lastMessage
  const outgoing = last?.senderPubKey === owner
  return <div className={`flex items-center gap-0.5 rounded-xl transition-colors ${selected ? "bg-indigo-400/10 ring-1 ring-inset ring-indigo-400/20" : "hover:bg-zinc-900"}`}>
    <Link href={conversationHref(conversation.id)} aria-current={selected ? "page" : undefined} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3 focus-visible:outline focus-visible:outline-indigo-300">
      {conversation.kind === "group" ? <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-indigo-400/10 text-indigo-300"><Users className="size-5" /></span>
        : conversation.kind === "self" ? <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-indigo-400/10 text-indigo-300"><UserRound className="size-5" /></span>
          : <IdentityIcon pubKey={conversation.id} size={40} />}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2"><span className={`truncate text-sm ${conversation.unreadCount ? "font-semibold text-zinc-100" : "font-medium text-zinc-200"}`}>{conversation.kind === "self" ? "Message yourself" : conversation.name}</span>{conversation.notificationMode === "muted" && <BellOff className="size-3 shrink-0 text-zinc-500" aria-label="Muted" />}<span className="ml-auto shrink-0 text-[10px] text-zinc-500">{last ? messageTime(last.timestamp) : ""}</span></span>
        <span className="mt-1 flex items-center gap-1 text-xs text-zinc-500">
          {outgoing && last?.delivery === "pending" && <Clock3 className="size-3 shrink-0" aria-label="Queued" />}
          {outgoing && last?.delivery === "failed" && <CircleAlert className="size-3 shrink-0 text-amber-300" aria-label="Send failed" />}
          {outgoing && (last?.delivery === "delivered" || last?.delivery === "read") && <CheckCheck className={`size-3 shrink-0 ${last.delivery === "read" ? "text-indigo-300" : ""}`} aria-label={last.delivery} />}
          {last?.attachment && (last.attachment.kind === "voice" ? <Mic className="size-3 shrink-0" /> : <File className="size-3 shrink-0" />)}
          {last?.poll && <BarChart3 className="size-3 shrink-0" />}
          <span className="truncate">{outgoing && conversation.kind !== "self" ? "You: " : ""}{last ? messagePreview(last) : conversation.kind === "self" ? "Send messages and files to yourself" : conversation.kind === "group" ? `${conversation.members.length} members` : "Start a conversation"}</span>
          {conversation.unreadCount > 0 && <span aria-label={`${conversation.unreadCount} unread messages`} className="ml-auto flex min-w-5 shrink-0 items-center justify-center rounded-full bg-indigo-400 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-950">{conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}</span>}
        </span>
      </span>
    </Link>
    {actions}
  </div>
}
