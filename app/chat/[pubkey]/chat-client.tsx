"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Check, CheckCheck, Loader2, Lock, Send, Shield, RotateCw, ArrowDown, Search, X, ChevronUp, ChevronDown, Copy, Reply, Pencil, Pin, PinOff, Info, Users, BarChart3, AtSign, Bell, Ban, ExternalLink, MessageSquare } from "lucide-react"
import { useMessaging } from "@/components/messaging-provider"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { shortAddress, validateAddress } from "@/lib/identity"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"
import { useChatDraft } from "@/hooks/use-chat-draft"
import { useMentionDraft } from "@/hooks/use-mention-draft"
import { literalSearch } from "@/components/message-text"
import { type MessageRecord, type NotificationMode } from "@/lib/messaging-types"
import { AttachmentComposer } from "@/components/chat/attachment-composer"
import { AttachmentView } from "@/components/chat/attachment-view"
import { RichMessage } from "@/components/chat/rich-message"
import { sendAttachment } from "@/lib/attachments"
import { findMentionQuery, insertMention, updateMentionSpans, validMentionSpans, type MentionQuery } from "@/lib/composer-mentions"
import { EditMessageDialog, GroupSettings, PollCard, PollCreator } from "@/components/chat/conversation-controls"

const messageSummary = (message: MessageRecord) => message.content || message.poll?.question || message.attachment?.name || "Message"
const searchableText = (message: MessageRecord) => [message.content, message.attachment?.name, message.poll?.question, ...(message.poll?.options || [])].filter(Boolean).join(" ")
const errorText = (error: unknown) => error instanceof Error ? error.message : "That action could not be completed. Try again."
function extractLinks(content: string) {
  return [...new Set((content.match(/https?:\/\/[^\s<>"`]+/g) || []).map(value => value.replace(/[.,;!?)\]}]+$/, "")))].filter(value => {
    try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" } catch { return false }
  })
}

export default function ChatWindow({ params }: { params: { pubkey: string } }) {
  const messaging = useMessaging()
  const { identity, ready, error, status, contacts, preferences, markRead } = messaging
  const myPub = identity?.publicKey || ""
  const conversationId = params.pubkey
  const conversation = messaging.conversations.find(item => item.id === conversationId)
  const group = messaging.groups.find(item => item.id === conversationId)
  const isSelf = conversationId === myPub
  const isGroup = conversationId.startsWith("group:")
  const activeMembers = conversation?.members || group?.members || []
  const blocked = conversation?.blocked || preferences.blocked.includes(conversationId)
  const request = conversation?.request || false
  const leftGroup = isGroup && !!group && !activeMembers.includes(myPub)
  const closedGroup = isGroup && !!group && activeMembers.length === 0
  const membershipUpdating = isGroup && !!group && !leftGroup && group.members.length !== activeMembers.length
  const usable = ready && !blocked && !request && !membershipUpdating && (!isGroup || (!!group && !leftGroup))
  const title = isSelf ? "You" : group?.name || conversation?.name || contacts.find(contact => contact.pub === conversationId)?.alias || (isGroup ? "Group conversation" : shortAddress(conversationId))
  const displayName = (pub: string) => pub === myPub ? "You" : contacts.find(contact => contact.pub === pub)?.alias || shortAddress(pub)
  const messages = useMemo(() => messaging.messages.filter(message => message.conversationId === conversationId), [messaging.messages, conversationId])
  const byId = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages])
  const pinned = messages.filter(message => message.pinned)
  const files = messages.filter(message => message.attachment)
  const sharedLinks = useMemo(() => messages.flatMap(message => extractLinks(message.content).map(url => ({ url, message }))).reverse(), [messages])
  const { content, setContent, clearSubmittedDraft, retryDraftSave, draftReady, draftSaved, draftIssue } = useChatDraft(myPub, conversationId)
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [sendError, setSendError] = useState("")
  const [retrying, setRetrying] = useState<string | null>(null)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [unseen, setUnseen] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matchIndex, setMatchIndex] = useState(0)
  const [copiedMessage, setCopiedMessage] = useState("")
  const [announcement, setAnnouncement] = useState("")
  const [replyTo, setReplyTo] = useState<string | undefined>()
  const [editing, setEditing] = useState<MessageRecord | null>(null)
  const [pollOpen, setPollOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [infoTab, setInfoTab] = useState<"settings" | "files" | "links" | "pins">("settings")
  const [mentionOpen, setMentionOpen] = useState(false)
  const { mentionSpans, saveMentionDraft } = useMentionDraft(myPub, conversationId, content, draftReady)
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const chatRoot = useRef<HTMLDivElement>(null)
  const pendingMentionEdit = useRef<{ before: string; start: number; end: number } | null>(null)
  const [highlightedId, setHighlightedId] = useState("")
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seenIds = useRef<Set<string> | null>(null)
  const messageNodes = useRef(new Map<string, HTMLDivElement>())
  const searchInput = useRef<HTMLInputElement>(null)
  const messagesViewport = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const sendLock = useRef(false)
  const actionScope = useRef<object | null>(null)
  const searchTerm = query.trim()
  const matches = useMemo(() => {
    const pattern = literalSearch(searchTerm)
    return pattern ? messages.filter(message => pattern.test(searchableText(message))).map(message => message.id) : []
  }, [messages, searchTerm])
  const selectedIndex = matches.length ? Math.min(matchIndex, matches.length - 1) : 0
  const activeMatch = matches[selectedIndex]
  const unconfirmed = messages.filter(message => message.senderPubKey === myPub && message.delivery === "failed")
  const sending = busy || retrying !== null || batchProgress !== null
  const notificationMode = preferences.notifications[conversationId] || "all"
  const mentionMembers = (isGroup ? activeMembers : (isSelf ? [] : [conversationId])).filter(pub => pub !== myPub)
  const mentions = [...new Set(validMentionSpans(content, mentionSpans).map(span => span.publicKey))].filter(pub => mentionMembers.includes(pub))
  const mentionCandidates = mentionMembers.filter(pub => !mentions.includes(pub)
    && (!mentionQuery?.query || displayName(pub).toLocaleLowerCase().includes(mentionQuery.query.toLocaleLowerCase()) || pub.includes(mentionQuery.query.toLowerCase())))
  const selectedMentionIndex = Math.min(mentionIndex, Math.max(0, mentionCandidates.length - 1))

  function updateMentionQuery(value: string, start: number, end = start) {
    const query = findMentionQuery(value, start, end)
    const withinMention = validMentionSpans(value, mentionSpans).some(span => start > span.start && start <= span.end)
    setMentionQuery(query); setMentionIndex(0); setMentionOpen(!isSelf && !!query && !withinMention)
  }
  function changeMessage(value: string, start: number, end = start) {
    const edit = pendingMentionEdit.current
    pendingMentionEdit.current = null
    const nextSpans = updateMentionSpans(content, value, mentionSpans, edit?.before === content ? edit : undefined)
    setContent(value)
    saveMentionDraft(value, nextSpans)
    updateMentionQuery(value, start, end)
  }
  function chooseMention(pub: string) {
    const node = input.current
    if (!node || !usable || busy) return
    const range = mentionQuery || { start: node.selectionStart, end: node.selectionEnd }
    const result = insertMention(content, range, pub, displayName(pub))
    if (result.content.length > MAX_MESSAGE_LENGTH) { setSendError("There is not enough room for this mention. Shorten the message first."); return }
    const nextSpans = [...updateMentionSpans(content, result.content, mentionSpans, range), result.span]
    setContent(result.content); saveMentionDraft(result.content, nextSpans); setMentionOpen(false); setMentionQuery(null)
    requestAnimationFrame(() => { node.focus(); node.setSelectionRange(result.caret, result.caret) })
  }
  function removeMention(pub: string) {
    if (busy) return
    let next = content, spans = mentionSpans
    for (const span of validMentionSpans(content, mentionSpans).filter(item => item.publicKey === pub).sort((a, b) => b.start - a.start)) {
      const changed = next.slice(0, span.start) + next.slice(span.end)
      spans = updateMentionSpans(next, changed, spans, { start: span.start, end: span.end })
      next = changed
    }
    setContent(next); saveMentionDraft(next, spans); setMentionOpen(false)
    input.current?.focus()
  }

  const incomingLatest = messages.filter(message => message.senderPubKey !== myPub).at(-1)?.timestamp || 0

  useEffect(() => {
    const node = input.current
    if (!node) return
    const beforeInput = (event: Event) => {
      const kind = (event as InputEvent).inputType
      // Undo, autocorrect and composition can edit somewhere other than the caret.
      // Let the conservative text diff handle them rather than guessing a recipient.
      if (!["insertText", "insertFromPaste", "insertFromDrop", "deleteByCut", "deleteContentBackward", "deleteContentForward"].includes(kind)) {
        pendingMentionEdit.current = null; return
      }
      let start = node.selectionStart, end = node.selectionEnd
      if (start === end && kind?.startsWith("delete")) {
        if (kind === "deleteContentBackward") start -= Array.from(node.value.slice(0, start)).at(-1)?.length || 0
        else if (kind === "deleteContentForward") end += Array.from(node.value.slice(end))[0]?.length || 0
        else { pendingMentionEdit.current = null; return }
      }
      pendingMentionEdit.current = { before: node.value, start, end }
    }
    node.addEventListener("beforeinput", beforeInput)
    return () => node.removeEventListener("beforeinput", beforeInput)
  }, [])
  useEffect(() => () => { clearTimeout(copyTimer.current); clearTimeout(highlightTimer.current) }, [])
  useEffect(() => {
    const scope = {}
    actionScope.current = scope; sendLock.current = false; seenIds.current = null; nearBottom.current = true
    setBusy(false); setRetrying(null); setBatchProgress(null); setSendError(""); setReplyTo(undefined)
    return () => { if (actionScope.current === scope) actionScope.current = null }
  }, [myPub, conversationId])
  useEffect(() => {
    const node = input.current
    if (node) { node.style.height = "auto"; node.style.height = Math.min(node.scrollHeight, 176) + "px" }
  }, [content, ready])
  const acknowledgeVisible = useCallback(() => {
    if (ready && !request && document.visibilityState === "visible" && document.hasFocus() && nearBottom.current && !window.location.hash) {
      void markRead(conversationId).catch(cause => setSendError(errorText(cause)))
    }
  }, [ready, request, markRead, conversationId])
  useEffect(() => {
    if (incomingLatest > (preferences.readAt[conversationId] || 0)) acknowledgeVisible()
    window.addEventListener("focus", acknowledgeVisible)
    document.addEventListener("visibilitychange", acknowledgeVisible)
    return () => { window.removeEventListener("focus", acknowledgeVisible); document.removeEventListener("visibilitychange", acknowledgeVisible) }
  }, [acknowledgeVisible, incomingLatest, preferences.readAt, conversationId])
  useEffect(() => {
    if (!ready) return
    const ids = new Set(messages.map(message => message.id))
    if (seenIds.current) {
      const added = messages.filter(message => message.senderPubKey !== myPub && !seenIds.current!.has(message.id)).length
      if (added) {
        if (!nearBottom.current) setUnseen(previous => previous + added)
        setAnnouncement(`${added} new message${added === 1 ? "" : "s"} received.`)
      }
    }
    seenIds.current = ids
    if (nearBottom.current && !searchTerm && !window.location.hash && messagesViewport.current) messagesViewport.current.scrollTop = messagesViewport.current.scrollHeight
  }, [messages, ready, myPub, searchTerm])
  const jumpToMessage = useCallback((id: string) => {
    const viewport = messagesViewport.current
    const message = messageNodes.current.get(id)
    if (!viewport || !message) return
    nearBottom.current = false; setAwayFromBottom(true)
    const viewportRect = viewport.getBoundingClientRect(), messageRect = message.getBoundingClientRect()
    viewport.scrollTop += messageRect.top - viewportRect.top - (viewport.clientHeight - messageRect.height) / 2
    clearTimeout(highlightTimer.current); setHighlightedId(id)
    highlightTimer.current = setTimeout(() => setHighlightedId(""), 4000)
  }, [])
  useEffect(() => { if (activeMatch) jumpToMessage(activeMatch) }, [activeMatch, searchTerm, jumpToMessage])
  useEffect(() => {
    const visitHash = () => {
      const hash = window.location.hash
      if (hash.startsWith("#message-")) jumpToMessage(hash.slice(9))
    }
    visitHash(); window.addEventListener("hashchange", visitHash)
    return () => window.removeEventListener("hashchange", visitHash)
  }, [conversationId, ready, messages.length, jumpToMessage])
  useEffect(() => { if (searchOpen) searchInput.current?.focus() }, [searchOpen])
  const jumpToLatest = () => {
    setQuery(""); nearBottom.current = true; setAwayFromBottom(false); setUnseen(0)
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
    if (messagesViewport.current) messagesViewport.current.scrollTop = messagesViewport.current.scrollHeight
    acknowledgeVisible()
  }
  const moveMatch = (direction: number) => { if (matches.length) setMatchIndex((selectedIndex + direction + matches.length) % matches.length) }
  const act = async (action: () => Promise<unknown>, success?: string) => {
    if (actionBusy) return
    setActionBusy(true); setSendError("")
    try { await action(); if (success) setAnnouncement(success) } catch (cause) { setSendError(errorText(cause)) }
    finally { setActionBusy(false) }
  }
  const submit = async () => {
    const scope = actionScope.current
    if (!scope || !content.trim() || sendLock.current || !usable || !draftReady) return
    sendLock.current = true; setBusy(true); setSendError(""); jumpToLatest()
    try {
      await messaging.sendText(conversationId, content, replyTo, mentions)
      clearSubmittedDraft()
      if (actionScope.current === scope) { setReplyTo(undefined); setMentionOpen(false) }
    } catch (cause) { if (actionScope.current === scope) setSendError(errorText(cause)) }
    finally { if (actionScope.current === scope) { sendLock.current = false; setBusy(false); input.current?.focus() } }
  }
  const retryFailed = async (snapshot: MessageRecord[], batch = false) => {
    const scope = actionScope.current
    if (!scope || sendLock.current || !ready || !snapshot.length) return
    sendLock.current = true; setSendError("")
    try {
      for (let index = 0; index < snapshot.length; index++) {
        if (actionScope.current !== scope) return
        setRetrying(snapshot[index].id)
        if (batch) setBatchProgress({ current: index + 1, total: snapshot.length })
        await messaging.retry(snapshot[index].id)
      }
      if (actionScope.current === scope && batch) setAnnouncement(`Retried ${snapshot.length} messages.`)
    } catch (cause) { if (actionScope.current === scope) setSendError(errorText(cause)) }
    finally { if (actionScope.current === scope) { sendLock.current = false; setRetrying(null); setBatchProgress(null) } }
  }
  const attachmentView = (message: MessageRecord) => message.attachment && <AttachmentView metadata={message.attachment} chunks={messaging.getAttachmentChunks(conversationId, message.id)} />
  const openMessageFromInfo = (id: string) => { setInfoOpen(false); requestAnimationFrame(() => jumpToMessage(id)) }
  const statusLabel = { connecting: "Connecting…", online: "Connected", offline: "Offline · messages queue" }[status]
  return <div ref={chatRoot} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className="flex min-h-20 shrink-0 items-center justify-between gap-2 border-b border-zinc-800/80 px-3 py-4 sm:px-7">
      <div className="flex min-w-0 items-center gap-3"><Link href="/chat" aria-label="Back to conversations" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 md:hidden"><ArrowLeft className="size-5" /></Link>{isGroup ? <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo-400/10 text-indigo-200"><Users className="size-5" /></span> : <span className="hidden shrink-0 sm:block"><IdentityIcon pubKey={conversationId} size={38} /></span>}<div className="min-w-0"><h1 className="truncate font-sans text-base font-medium">{title}{isSelf && <span className="ml-2 text-xs font-normal text-zinc-500">yourself</span>}</h1><span className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500"><Lock className="size-3 shrink-0" /><span className="truncate">{isGroup ? `${activeMembers.length} members · Encrypted` : "End-to-end encrypted"}</span></span></div></div>
      <div className="flex shrink-0 items-center gap-1"><span role="status" className={`mr-2 hidden rounded-lg border px-2.5 py-1.5 text-xs lg:inline ${status === "offline" ? "border-amber-400/20 text-amber-300" : "border-zinc-800 text-zinc-400"}`}>{statusLabel}</span><Button variant="ghost" size="icon" aria-label="Search conversation" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(""); setMatchIndex(0) }}><Search className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Conversation details, files and settings" onClick={() => { setInfoTab("settings"); setInfoOpen(true) }}><Info className="size-4" /></Button></div>
    </header>
    {searchOpen && <div role="search" aria-label="Search saved messages" className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3 sm:px-7"><Input ref={searchInput} aria-label="Search messages" placeholder="Search this conversation…" className="min-w-32 flex-1" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { setSearchOpen(false); setQuery(""); input.current?.focus() } else if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) } }} /><span role="status" className="text-xs text-zinc-400">{searchTerm ? matches.length ? `${selectedIndex + 1} of ${matches.length}` : "No matches" : "Saved messages"}</span><Button variant="ghost" size="icon" aria-label="Previous match" disabled={!matches.length} onClick={() => moveMatch(-1)}><ChevronUp className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Next match" disabled={!matches.length} onClick={() => moveMatch(1)}><ChevronDown className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery(""); input.current?.focus() }}><X className="size-4" /></Button></div>}
    {(error || sendError) && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-400/10 bg-amber-400/5 px-5 py-3 text-sm text-amber-200"><p role="alert" className="min-w-0 flex-1">{sendError || error}</p><Button type="button" size="sm" variant="outline" disabled={sending || actionBusy} onClick={() => void act(() => messaging.sync())}><RotateCw className="size-4" />Reconnect</Button><Button size="icon" variant="ghost" aria-label="Dismiss message error" disabled={!sendError} onClick={() => setSendError("")}><X className="size-4" /></Button></div>}
    {request && !blocked && <div className="flex flex-wrap items-center gap-3 border-b border-indigo-400/20 bg-indigo-400/5 p-4 text-sm"><p className="min-w-40 flex-1">{isGroup ? "You have been invited to this group." : "This person is not in your accepted conversations."} Accept to reply.</p><Button size="sm" disabled={actionBusy} onClick={() => void act(() => messaging.acceptRequest(conversationId))}>Accept</Button>{!isGroup && <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => void act(() => messaging.blockContact(conversationId))}>Block</Button>}</div>}
    {blocked && <div className="flex items-center justify-between gap-3 border-b border-zinc-800 p-4 text-sm text-zinc-400"><span>{isGroup ? "This group’s administrator is blocked." : "This person is blocked."}</span><Button size="sm" variant="outline" disabled={actionBusy || (isGroup && !group)} onClick={() => void act(() => messaging.blockContact(isGroup ? group!.admin : conversationId, false))}>Unblock</Button></div>}
    {pinned.length > 0 && <button type="button" className="flex items-center gap-2 border-b border-zinc-800 px-5 py-2.5 text-left text-xs text-indigo-200 hover:bg-zinc-900" onClick={() => { setInfoTab("pins"); setInfoOpen(true) }}><Pin className="size-3.5 shrink-0" /><span className="shrink-0">{pinned.length} pinned</span><span className="truncate text-zinc-500">{messageSummary(pinned.at(-1)!)}</span></button>}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div ref={messagesViewport} role="region" aria-label="Conversation messages" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-8" onScroll={event => { const node = event.currentTarget; const wasNearBottom = nearBottom.current; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; setAwayFromBottom(!nearBottom.current); if (nearBottom.current) { setUnseen(0); if (!wasNearBottom) acknowledgeVisible() } }}>
      <div className="mx-auto max-w-3xl space-y-5"><div className="mx-auto max-w-sm py-7 text-center">{isSelf ? <MessageSquare className="mx-auto mb-3 size-8 text-indigo-300/60" /> : <Shield className="mx-auto mb-3 size-8 text-indigo-300/60" />}<h2 className="mb-2 text-xl text-zinc-300">{isSelf ? "Send things to yourself." : isGroup ? title : messages.length ? "Your conversation" : "Start with a hello."}</h2><p className="text-sm leading-relaxed text-zinc-500">{isSelf ? "Send yourself messages, files, voice notes and links, just like any other conversation." : isGroup ? "A shared conversation with your group. Messages are encrypted before leaving your device." : "Verify this contact’s address through another trusted channel. Messages are encrypted before leaving your device."}</p>{!isGroup && <details className="mt-3 text-xs text-zinc-500"><summary className="cursor-pointer">{isSelf ? "Your address" : "Contact address"}</summary><p className="mt-2 select-all break-all font-mono leading-relaxed">{conversationId}</p></details>}</div>
        {!ready && <p role="status" className="flex justify-center gap-2 py-5 text-sm text-zinc-400"><Loader2 className="size-4 animate-spin" />Opening conversation…</p>}
        {ready && isGroup && !group && <p role="status" className="rounded-xl border border-zinc-800 p-5 text-center text-sm text-zinc-400">This group is not saved on this device. Ask a group member for an invitation, or restore your chat backup.</p>}
        {messages.map((message, index) => {
          const mine = message.senderPubKey === myPub
          const day = new Date(message.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          const previousDay = index ? new Date(messages[index - 1].timestamp).toDateString() : ""
          const quoted = message.replyTo ? byId.get(message.replyTo) : undefined
          return <div key={message.id} id={`message-${message.id}`} ref={node => { if (node) messageNodes.current.set(message.id, node); else messageNodes.current.delete(message.id) }} className={activeMatch === message.id || highlightedId === message.id ? "rounded-xl ring-2 ring-amber-300/60 ring-offset-4 ring-offset-zinc-950" : ""}>{previousDay !== new Date(message.timestamp).toDateString() && <p className="mb-5 text-center text-xs text-zinc-600">{day}</p>}<div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
            {isGroup && !mine && <p className="mb-1.5 ml-1 text-xs text-indigo-200">{displayName(message.senderPubKey)}</p>}<span className="sr-only">{displayName(message.senderPubKey)}:</span>
            <div className={`min-w-0 max-w-[94%] break-words rounded-2xl px-4 py-3 text-base leading-relaxed [overflow-wrap:anywhere] sm:max-w-[85%] ${mine ? "rounded-br-md bg-indigo-100 text-zinc-950" : "rounded-bl-md border border-zinc-800 bg-zinc-900 text-zinc-200"}`}>
              {message.replyTo && <button type="button" disabled={!quoted} aria-label={quoted ? "Jump to replied message" : "Original message is unavailable"} className="mb-3 block w-full rounded-r border-l-2 border-current/40 bg-current/5 px-3 py-1.5 text-left text-xs" onClick={() => { if (quoted) jumpToMessage(quoted.id) }}><span className="block font-medium">{quoted ? displayName(quoted.senderPubKey) : "Reply"}</span><span className="line-clamp-2 opacity-70">{quoted ? messageSummary(quoted) : "Original message is not saved on this device."}</span></button>}
              {message.content && !message.poll && <RichMessage text={message.content} highlight={searchTerm} />}
              {message.attachment && attachmentView(message)}
              {message.poll && <PollCard question={message.poll.question} options={message.poll.options.map((text, i) => ({ id: String(i), text }))} votes={Object.fromEntries(Object.entries(message.poll.votes).map(([pub, option]) => [pub, String(option)]))} myPub={myPub} disabled={!usable} onVote={option => messaging.vote(conversationId, message.id, Number(option))} />}
              {!!message.mentions?.length && <p className="mt-2 text-xs opacity-65">Mentioned: {message.mentions.map(displayName).join(", ")}</p>}
            </div>
            <div className="mt-1.5 flex max-w-full flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400"><time title={new Date(message.timestamp).toLocaleString()} dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{message.editedAt && <span title={`Edited ${new Date(message.editedAt).toLocaleString()}`}>edited</span>}{message.pinned && <Pin aria-label="Pinned message" className="size-3 text-indigo-200" />}
              {mine && (isSelf ? <span className="flex items-center gap-1"><Check className="size-3" />Saved</span> : message.delivery === "failed" ? <button type="button" disabled={sending || !ready} title={message.error} className="flex min-h-7 items-center gap-1 rounded px-1 text-red-300 hover:text-red-200 disabled:opacity-50" onClick={() => void retryFailed([message])}><RotateCw className={`size-3 ${retrying === message.id ? "animate-spin" : ""}`} />{retrying === message.id ? "Retrying" : "Failed · Retry"}</button> : <span className="flex items-center gap-1" title={message.delivery === "sent" ? "Accepted by the encrypted relay; no recipient receipt yet." : message.delivery === "delivered" ? `Received by ${message.deliveredTo.length || 1} recipient(s).` : message.delivery === "read" ? `Read by ${message.readBy.length || 1} recipient(s).` : "Waiting to reach the relay."}>{message.delivery === "pending" ? <Loader2 className="size-3 animate-spin" /> : message.delivery === "read" || message.delivery === "delivered" ? <CheckCheck className={`size-3 ${message.delivery === "read" ? "text-indigo-300" : ""}`} /> : <Check className="size-3" />}{({ pending: "Queued", sent: "Sent", delivered: "Delivered", read: "Read", received: "Received", failed: "Failed" })[message.delivery]}{isGroup && message.delivery === "read" ? ` · ${message.readBy.length}` : isGroup && message.delivery === "delivered" ? ` · ${message.deliveredTo.length}` : ""}</span>)}
              <button type="button" className="inline-flex min-h-7 items-center gap-1 rounded px-1 hover:text-zinc-200" aria-label={copiedMessage === message.id ? "Message copied" : "Copy message"} onClick={async () => { try { await navigator.clipboard.writeText(messageSummary(message)); clearTimeout(copyTimer.current); setCopiedMessage(message.id); setAnnouncement("Message copied."); copyTimer.current = setTimeout(() => setCopiedMessage(""), 2500) } catch { setSendError("Clipboard access was blocked. Select the message text to copy it.") } }}>{copiedMessage === message.id ? <Check className="size-3" /> : <Copy className="size-3" />}{copiedMessage === message.id ? "Copied" : "Copy"}</button>
              <button type="button" disabled={!usable} className="inline-flex min-h-7 items-center gap-1 rounded px-1 hover:text-zinc-200 disabled:opacity-40" onClick={() => { setReplyTo(message.id); input.current?.focus() }}><Reply className="size-3" />Reply</button>
              {mine && !!message.content && !message.attachment && !message.poll && <button type="button" disabled={!usable || actionBusy} className="inline-flex min-h-7 items-center gap-1 rounded px-1 hover:text-zinc-200 disabled:opacity-40" onClick={() => setEditing(message)}><Pencil className="size-3" />Edit</button>}
              <button type="button" disabled={!usable || actionBusy} className="inline-flex min-h-7 items-center gap-1 rounded px-1 hover:text-zinc-200 disabled:opacity-40" onClick={() => void act(() => messaging.pinMessage(conversationId, message.id, !message.pinned), message.pinned ? "Message unpinned." : "Message pinned.")}>{message.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}{message.pinned ? "Unpin" : "Pin"}</button>
            </div>
          </div></div>
        })}
      </div>
    </div>
    {(awayFromBottom || unseen > 0) && <div className="flex justify-center border-t border-zinc-800/60 py-2"><Button variant="secondary" size="sm" className="rounded-full" onClick={jumpToLatest}><ArrowDown className="size-4" /><span aria-live="polite">{unseen ? `${unseen} new message${unseen === 1 ? "" : "s"}` : "Jump to latest"}</span></Button></div>}
    <footer className="max-h-[55dvh] shrink-0 overflow-y-auto border-t border-zinc-800/80 bg-zinc-950 p-3 sm:px-8 sm:py-4">
      {leftGroup && <p className="mx-auto mb-3 max-w-3xl text-sm text-zinc-400">{closedGroup ? "This group is closed. Saved messages are still available." : "You are no longer a member of this group. Your saved conversation is still available."}</p>}
      {membershipUpdating && <p className="mx-auto mb-3 max-w-3xl text-sm text-zinc-400">Updating group membership before sending more messages…</p>}
      {(unconfirmed.length > 1 || batchProgress) && <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-2 text-xs text-amber-200"><span role="status">{batchProgress ? `Retrying ${batchProgress.current} of ${batchProgress.total}…` : `${unconfirmed.length} messages need another attempt.`}</span><Button type="button" size="sm" variant="outline" disabled={!ready || sending} onClick={() => void retryFailed(unconfirmed, true)}><RotateCw className={`size-3 ${batchProgress ? "animate-spin" : ""}`} />{batchProgress ? "Retrying…" : "Retry failed messages"}</Button></div>}
      <div className="mx-auto max-w-3xl">
        {replyTo && <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-indigo-300 bg-zinc-900 p-2 text-xs"><Reply className="size-4 shrink-0 text-indigo-300" /><span className="min-w-0 flex-1"><span className="block text-indigo-200">Replying to {byId.get(replyTo) ? displayName(byId.get(replyTo)!.senderPubKey) : "message"}</span><span className="block truncate text-zinc-400">{byId.get(replyTo) ? messageSummary(byId.get(replyTo)!) : "Original message"}</span></span><Button variant="ghost" size="icon" aria-label="Cancel reply" onClick={() => setReplyTo(undefined)}><X className="size-4" /></Button></div>}
        <form onSubmit={event => { event.preventDefault(); void submit() }}><div className="flex items-end gap-2 rounded-xl border border-zinc-700 bg-zinc-900 p-2 focus-within:border-indigo-300/60"><Textarea ref={input} aria-label="Message" aria-busy={busy} placeholder={blocked ? "Unblock this person to send messages" : request ? "Accept this conversation to reply" : closedGroup ? "This group is closed" : leftGroup ? "You left this group" : membershipUpdating ? "Updating group membership…" : ready ? isSelf ? "Send yourself a message…" : "Write a message…" : "Opening conversation…"} value={content} onChange={event => changeMessage(event.target.value, event.target.selectionStart, event.target.selectionEnd)} onSelect={event => { const node = event.currentTarget; if (document.activeElement === node) updateMentionQuery(node.value, node.selectionStart, node.selectionEnd) }} onBlur={() => setMentionOpen(false)} aria-autocomplete="list" aria-controls={mentionOpen ? "message-mention-options" : undefined} aria-activedescendant={mentionOpen && mentionCandidates.length ? `message-mention-${selectedMentionIndex}` : undefined} maxLength={MAX_MESSAGE_LENGTH} disabled={!usable || !draftReady} readOnly={busy} rows={2} className="max-h-44 min-h-12 resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0" onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (mentionOpen) {
            if (event.key === "Escape") { event.preventDefault(); setMentionOpen(false); return }
            if (mentionCandidates.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setMentionIndex((selectedMentionIndex + (event.key === "ArrowDown" ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length); return }
            if (mentionCandidates.length && ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab")) { event.preventDefault(); chooseMention(mentionCandidates[selectedMentionIndex]); return }
          }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit() }
        }} /><Button type="submit" aria-label="Send message" disabled={!usable || !draftReady || !content.trim() || sending} size="icon" className="mb-1 mr-1 shrink-0">{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button></div></form>
        <div className="mt-2 flex flex-wrap items-center gap-1"><Button type="button" variant="ghost" size="sm" disabled={!usable} onClick={() => setPollOpen(true)}><BarChart3 className="size-4" />Poll</Button>{!isSelf && <Button type="button" variant="ghost" size="sm" disabled={!usable} aria-expanded={mentionOpen} onClick={() => { setMentionQuery(findMentionQuery(content, input.current?.selectionStart ?? content.length, input.current?.selectionEnd ?? content.length)); setMentionIndex(0); setMentionOpen(!mentionOpen) }}><AtSign className="size-4" />Mention</Button>}<span className="ml-auto text-[11px] text-zinc-500">Math: $…$ · Code: ```</span></div>
        {mentionOpen && <div id="message-mention-options" role="listbox" aria-label="Mention suggestions" className="mb-2 max-h-48 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-1 text-sm">
          {mentionCandidates.map((pub, index) => <button type="button" role="option" id={`message-mention-${index}`} aria-selected={index === selectedMentionIndex} key={pub} onMouseDown={event => event.preventDefault()} onClick={() => chooseMention(pub)} className={`flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left ${index === selectedMentionIndex ? "bg-indigo-400/15 text-indigo-100" : "text-zinc-300 hover:bg-zinc-800"}`}><span>@{displayName(pub)}</span><span className="font-mono text-xs text-zinc-500">{shortAddress(pub)}</span></button>)}
          {!mentionCandidates.length && <p className="px-3 py-2 text-xs text-zinc-400">{mentionQuery?.query ? "No matching members." : "Everyone is already mentioned."}</p>}
        </div>}
        {mentions.length > 0 && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">{mentions.map(pub => <button type="button" key={pub} aria-label={`Remove mention of ${displayName(pub)}`} disabled={busy} onClick={() => removeMention(pub)} className="inline-flex items-center gap-1 rounded-full bg-indigo-400/15 px-2 py-1 text-indigo-200">@{displayName(pub)}<X className="size-3" /></button>)}</div>}
        <AttachmentComposer captureRef={chatRoot} pasteRef={input} disabled={!usable || sending} onSend={async (file, kind, onProgress) => { const scope = actionScope.current; const id = await sendAttachment(messaging.sendEvent, conversationId, file, kind, onProgress, replyTo); if (actionScope.current === scope) { setReplyTo(undefined); jumpToLatest() } return id }} />
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-[11px] text-zinc-500"><span>Enter to send · Shift + Enter for a new line</span><span className={!draftSaved ? "text-amber-300" : ""}>{!draftSaved ? draftIssue === "read" ? "Saved draft could not be loaded" : draftIssue === "clear" ? "Sent text is waiting to be cleared from storage" : "Draft is only in this tab · Do not close it" : content ? "Draft saved on this browser" : "History saved on this browser"}</span></div>{!draftSaved && <Button type="button" size="sm" variant="ghost" onClick={retryDraftSave}>{draftIssue === "read" ? "Try loading draft again" : draftIssue === "clear" ? "Retry draft cleanup" : "Try saving draft again"}</Button>}{content.length > MAX_MESSAGE_LENGTH - 1000 && <p className="mt-1 text-right text-xs text-zinc-500">{content.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}</p>}
      </div>
    </footer>
    <PollCreator open={pollOpen} onOpenChange={setPollOpen} onCreate={async (question, options) => { await messaging.createPoll(conversationId, question, options); jumpToLatest() }} />
    <EditMessageDialog message={editing} onClose={() => setEditing(null)} onSave={(id, value) => messaging.editMessage(conversationId, id, value)} />
    <Dialog open={infoOpen} onOpenChange={setInfoOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Conversation settings and everything shared here.</DialogDescription></DialogHeader><div role="tablist" aria-label="Conversation details" className="grid grid-cols-4 gap-1 rounded-lg bg-zinc-900 p-1">{([['settings', 'Settings'], ['files', 'Files'], ['links', 'Links'], ['pins', 'Pinned']] as const).map(([tab, label]) => <button key={tab} type="button" id={`details-tab-${tab}`} role="tab" aria-selected={infoTab === tab} tabIndex={infoTab === tab ? 0 : -1} aria-controls={`details-panel-${tab}`} onKeyDown={event => { const tabs = ["settings", "files", "links", "pins"] as const; const index = tabs.indexOf(tab); const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null; if (next) { event.preventDefault(); setInfoTab(next); document.getElementById(`details-tab-${next}`)?.focus() } }} onClick={() => setInfoTab(tab)} className={`rounded-md px-2 py-2 text-sm ${infoTab === tab ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>{label}</button>)}</div><div role="tabpanel" id={`details-panel-${infoTab}`} aria-labelledby={`details-tab-${infoTab}`} className="min-h-32 space-y-4">
      {infoTab === "files" && (files.length ? [...files].reverse().map(message => <div key={message.id} className="space-y-2 rounded-xl border border-zinc-800 p-3">{attachmentView(message)}<button type="button" className="text-xs text-indigo-300 hover:underline" onClick={() => openMessageFromInfo(message.id)}>View message · {new Date(message.timestamp).toLocaleDateString()}</button></div>) : <p className="py-8 text-center text-sm text-zinc-500">Files and voice messages will appear here.</p>)}
      {infoTab === "links" && (sharedLinks.length ? sharedLinks.map(({ url, message }, index) => <div key={`${message.id}:${index}`} className="space-y-2 rounded-xl border border-zinc-800 p-3"><a href={url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 break-all text-sm text-indigo-200 hover:underline"><ExternalLink className="mt-0.5 size-4 shrink-0" />{url}</a><button type="button" className="text-xs text-zinc-400 hover:text-zinc-200" onClick={() => openMessageFromInfo(message.id)}>View message · {displayName(message.senderPubKey)}</button></div>) : <p className="py-8 text-center text-sm text-zinc-500">Links from this conversation will appear here.</p>)}
      {infoTab === "pins" && (pinned.length ? [...pinned].reverse().map(message => <div key={message.id} className="rounded-xl border border-zinc-800 p-3"><button type="button" className="w-full text-left" onClick={() => openMessageFromInfo(message.id)}><span className="text-xs text-indigo-300">{displayName(message.senderPubKey)}</span><p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-sm text-zinc-300">{messageSummary(message)}</p><span className="mt-2 block text-xs text-zinc-500">Jump to message</span></button><Button size="sm" variant="ghost" disabled={!usable || actionBusy} onClick={() => void act(() => messaging.pinMessage(conversationId, message.id, false))}><PinOff className="size-3" />Unpin</Button></div>) : <p className="py-8 text-center text-sm text-zinc-500">Pin a message to find it quickly here.</p>)}
      {infoTab === "settings" && <>
        {!isSelf && <div className="space-y-2"><Label htmlFor="conversation-notifications" className="flex items-center gap-2"><Bell className="size-4" />Notifications</Label><select id="conversation-notifications" value={notificationMode} disabled={actionBusy} onChange={event => void act(() => messaging.setNotificationMode(conversationId, event.target.value as NotificationMode))} className="h-10 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-sm"><option value="all">All messages</option><option value="mentions">Mentions only</option><option value="muted">Muted</option></select><p className="text-xs leading-relaxed text-zinc-500">Browser notifications work while Serotine is open. Enable them in the inbox settings.</p></div>}
        {isGroup && group && <GroupSettings groupName={group.name} members={activeMembers.map(pub => ({ pub, label: displayName(pub) }))} candidates={contacts.filter(contact => !activeMembers.includes(contact.pub)).map(contact => ({ pub: contact.pub, label: contact.alias || shortAddress(contact.pub) }))} canManage={group.admin === myPub && !membershipUpdating} left={leftGroup} ownerPub={group.admin} myPub={myPub} onRename={name => messaging.updateGroup(conversationId, { name })} onAdd={async pub => { const address = await validateAddress(pub); if (activeMembers.includes(address)) throw new Error("This person is already in the group."); await messaging.updateGroup(conversationId, { members: [...activeMembers, address] }) }} onRemove={pub => messaging.updateGroup(conversationId, { members: activeMembers.filter(member => member !== pub) })} onLeave={() => messaging.leaveGroup(conversationId)} />}
        {!isGroup && <div className="space-y-2"><p className="text-sm font-medium">{isSelf ? "Your address" : "Contact address"}</p><p className="select-all break-all rounded-lg bg-zinc-900 p-3 font-mono text-xs text-zinc-400">{conversationId}</p></div>}
        {!isGroup && !isSelf && <div className="border-t border-zinc-800 pt-4"><Button variant="outline" className="text-red-300" disabled={actionBusy} onClick={() => void act(() => messaging.blockContact(conversationId, !blocked))}><Ban className="size-4" />{blocked ? "Unblock contact" : "Block contact"}</Button><p className="mt-2 text-xs text-zinc-500">Blocking stops new direct messages from this address.</p></div>}
        {isSelf && <p className="text-sm leading-relaxed text-zinc-400">This is a conversation with your own address. Send messages, files and links here to keep them together.</p>}
      </>}
    </div>{sendError && <p role="alert" className="text-sm text-red-300">{sendError}</p>}</DialogContent></Dialog>
  </div>
}
