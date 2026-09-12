"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Check, CheckCheck, Loader2, Lock, Send, Shield, RotateCw, ArrowDown, Search, X, ChevronUp, ChevronDown, Copy, Reply, Pencil, Pin, PinOff, Info, Users, BarChart3, AtSign, Bell, Ban, ExternalLink, MessageSquare, MoreHorizontal, Trash2, Timer, KeyRound, Plus } from "lucide-react"
import { useMessaging } from "@/components/messaging-provider"
import { ConversationActions } from "@/components/conversation-actions"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { QrCodeCard } from "@/components/qr-code"
import { shortAddress } from "@/lib/identity"
import { parseContactCode } from "@/lib/contact-code"
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
import { PrivateChatControls, ShareSecretDialog, privateDurationLabel } from "@/components/chat/private-chat-controls"
import { SecretMessage } from "@/components/chat/secret-message"

const messageSummary = (message: MessageRecord) => message.private ? message.secret ? "Private access key" : "Private message" : message.content || message.poll?.question || message.attachment?.name || "Message"
const searchableText = (message: MessageRecord) => message.private ? "" : [message.content, message.attachment?.name, message.poll?.question, ...(message.poll?.options || [])].filter(Boolean).join(" ")
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
  const deliveryError = conversation?.sendError
  const group = messaging.groups.find(item => item.id === conversationId)
  const isSelf = conversationId === myPub
  const isGroup = conversationId.startsWith("group:")
  const canUsePrivate = !isGroup && !isSelf
  const privateTtlSeconds = messaging.getPrivateMode(conversationId)
  const privateMode = canUsePrivate && privateTtlSeconds > 0
  const activeMembers = conversation?.members || []
  const unavailableGroup = isGroup && !conversation
  const blocked = conversation?.blocked || preferences.blocked.includes(conversationId)
  const request = conversation?.request || false
  const leftGroup = isGroup && !!conversation && !!group && !activeMembers.includes(myPub)
  const closedGroup = isGroup && !!conversation && !!group && activeMembers.length === 0
  const membershipUpdating = isGroup && !!conversation && !!group && !leftGroup && group.members.length !== activeMembers.length
  const usable = ready && !blocked && !request && !membershipUpdating && (!isGroup || (!!conversation && !!group && !leftGroup))
  const title = isSelf ? "You" : group?.name || conversation?.name || contacts.find(contact => contact.pub === conversationId)?.alias || (isGroup ? "Group conversation" : shortAddress(conversationId))
  const displayName = (pub: string) => pub === myPub ? "You" : contacts.find(contact => contact.pub === pub)?.alias || shortAddress(pub)
  const messages = useMemo(() => messaging.messages.filter(message => message.conversationId === conversationId), [messaging.messages, conversationId])
  const byId = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages])
  const pinned = messages.filter(message => message.pinned && !message.private)
  const files = messages.filter(message => message.attachment && !message.private)
  const sharedLinks = useMemo(() => messages.filter(message => !message.private).flatMap(message => extractLinks(message.content).map(url => ({ url, message }))).reverse(), [messages])
  const { content, setContent, clearSubmittedDraft, retryDraftSave, draftReady, draftSaved, draftIssue } = useChatDraft(myPub, conversationId, !privateMode)
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
  const [deleteTarget, setDeleteTarget] = useState<MessageRecord | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState("")
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const deleteMessageMenu = useRef<HTMLButtonElement | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [pollOpen, setPollOpen] = useState(false)
  const [privateOpen, setPrivateOpen] = useState(false)
  const [secretOpen, setSecretOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [infoTab, setInfoTab] = useState<"settings" | "files" | "links" | "pins">("settings")
  const [mentionOpen, setMentionOpen] = useState(false)
  const { mentionSpans, saveMentionDraft } = useMentionDraft(myPub, conversationId, content, draftReady, !privateMode)
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const chatRoot = useRef<HTMLDivElement>(null)
  const pendingMentionEdit = useRef<{ before: string; start: number; end: number } | null>(null)
  const [highlightedId, setHighlightedId] = useState("")
  const afterMessageMenuClose = useRef<(() => void) | null>(null)
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
    return pattern ? messages.filter(message => !message.private && pattern.test(searchableText(message))).map(message => message.id) : []
  }, [messages, searchTerm])
  const selectedIndex = matches.length ? Math.min(matchIndex, matches.length - 1) : 0
  const activeMatch = matches[selectedIndex]
  const unconfirmed = messages.filter(message => message.senderPubKey === myPub && message.delivery === "failed")
  const sending = busy || retrying !== null || batchProgress !== null
  const notificationMode = preferences.notifications[conversationId] || "all"
  const mentionMembers = privateMode ? [] : (isGroup ? activeMembers : (isSelf ? [] : [conversationId])).filter(pub => pub !== myPub)
  const mentions = [...new Set(validMentionSpans(content, mentionSpans).map(span => span.publicKey))].filter(pub => mentionMembers.includes(pub))
  const mentionCandidates = mentionMembers.filter(pub => !mentions.includes(pub)
    && (!mentionQuery?.query || displayName(pub).toLocaleLowerCase().includes(mentionQuery.query.toLocaleLowerCase()) || pub.includes(mentionQuery.query.toLowerCase())))
  const selectedMentionIndex = Math.min(mentionIndex, Math.max(0, mentionCandidates.length - 1))

  function updateMentionQuery(value: string, start: number, end = start) {
    if (privateMode) { setMentionOpen(false); setMentionQuery(null); return }
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
    setToolsOpen(false)
    const scope = {}
    actionScope.current = scope; sendLock.current = false; seenIds.current = null; nearBottom.current = true
    setBusy(false); setRetrying(null); setBatchProgress(null); setSendError(""); setReplyTo(undefined); setDeleteTarget(null); setDeleteError(""); setEditing(null); setPrivateOpen(false); setSecretOpen(false)
    return () => { if (actionScope.current === scope) actionScope.current = null }
  }, [myPub, conversationId])
  useEffect(() => {
    if (privateMode) { setReplyTo(undefined); setEditing(null); setPollOpen(false); setMentionOpen(false); setMentionQuery(null) }
  }, [privateMode])
  useEffect(() => {
    if (replyTo && (!byId.has(replyTo) || byId.get(replyTo)?.private)) setReplyTo(undefined)
    if (editing && (!byId.has(editing.id) || byId.get(editing.id)?.private)) setEditing(null)
    if (deleteTarget && !byId.has(deleteTarget.id)) setDeleteTarget(null)
  }, [byId, replyTo, editing, deleteTarget])
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
      await messaging.sendText(conversationId, content, privateMode ? undefined : replyTo, privateMode ? [] : mentions, privateTtlSeconds)
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
  const deleteSelectedMessage = async () => {
    if (!deleteTarget || deleting) return
    const scope = actionScope.current
    const target = deleteTarget
    setDeleting(true); setDeleteError("")
    try {
      await messaging.deleteMessage(target.conversationId, target.id)
      if (scope !== actionScope.current) return
      if (replyTo === target.id) setReplyTo(undefined)
      setDeleteTarget(null)
      setAnnouncement("Message deleted for you on this device.")
    } catch (cause) {
      if (scope === actionScope.current) setDeleteError(errorText(cause))
    } finally { setDeleting(false) }
  }
  const attachmentView = (message: MessageRecord) => !message.private && message.attachment && <AttachmentView metadata={message.attachment} chunks={messaging.getAttachmentChunks(conversationId, message.id)} />
  const openMessageFromInfo = (id: string) => { setInfoOpen(false); requestAnimationFrame(() => jumpToMessage(id)) }
  const statusLabel = { connecting: "Connecting inbox…", online: "Inbox connected", offline: "Inbox sync unavailable" }[status]
  return <div ref={chatRoot} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <header className="flex min-h-13 shrink-0 items-center justify-between gap-1 border-b border-border/80 bg-card/70 px-2 py-1 sm:px-4">
      <div className="flex min-w-0 items-center gap-1.5"><Link href="/chat" aria-label="Back to conversations" className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-card md:hidden"><ArrowLeft className="size-5" /></Link>{isGroup ? <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Users className="size-5" /></span> : <span className="hidden shrink-0 sm:block"><IdentityIcon pubKey={conversationId} size={30} /></span>}<div className="min-w-0"><h1 className="truncate font-sans text-base font-medium">{title}{isSelf && <span className="ml-2 text-xs font-normal text-muted-foreground">yourself</span>}</h1><span className="flex items-center gap-1 text-[11px] text-muted-foreground"><Lock className="size-3 shrink-0" /><span className="truncate">{conversation?.archived ? "Archived · History saved" : isGroup ? unavailableGroup ? "Group history unavailable" : closedGroup ? "Closed group · Encrypted" : leftGroup ? "Left group · Encrypted" : `${activeMembers.length} members · Encrypted` : privateMode ? `Private · ${privateDurationLabel(privateTtlSeconds)} timer` : "End-to-end encrypted"}</span></span></div></div>
      <div className="flex shrink-0 items-center gap-1"><span role="status" title={statusLabel} className="mr-1 shrink-0"><span aria-hidden="true" className={`block size-1.5 rounded-full ${status === "online" ? "bg-emerald-500" : status === "connecting" ? "animate-pulse bg-amber-500" : "bg-amber-500"}`} /><span className="sr-only">{statusLabel}</span></span>{canUsePrivate && <Button variant="ghost" size="icon" aria-label="Private chat settings" title="Private chat" className={`${conversation ? "hidden sm:inline-flex" : ""} ${privateMode ? "text-primary" : ""}`} disabled={!usable || sending} onClick={() => setPrivateOpen(true)}><Timer className="size-4" /></Button>}<Button variant="ghost" size="icon" className={conversation && !isSelf ? "hidden sm:inline-flex" : ""} aria-label="Search conversation" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(""); setMatchIndex(0) }}><Search className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Conversation details, files and settings" onClick={() => { setInfoTab("settings"); setInfoOpen(true) }}><Info className="size-4" /></Button>{conversation && !isSelf && <ConversationActions conversation={conversation} disabled={sending || actionBusy} onError={setSendError} onNotice={setAnnouncement}>
        <DropdownMenuItem className="sm:hidden" onSelect={() => requestAnimationFrame(() => { setSearchOpen(true); setQuery(""); setMatchIndex(0) })}><Search />Search conversation</DropdownMenuItem>
        {canUsePrivate && <DropdownMenuItem className="sm:hidden" disabled={!usable || sending} onSelect={() => requestAnimationFrame(() => setPrivateOpen(true))}><Timer />Private chat settings</DropdownMenuItem>}
      </ConversationActions>}</div>
    </header>
    {status !== "online" && !error && <div role="status" className="shrink-0 border-b border-border/70 px-3 py-1 text-[11px] text-amber-700 dark:text-amber-300">{statusLabel}</div>}
    {privateMode && <div className="flex shrink-0 items-center gap-2 border-b border-primary/15 bg-primary/5 px-4 py-2 text-xs text-muted-foreground"><Timer className="size-3.5 shrink-0 text-primary" /><span className="min-w-0 flex-1">New text messages disappear {privateDurationLabel(privateTtlSeconds)} after sending. Copies may remain with the recipient.</span><Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={!usable || sending} onClick={() => setPrivateOpen(true)}>Change</Button></div>}
    {searchOpen && <div role="search" aria-label="Search saved messages" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-7"><Input ref={searchInput} aria-label="Search messages" placeholder="Search ordinary messages…" className="min-w-32 flex-1" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { setSearchOpen(false); setQuery(""); input.current?.focus() } else if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) } }} /><span role="status" className="text-xs text-muted-foreground">{searchTerm ? matches.length ? `${selectedIndex + 1} of ${matches.length}` : "No matches" : "Private messages excluded"}</span><Button variant="ghost" size="icon" aria-label="Previous match" disabled={!matches.length} onClick={() => moveMatch(-1)}><ChevronUp className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Next match" disabled={!matches.length} onClick={() => moveMatch(1)}><ChevronDown className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery(""); input.current?.focus() }}><X className="size-4" /></Button></div>}
    {error && <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-amber-400/10 bg-amber-400/5 px-5 py-3 text-sm text-amber-700 dark:text-amber-200"><p role="alert" className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</p><Button type="button" size="sm" variant="outline" disabled={sending || actionBusy} onClick={() => void act(() => messaging.sync())}><RotateCw className="size-4" />Reconnect inbox</Button></div>}
    {deliveryError && <div role="alert" className="shrink-0 space-y-1 border-b border-amber-400/10 bg-amber-400/5 px-5 py-3 text-sm text-amber-700 dark:text-amber-200 [overflow-wrap:anywhere]"><p className="font-medium">Delivery issue in this conversation</p><p>{deliveryError}</p></div>}
    {sendError && sendError !== deliveryError && sendError !== error && <div className="flex shrink-0 items-start gap-3 border-b border-amber-400/10 bg-amber-400/5 px-5 py-3 text-sm text-amber-700 dark:text-amber-200"><p role="alert" className="min-w-0 flex-1 [overflow-wrap:anywhere]">{sendError}</p><Button size="icon" variant="ghost" className="shrink-0" aria-label="Dismiss conversation error" onClick={() => setSendError("")}><X className="size-4" /></Button></div>}
    {request && !blocked && <div className="flex flex-wrap items-center gap-3 border-b border-primary/20 bg-primary/5 p-4 text-sm"><p className="min-w-40 flex-1">{isGroup ? "You have been invited to this group." : "This person is not in your accepted conversations."} Accept to reply.</p><Button size="sm" disabled={actionBusy} onClick={() => void act(() => messaging.acceptRequest(conversationId))}>Accept</Button>{!isGroup && <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => void act(() => messaging.blockContact(conversationId))}>Block</Button>}</div>}
    {blocked && <div className="flex items-center justify-between gap-3 border-b border-border p-4 text-sm text-muted-foreground"><span>{isGroup ? "This group’s administrator is blocked." : "This person is blocked."}</span><Button size="sm" variant="outline" disabled={actionBusy || (isGroup && !group)} onClick={() => void act(() => messaging.blockContact(isGroup ? group!.admin : conversationId, false))}>Unblock</Button></div>}
    {pinned.length > 0 && <button type="button" className="flex items-center gap-2 border-b border-border shrink-0 bg-card/40 px-5 py-1.5 text-left text-xs text-primary hover:bg-card" onClick={() => { setInfoTab("pins"); setInfoOpen(true) }}><Pin className="size-3.5 shrink-0" /><span className="shrink-0">{pinned.length} pinned</span><span className="truncate text-muted-foreground">{messageSummary(pinned.at(-1)!)}</span></button>}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div ref={messagesViewport} role="region" aria-label="Conversation messages" tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 py-2 sm:px-4" onScroll={event => { const node = event.currentTarget; const wasNearBottom = nearBottom.current; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; setAwayFromBottom(!nearBottom.current); if (nearBottom.current) { setUnseen(0); if (!wasNearBottom) acknowledgeVisible() } }}>
      <div className="mx-auto max-w-7xl">{messages.length > 0 ? null : <div className="mx-auto max-w-sm py-7 text-center">{isSelf ? <MessageSquare className="mx-auto mb-3 size-8 text-primary/60" /> : <Shield className="mx-auto mb-3 size-8 text-primary/60" />}<h2 className="mb-2 text-xl text-foreground">{isSelf ? "Send things to yourself." : isGroup ? title : "Start with a hello."}</h2><p className="text-sm leading-relaxed text-muted-foreground">{isSelf ? "Send yourself messages, files, voice notes and links, just like any other conversation." : isGroup ? "A shared conversation with your group. Messages are encrypted before leaving your device." : "Verify this contact’s address through another trusted channel. Messages are encrypted before leaving your device."}</p>{!isGroup && <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{isSelf ? "Your address" : "Contact address"}</summary><p className="mt-2 select-all break-all font-mono leading-relaxed">{conversationId}</p></details>}</div>}
        {!ready && <p role="status" className="flex justify-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Opening conversation…</p>}
        {ready && isGroup && !group && <p role="status" className="rounded-xl border border-border p-5 text-center text-sm text-muted-foreground">This group is not saved on this device. Ask a group member for an invitation, or restore your chat backup.</p>}
        {messages.map((message, index) => {
          const mine = message.senderPubKey === myPub
          const day = new Date(message.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          const previousDay = index ? new Date(messages[index - 1].timestamp).toDateString() : ""
          const quoted = !message.private && message.replyTo ? byId.get(message.replyTo) : undefined
          const inRun = (first: MessageRecord | undefined, second: MessageRecord | undefined) => !!first && !!second
            && first.senderPubKey === second.senderPubKey && !first.private && !second.private
            && !second.replyTo && first.delivery !== "failed" && second.delivery !== "failed"
            && second.timestamp >= first.timestamp && second.timestamp - first.timestamp < 5 * 60_000
            && new Date(first.timestamp).toDateString() === new Date(second.timestamp).toDateString()
          const continuesRun = inRun(messages[index - 1], message)
          const next = messages[index + 1]
          const showMetadata = !inRun(message, next) || message.editedAt || message.pinned
            || message.delivery === "pending" || message.delivery !== next?.delivery
            || (isGroup && (message.readBy.length !== next?.readBy.length || message.deliveredTo.length !== next?.deliveredTo.length))
          return <div key={message.id} id={`message-${message.id}`} ref={node => { if (node) messageNodes.current.set(message.id, node); else messageNodes.current.delete(message.id) }} data-message-run={continuesRun ? "continuation" : "start"} className={`${continuesRun ? "mt-0.5" : "mt-2"} ${activeMatch === message.id || highlightedId === message.id ? "rounded-xl ring-2 ring-amber-300/60 ring-offset-4 ring-offset-background" : ""}`}>{previousDay !== new Date(message.timestamp).toDateString() && <p className="mb-2 pt-1 text-center text-[11px] text-muted-foreground">{day}</p>}<div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
            {isGroup && !mine && !continuesRun && <p className="mb-0.5 ml-1 text-xs text-primary">{displayName(message.senderPubKey)}</p>}<span className="sr-only">{displayName(message.senderPubKey)}:</span>
            <div className={`flex w-full min-w-0 items-start gap-1 ${mine ? "flex-row-reverse" : ""}`}>
              <div className={`min-w-0 max-w-[calc(100%-3rem)] break-words rounded-xl px-2.5 py-1 text-[15px] leading-[1.4] [overflow-wrap:anywhere] sm:max-w-[min(85%,75ch)] ${mine ? "rounded-br-md bg-message-outgoing text-message-outgoing-foreground" : "rounded-bl-md border border-border/70 bg-message-incoming text-message-incoming-foreground"}`}>
                {!message.private && message.replyTo && <button type="button" disabled={!quoted} aria-label={quoted ? "Jump to replied message" : "Original message is unavailable"} className="mb-1.5 block w-full rounded-r border-l-2 border-current/40 bg-current/5 px-2 py-1 text-left text-xs" onClick={() => { if (quoted) jumpToMessage(quoted.id) }}><span className="block font-medium">{quoted ? displayName(quoted.senderPubKey) : "Reply"}</span><span className="line-clamp-2 opacity-70">{quoted ? messageSummary(quoted) : "Original message is not saved on this device."}</span></button>}
                {message.private ? <SecretMessage content={message.content} expiresAt={message.expiresAt || 0} secret={message.secret} /> : message.content && !message.poll && <RichMessage text={message.content} highlight={searchTerm} />}
                {!message.private && message.attachment && attachmentView(message)}
                {!message.private && message.poll && <PollCard question={message.poll.question} options={message.poll.options.map((text, i) => ({ id: String(i), text }))} votes={Object.fromEntries(Object.entries(message.poll.votes).map(([pub, option]) => [pub, String(option)]))} myPub={myPub} disabled={!usable} onVote={option => messaging.vote(conversationId, message.id, Number(option))} />}
                {!message.private && !!message.mentions?.length && <p className="mt-1 text-xs opacity-65">Mentioned: {message.mentions.map(displayName).join(", ")}</p>}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><button type="button" aria-label="Message actions" title="Message actions" className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"><MoreHorizontal className="size-4" /></button></DropdownMenuTrigger>
                <DropdownMenuContent align={mine ? "end" : "start"} onCloseAutoFocus={event => {
                  const action = afterMessageMenuClose.current
                  if (action) { event.preventDefault(); afterMessageMenuClose.current = null; action() }
                }}>
                  <div className="px-2 py-1.5 text-xs text-muted-foreground"><time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleString()}</time></div>
                  {!message.secret && <DropdownMenuItem className="min-h-11" onSelect={async () => { if (message.private && (!message.expiresAt || Date.now() >= message.expiresAt)) return; try { await navigator.clipboard.writeText(message.private ? message.content : messageSummary(message)); clearTimeout(copyTimer.current); setCopiedMessage(message.id); setAnnouncement("Message copied."); copyTimer.current = setTimeout(() => setCopiedMessage(""), 2500) } catch { setSendError("Clipboard access was blocked. Select the message text to copy it.") } }}>{copiedMessage === message.id ? <Check /> : <Copy />}{copiedMessage === message.id ? "Copied" : "Copy"}</DropdownMenuItem>}
                  {!message.private && !privateMode && <DropdownMenuItem className="min-h-11" disabled={!usable} onSelect={() => { afterMessageMenuClose.current = () => { setReplyTo(message.id); input.current?.focus() } }}><Reply />Reply</DropdownMenuItem>}
                  {!message.private && !privateMode && mine && !!message.content && !message.attachment && !message.poll && <DropdownMenuItem className="min-h-11" disabled={!usable || actionBusy} onSelect={() => { afterMessageMenuClose.current = () => setEditing(message) }}><Pencil />Edit</DropdownMenuItem>}
                  {!message.private && <DropdownMenuItem className="min-h-11" disabled={!usable || actionBusy} onSelect={() => void act(() => messaging.pinMessage(conversationId, message.id, !message.pinned), message.pinned ? "Message unpinned." : "Message pinned.")}>{message.pinned ? <PinOff /> : <Pin />}{message.pinned ? "Unpin" : "Pin"}</DropdownMenuItem>}
                  {!message.secret && <DropdownMenuSeparator />}
                  <DropdownMenuItem className="min-h-11" variant="destructive" disabled={!ready || sending || deleting} onSelect={() => { afterMessageMenuClose.current = () => { deleteMessageMenu.current = messageNodes.current.get(message.id)?.querySelector<HTMLButtonElement>('button[aria-label="Message actions"]') ?? null; setDeleteError(""); setDeleteTarget(message) } }}><Trash2 />Delete for me…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className={showMetadata ? "mt-0.5 flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 text-muted-foreground" : "sr-only"}><time title={new Date(message.timestamp).toLocaleString()} dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>{!message.private && message.editedAt && <span title={`Edited ${new Date(message.editedAt).toLocaleString()}`}>edited</span>}{!message.private && message.pinned && <Pin aria-label="Pinned message" className="size-3 text-primary" />}
              {mine && (isSelf ? <span className="flex items-center gap-1"><Check className="size-3" />Saved</span> : message.delivery === "failed" ? <button type="button" disabled={sending || !ready} title={message.error} className="flex min-h-7 items-center gap-1 rounded px-1 text-destructive hover:text-destructive disabled:opacity-50" onClick={() => void retryFailed([message])}><RotateCw className={`size-3 ${retrying === message.id ? "animate-spin" : ""}`} />{retrying === message.id ? "Retrying" : "Failed · Retry"}</button> : <span className="flex items-center gap-1" title={message.delivery === "sent" ? "Accepted by the encrypted relay; no recipient receipt yet." : message.delivery === "delivered" ? `Received by ${message.deliveredTo.length || 1} recipient(s).` : message.delivery === "read" ? `Read by ${message.readBy.length || 1} recipient(s).` : "Waiting to reach the relay."}>{message.delivery === "pending" ? <Loader2 className="size-3 animate-spin" /> : message.delivery === "read" || message.delivery === "delivered" ? <CheckCheck className={`size-3 ${message.delivery === "read" ? "text-primary" : ""}`} /> : <Check className="size-3" />}{({ pending: "Queued", sent: "Sent", delivered: "Delivered", read: "Read", received: "Received", failed: "Failed" })[message.delivery]}{isGroup && message.delivery === "read" ? ` · ${message.readBy.length}` : isGroup && message.delivery === "delivered" ? ` · ${message.deliveredTo.length}` : ""}</span>)}
            </div>
            {mine && message.delivery === "failed" && message.error && message.error !== deliveryError && message.error !== sendError && <p className="mt-1 max-w-[94%] text-xs text-destructive [overflow-wrap:anywhere] sm:max-w-[min(85%,75ch)]">{message.error}</p>}
          </div></div>
        })}
      </div>
    </div>
    {(awayFromBottom || unseen > 0) && <div className="flex justify-center border-t border-border/60 py-2"><Button variant="secondary" size="sm" className="rounded-full" onClick={jumpToLatest}><ArrowDown className="size-4" /><span aria-live="polite">{unseen ? `${unseen} new message${unseen === 1 ? "" : "s"}` : "Jump to latest"}</span></Button></div>}
    <footer className="chat-composer chat-bottom min-w-0 shrink-0 overflow-y-auto border-t border-border/70 bg-background px-2 pt-1.5 sm:px-4">
      {ready && unavailableGroup && <p className="mx-auto mb-3 max-w-7xl text-sm text-muted-foreground">This group has no saved conversation on this device. A new group message may make it available again.</p>}
      {leftGroup && <p className="mx-auto mb-3 max-w-7xl text-sm text-muted-foreground">{closedGroup ? "This group is closed. Saved messages are still available." : "You are no longer a member of this group. Your saved conversation is still available."}</p>}
      {membershipUpdating && <p className="mx-auto mb-3 max-w-7xl text-sm text-muted-foreground">Updating group membership before sending more messages…</p>}
      {(unconfirmed.length > 1 || batchProgress) && <div className="mx-auto mb-3 flex max-w-7xl flex-wrap items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-200"><span role="status">{batchProgress ? `Retrying ${batchProgress.current} of ${batchProgress.total}…` : `${unconfirmed.length} messages need another attempt.`}</span><Button type="button" size="sm" variant="outline" disabled={!ready || sending} onClick={() => void retryFailed(unconfirmed, true)}><RotateCw className={`size-3 ${batchProgress ? "animate-spin" : ""}`} />{batchProgress ? "Retrying…" : "Retry failed messages"}</Button></div>}
      <div className="mx-auto max-w-7xl">
        {!privateMode && replyTo && <div className="mb-2 flex items-center gap-2 rounded-lg border-l-2 border-primary bg-card p-2 text-xs"><Reply className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block text-primary">Replying to {byId.get(replyTo) ? displayName(byId.get(replyTo)!.senderPubKey) : "message"}</span><span className="block truncate text-muted-foreground">{byId.get(replyTo) ? messageSummary(byId.get(replyTo)!) : "Original message"}</span></span><Button variant="ghost" size="icon" aria-label="Cancel reply" onClick={() => setReplyTo(undefined)}><X className="size-4" /></Button></div>}
        <form onSubmit={event => { event.preventDefault(); void submit() }}><div className="flex items-end gap-1 rounded-xl border border-border bg-card p-1 shadow-sm focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/10"><Button type="button" variant="ghost" size="icon" className="size-9 shrink-0 rounded-lg" aria-label="More message tools" title="Files, GIFs and message tools" aria-expanded={toolsOpen} aria-controls="message-tools" onClick={() => setToolsOpen(value => !value)}>{toolsOpen ? <X className="size-4" /> : <Plus className="size-4" />}</Button><Textarea ref={input} aria-label="Message" aria-busy={busy} autoComplete={privateMode ? "off" : undefined} autoCorrect={privateMode ? "off" : undefined} spellCheck={!privateMode} placeholder={blocked ? "Unblock this person to send messages" : request ? "Accept this conversation to reply" : unavailableGroup ? "This group is unavailable on this device" : closedGroup ? "This group is closed" : leftGroup ? "You left this group" : membershipUpdating ? "Updating group membership…" : ready ? privateMode ? "Write a private message…" : isSelf ? "Message yourself…" : "Write a message…" : "Opening conversation…"} value={content} onChange={event => changeMessage(event.target.value, event.target.selectionStart, event.target.selectionEnd)} onSelect={event => { const node = event.currentTarget; if (document.activeElement === node) updateMentionQuery(node.value, node.selectionStart, node.selectionEnd) }} onBlur={() => setMentionOpen(false)} aria-autocomplete="list" aria-controls={mentionOpen ? "message-mention-options" : undefined} aria-activedescendant={mentionOpen && mentionCandidates.length ? `message-mention-${selectedMentionIndex}` : undefined} maxLength={MAX_MESSAGE_LENGTH} disabled={!usable || !draftReady} readOnly={busy} rows={1} className="max-h-36 min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-2 text-base md:text-base shadow-none focus-visible:ring-0" onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (mentionOpen) {
            if (event.key === "Escape") { event.preventDefault(); setMentionOpen(false); return }
            if (mentionCandidates.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setMentionIndex((selectedMentionIndex + (event.key === "ArrowDown" ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length); return }
            if (mentionCandidates.length && ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab")) { event.preventDefault(); chooseMention(mentionCandidates[selectedMentionIndex]); return }
          }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit() }
        }} /><Button type="submit" aria-label="Send message" disabled={!usable || !draftReady || !content.trim() || sending} size="icon" className="size-9 shrink-0 rounded-lg">{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button></div></form>
        {!privateMode && mentionOpen && <div id="message-mention-options" role="listbox" aria-label="Mention suggestions" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); setMentionOpen(false); input.current?.focus() }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && mentionCandidates.length) {
            event.preventDefault()
            const current = mentionCandidates.findIndex((_, index) => document.activeElement?.id === `message-mention-${index}`)
            const next = event.key === "Home" ? 0 : event.key === "End" ? mentionCandidates.length - 1 : (current + (event.key === "ArrowDown" ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length
            setMentionIndex(next); document.getElementById(`message-mention-${next}`)?.focus()
          }
        }} className="mb-2 max-h-48 overflow-y-auto rounded-lg border border-border bg-card p-1 text-sm">
          {mentionCandidates.map((pub, index) => <button type="button" role="option" id={`message-mention-${index}`} aria-selected={index === selectedMentionIndex} key={pub} onPointerDown={event => event.preventDefault()} onClick={() => chooseMention(pub)} className={`flex w-full items-center justify-between gap-3 min-w-0 rounded-md px-3 py-2 text-left ${index === selectedMentionIndex ? "bg-primary/15 text-primary" : "text-foreground hover:bg-muted"}`}><span className="min-w-0 flex-1 truncate">@{displayName(pub)}</span><span className="shrink-0 font-mono text-xs text-muted-foreground">{shortAddress(pub)}</span></button>)}
          {!mentionCandidates.length && <p className="px-3 py-2 text-xs text-muted-foreground">{mentionQuery?.query ? "No matching members." : "Everyone is already mentioned."}</p>}
        </div>}
        {mentions.length > 0 && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">{mentions.map(pub => <button type="button" key={pub} aria-label={`Remove mention of ${displayName(pub)}`} disabled={busy} onClick={() => removeMention(pub)} className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-1 text-primary">@{displayName(pub)}<X className="size-3" /></button>)}</div>}
        {privateMode ? <div id="message-tools" className={`${toolsOpen ? "flex" : "hidden"} flex-wrap items-center justify-between gap-2 py-1`}><Button type="button" variant="ghost" size="sm" disabled={!usable || sending} onClick={() => setSecretOpen(true)}><KeyRound className="size-4" />Share access key</Button><span className="text-[11px] text-muted-foreground">Plain text only · No files or polls</span></div> : <AttachmentComposer key={`${myPub}:${conversationId}`} owner={myPub} toolbarVisible={toolsOpen} toolbarId="message-tools" extraActions={<>
          {canUsePrivate && <Button type="button" variant="ghost" size="sm" disabled={!usable || sending} onClick={() => setSecretOpen(true)}><KeyRound className="size-4" /><span className="hidden sm:inline">Access key</span><span className="sr-only sm:hidden">Share access key</span></Button>}
          <Button type="button" variant="ghost" size="sm" disabled={!usable} onClick={() => setPollOpen(true)}><BarChart3 className="size-4" />Poll</Button>
          {!isSelf && <Button type="button" variant="ghost" size="sm" disabled={!usable} aria-expanded={mentionOpen} onClick={() => { setMentionQuery(findMentionQuery(content, input.current?.selectionStart ?? content.length, input.current?.selectionEnd ?? content.length)); setMentionIndex(0); setMentionOpen(!mentionOpen); if (!mentionOpen) requestAnimationFrame(() => document.getElementById("message-mention-0")?.focus()); else input.current?.focus() }}><AtSign className="size-4" />Mention</Button>}
        </>} captureRef={chatRoot} pasteRef={input} disabled={!usable || sending || !draftReady} onSelectGif={url => {
          if (!usable || sending || !draftReady) return
          const next = content.trim() ? `${content}\n${url}` : url
          if (next.length > MAX_MESSAGE_LENGTH) { setSendError("There is not enough room for this GIF. Send or shorten your draft first."); return }
          changeMessage(next, next.length)
          requestAnimationFrame(() => input.current?.focus())
        }} onSend={async (file, kind, onProgress) => { const scope = actionScope.current; const id = await sendAttachment(messaging.sendEvent, conversationId, file, kind, onProgress, replyTo); if (actionScope.current === scope) { setReplyTo(undefined); jumpToLatest() } return id }} />}
        <div className={toolsOpen || (!privateMode && !draftSaved) ? "mt-1 flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground" : "sr-only"}><span className="hidden sm:inline">Enter to send · Shift + Enter for a new line · Math: $…$ · Code: ```</span><span className={!privateMode && !draftSaved ? "text-amber-700 dark:text-amber-300" : ""}>{privateMode ? "Private draft stays only in this tab" : !draftSaved ? draftIssue === "read" ? "Saved draft could not be loaded" : draftIssue === "clear" ? "Sent text is waiting to be cleared from storage" : "Draft is only in this tab · Do not close it" : content ? "Draft saved on this browser" : "History saved on this browser"}</span></div>{!privateMode && !draftSaved && <Button type="button" size="sm" variant="ghost" onClick={retryDraftSave}>{draftIssue === "read" ? "Try loading draft again" : draftIssue === "clear" ? "Retry draft cleanup" : "Try saving draft again"}</Button>}{content.length > MAX_MESSAGE_LENGTH - 1000 && <p className="mt-1 text-right text-xs text-muted-foreground">{content.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}</p>}
      </div>
    </footer>
    {canUsePrivate && <PrivateChatControls key={`private:${myPub}:${conversationId}`} open={privateOpen} onOpenChange={setPrivateOpen} ttlSeconds={privateTtlSeconds} disabled={!usable || sending} onSetMode={seconds => messaging.setPrivateMode(conversationId, seconds)} onDestroy={async () => { await messaging.destroyPrivateHistory(conversationId); setAnnouncement("Private history destroyed here. The other person’s updated app will remove it when it receives the request.") }} />}
    {canUsePrivate && secretOpen && <ShareSecretDialog key={`secret:${myPub}:${conversationId}`} recipientName={title} recipientAddress={conversationId} disabled={!usable || sending} onClose={() => setSecretOpen(false)} onSend={async (secret, seconds) => { await messaging.sendSecret(conversationId, secret, seconds); jumpToLatest() }} />}
    <PollCreator open={!privateMode && pollOpen} onOpenChange={setPollOpen} onCreate={async (question, options) => { await messaging.createPoll(conversationId, question, options); jumpToLatest() }} />
    <EditMessageDialog message={editing} onClose={() => setEditing(null)} onSave={(id, value) => messaging.editMessage(conversationId, id, value)} />
    <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null) }}>
      <DialogContent onOpenAutoFocus={event => { event.preventDefault(); cancelDelete.current?.focus() }} onCloseAutoFocus={event => {
        event.preventDefault()
        if (deleteMessageMenu.current?.isConnected) deleteMessageMenu.current.focus()
        else if (input.current && !input.current.disabled) input.current.focus()
        else messagesViewport.current?.focus()
      }}>
        <DialogHeader><DialogTitle>Delete this message for you?</DialogTitle><DialogDescription>This removes the message and its attachment from saved history on this device. Other participants and linked devices keep their copies. This cannot be undone here.</DialogDescription></DialogHeader>
        {deleteTarget && <p className="line-clamp-3 break-words rounded-lg bg-muted p-3 text-sm text-muted-foreground [overflow-wrap:anywhere]">{messageSummary(deleteTarget)}</p>}
        {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
        <DialogFooter><Button ref={cancelDelete} variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={deleting} onClick={() => void deleteSelectedMessage()}>{deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}Delete for me</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={infoOpen} onOpenChange={setInfoOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Conversation settings and everything shared here.</DialogDescription></DialogHeader><div role="tablist" aria-label="Conversation details" className="grid grid-cols-4 gap-1 rounded-lg bg-card p-1">{([['settings', 'Settings'], ['files', 'Files'], ['links', 'Links'], ['pins', 'Pinned']] as const).map(([tab, label]) => <button key={tab} type="button" id={`details-tab-${tab}`} role="tab" aria-selected={infoTab === tab} tabIndex={infoTab === tab ? 0 : -1} aria-controls={`details-panel-${tab}`} onKeyDown={event => { const tabs = ["settings", "files", "links", "pins"] as const; const index = tabs.indexOf(tab); const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null; if (next) { event.preventDefault(); setInfoTab(next); document.getElementById(`details-tab-${next}`)?.focus() } }} onClick={() => setInfoTab(tab)} className={`rounded-md px-2 py-2 text-sm ${infoTab === tab ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}</div><div role="tabpanel" id={`details-panel-${infoTab}`} aria-labelledby={`details-tab-${infoTab}`} className="min-h-32 space-y-4">
      {infoTab === "files" && (files.length ? [...files].reverse().map(message => <div key={message.id} className="space-y-2 rounded-xl border border-border p-3">{attachmentView(message)}<button type="button" className="text-xs text-primary hover:underline" onClick={() => openMessageFromInfo(message.id)}>View message · {new Date(message.timestamp).toLocaleDateString()}</button></div>) : <p className="py-8 text-center text-sm text-muted-foreground">Files and voice messages will appear here.</p>)}
      {infoTab === "links" && (sharedLinks.length ? sharedLinks.map(({ url, message }, index) => <div key={`${message.id}:${index}`} className="space-y-2 rounded-xl border border-border p-3"><a href={url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 break-all text-sm text-primary hover:underline"><ExternalLink className="mt-0.5 size-4 shrink-0" />{url}</a><button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => openMessageFromInfo(message.id)}>View message · {displayName(message.senderPubKey)}</button></div>) : <p className="py-8 text-center text-sm text-muted-foreground">Links from this conversation will appear here.</p>)}
      {infoTab === "pins" && (pinned.length ? [...pinned].reverse().map(message => <div key={message.id} className="rounded-xl border border-border p-3"><button type="button" className="w-full text-left" onClick={() => openMessageFromInfo(message.id)}><span className="text-xs text-primary">{displayName(message.senderPubKey)}</span><p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-sm text-foreground">{messageSummary(message)}</p><span className="mt-2 block text-xs text-muted-foreground">Jump to message</span></button><Button size="sm" variant="ghost" disabled={!usable || actionBusy} onClick={() => void act(() => messaging.pinMessage(conversationId, message.id, false))}><PinOff className="size-3" />Unpin</Button></div>) : <p className="py-8 text-center text-sm text-muted-foreground">Pin a message to find it quickly here.</p>)}
      {infoTab === "settings" && <>
        {!isSelf && <div className="space-y-2"><Label htmlFor="conversation-notifications" className="flex items-center gap-2"><Bell className="size-4" />Notifications</Label><select id="conversation-notifications" value={notificationMode} disabled={actionBusy} onChange={event => void act(() => messaging.setNotificationMode(conversationId, event.target.value as NotificationMode))} className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm"><option value="all">All messages</option><option value="mentions">Mentions only</option><option value="muted">Muted</option></select><p className="text-xs leading-relaxed text-muted-foreground">Browser notifications work while Serotine is open. Enable them in the inbox settings.</p></div>}
        {isGroup && group && conversation && <GroupSettings groupName={group.name} members={activeMembers.map(pub => ({ pub, label: displayName(pub) }))} candidates={contacts.filter(contact => !activeMembers.includes(contact.pub)).map(contact => ({ pub: contact.pub, label: contact.alias || shortAddress(contact.pub) }))} canManage={group.admin === myPub && !membershipUpdating} left={leftGroup} ownerPub={group.admin} myPub={myPub} onRename={name => messaging.updateGroup(conversationId, { name })} onAdd={async pub => { const address = await parseContactCode(pub); if (activeMembers.includes(address)) throw new Error("This person is already in the group."); await messaging.updateGroup(conversationId, { members: [...activeMembers, address] }) }} onRemove={pub => messaging.updateGroup(conversationId, { members: activeMembers.filter(member => member !== pub) })} onLeave={() => messaging.leaveGroup(conversationId)} />}
        {!isGroup && <div className="space-y-2"><p className="text-sm font-medium">{isSelf ? "Your address" : "Contact address"}</p><QrCodeCard value={conversationId} title={isSelf ? "Your address QR code" : "Contact address QR code"} /><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">View full public address</summary><p className="mt-2 select-all break-all rounded-lg bg-card p-3 font-mono text-xs text-muted-foreground">{conversationId}</p></details></div>}
        {!isGroup && !isSelf && <div className="border-t border-border pt-4"><Button variant="outline" className="text-destructive" disabled={actionBusy} onClick={() => void act(() => messaging.blockContact(conversationId, !blocked))}><Ban className="size-4" />{blocked ? "Unblock contact" : "Block contact"}</Button><p className="mt-2 text-xs text-muted-foreground">Blocking stops new direct messages from this address.</p></div>}
        {isSelf && <p className="text-sm leading-relaxed text-muted-foreground">This is a conversation with your own address. Send messages, files and links here to keep them together.</p>}
      </>}
    </div>{sendError && <p role="alert" className="text-sm text-destructive">{sendError}</p>}</DialogContent></Dialog>
  </div>
}
