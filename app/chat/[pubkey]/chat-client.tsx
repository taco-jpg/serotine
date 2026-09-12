"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Check, Loader2, Lock, Send, Shield, RotateCw, ArrowDown, Search, X, ChevronUp, ChevronDown, Copy, Paperclip } from "lucide-react"
import { useP2PChat, type ChatMessage } from "@/hooks/use-p2p-chat"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { loadContacts, shortAddress } from "@/lib/identity"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"
import { useChatDraft } from "@/hooks/use-chat-draft"
import { MessageSendError } from "@/lib/message-send-error"
import { Input } from "@/components/ui/input"
import { MessageText, literalSearch } from "@/components/message-text"
import { retryMessageBatch } from "@/lib/retry-messages"
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, formatFileSize } from "@/lib/attachments"
import { MessageAttachments, PendingAttachments } from "@/components/message-attachments"
import { useAttachmentDraft } from "@/components/use-attachment-draft"

export default function ChatWindow({ params }: { params: { pubkey: string } }) {
  const { sendMessage, status, messages, myPub, ready, error, reconnect } = useP2PChat(params.pubkey)
  const { content, setContent, clearSubmittedDraft, retryDraftSave, draftReady, draftSaved, draftIssue } = useChatDraft(myPub, params.pubkey)
  const { files, addFiles, removeFile, clearSubmittedAttachments, attachmentReady, preparing, isPreparing, issue: attachmentIssue } = useAttachmentDraft(myPub, params.pubkey)
  const [busy, setBusy] = useState(false)
  const [alias, setAlias] = useState("")
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
  const [draggingFiles, setDraggingFiles] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  const seenIds = useRef<Set<string> | null>(null)
  const messageNodes = useRef(new Map<string, HTMLDivElement>())
  const searchInput = useRef<HTMLInputElement>(null)
  const searchTerm = query.trim()
  const matches = useMemo(() => {
    const pattern = literalSearch(searchTerm)
    return pattern ? messages.filter(message => pattern.test(message.content) || message.attachments?.some(attachment => pattern.test(attachment.name))).map(message => `${message.senderPubKey}:${message.id}`) : []
  }, [messages, searchTerm])
  const selectedIndex = matches.length ? Math.min(matchIndex, matches.length - 1) : 0
  const activeMatch = matches[selectedIndex]
  const messagesViewport = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const sendLock = useRef(false)
  const actionScope = useRef<object | null>(null)
  useEffect(() => {
    const scope = {}
    actionScope.current = scope
    sendLock.current = false
    setBusy(false); setRetrying(null); setBatchProgress(null); setSendError("")
    setDraggingFiles(false); dragDepth.current = 0
    return () => { if (actionScope.current === scope) actionScope.current = null }
  }, [myPub, params.pubkey])
  const unconfirmed = messages.filter(message => message.senderPubKey === myPub && message.peerPubKey === params.pubkey && message.delivery === "failed")
  const sending = busy || retrying !== null || batchProgress !== null
  const canAttach = ready && draftReady && attachmentReady && !sending && !preparing
  const attachmentBytes = files.reduce((total, file) => total + file.attachment.size, 0)
  useEffect(() => {
    const node = input.current
    if (node) { node.style.height = "auto"; node.style.height = Math.min(node.scrollHeight, 176) + "px" }
  }, [content, ready])
  useEffect(() => {
    if (!ready) return
    const ids = new Set(messages.map(message => `${message.senderPubKey}:${message.id}`))
    if (seenIds.current) {
      const added = messages.filter(message => message.senderPubKey !== myPub && !seenIds.current!.has(`${message.senderPubKey}:${message.id}`)).length
      if (added) {
        if (!nearBottom.current) setUnseen(previous => previous + added)
        setAnnouncement(`${added} new message${added === 1 ? "" : "s"} received at ${new Date().toLocaleTimeString()}.`)
      }
    }
    seenIds.current = ids
    if (nearBottom.current && !searchTerm && messagesViewport.current) {
      messagesViewport.current.scrollTop = messagesViewport.current.scrollHeight
    }
  }, [messages, ready, myPub, searchTerm])
  useEffect(() => {
    if (activeMatch) {
      nearBottom.current = false
      const viewport = messagesViewport.current
      const message = messageNodes.current.get(activeMatch)
      if (viewport && message) {
        const viewportRect = viewport.getBoundingClientRect()
        const messageRect = message.getBoundingClientRect()
        viewport.scrollTop += messageRect.top - viewportRect.top - (viewport.clientHeight - messageRect.height) / 2
      }
    }
  }, [activeMatch, searchTerm])
  useEffect(() => { if (searchOpen) searchInput.current?.focus() }, [searchOpen])
  const jumpToLatest = () => {
    setQuery(""); nearBottom.current = true; setAwayFromBottom(false); setUnseen(0)
    if (messagesViewport.current) messagesViewport.current.scrollTop = messagesViewport.current.scrollHeight
  }
  const moveMatch = (direction: number) => {
    if (matches.length) setMatchIndex((selectedIndex + direction + matches.length) % matches.length)
  }
  useEffect(() => {
    const refresh = () => { if (myPub) { try { setAlias(loadContacts(myPub).find(c => c.pub === params.pubkey)?.alias || "") } catch { setAlias("") } } }
    const fromStorage = (event: StorageEvent) => { if (event.key === null || event.key === `serotine_contacts:${myPub}`) refresh() }
    refresh(); window.addEventListener("serotine:contacts", refresh); window.addEventListener("storage", fromStorage)
    return () => { window.removeEventListener("serotine:contacts", refresh); window.removeEventListener("storage", fromStorage) }
  }, [myPub, params.pubkey])
  const submit = async () => {
    const scope = actionScope.current
    if (!scope || (!content.trim() && !files.length) || sendLock.current || isPreparing() || !ready || !draftReady || !attachmentReady) return
    const isCurrent = () => actionScope.current === scope
    sendLock.current = true; setBusy(true); setSendError(""); jumpToLatest()
    const draft = content
    try { await sendMessage(draft, undefined, files.map(file => file.attachment)); clearSubmittedDraft(); clearSubmittedAttachments() }
    catch (cause) {
      if (isCurrent()) setSendError(cause instanceof Error ? cause.message : "Message was not sent.")
      // A durable failed bubble owns its retry. Otherwise keep the only copy here.
      if (cause instanceof MessageSendError && cause.savedLocally) { clearSubmittedDraft(); clearSubmittedAttachments() }
    }
    finally { if (isCurrent()) { sendLock.current = false; setBusy(false); input.current?.focus() } }
  }
  const retryFailed = async (snapshot: ChatMessage[], batch = false) => {
    const scope = actionScope.current
    if (!scope || sendLock.current || !ready || !snapshot.length) return
    const isCurrent = () => actionScope.current === scope
    sendLock.current = true; setSendError("")
    if (batch) setBatchProgress({ current: 1, total: snapshot.length })
    try {
      const result = await retryMessageBatch(snapshot, sendMessage, isCurrent, (message, index) => {
        setRetrying(message.id)
        if (batch) setBatchProgress({ current: index + 1, total: snapshot.length })
      })
      if (!isCurrent()) return
      if (result.status === "failed") {
        const reason = result.error instanceof Error ? result.error.message : "Message delivery could not be confirmed."
        setSendError(batch ? `Retry stopped after ${result.completed} of ${snapshot.length} messages. ${reason}` : reason)
      } else if (result.status === "complete" && batch) setAnnouncement(`Retry complete for ${result.completed} messages.`)
    } finally {
      if (isCurrent()) { sendLock.current = false; setRetrying(null); setBatchProgress(null) }
    }
  }
  const statusLabel = { connecting: "Connecting…", online: "Direct connection", relay: "Encrypted relay", offline: "Connection unavailable" }[status]
  return <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className="flex min-h-20 shrink-0 items-center justify-between gap-3 border-b border-zinc-800/80 px-4 py-4 sm:px-7">
      <div className="flex min-w-0 items-center gap-3"><Link href="/chat" aria-label="Back to contacts" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 md:hidden"><ArrowLeft className="size-5" /></Link><IdentityIcon pubKey={params.pubkey} size={38} /><div className="min-w-0"><h1 className="truncate font-sans text-base font-medium">{alias || shortAddress(params.pubkey)}</h1><span className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500"><Lock className="size-3" /> End-to-end encrypted</span></div></div>
      <div className="flex items-center gap-2"><Button variant="ghost" size="icon" aria-label="Search conversation" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(""); setMatchIndex(0) }}><Search className="size-4" /></Button><span role="status" className={`max-w-32 rounded-lg border px-2.5 py-1.5 text-center text-xs sm:max-w-none ${status === "offline" ? "border-amber-400/20 text-amber-300" : "border-zinc-800 text-zinc-400"}`}>{statusLabel}</span></div>
    </header>
    {searchOpen && <div role="search" aria-label="Search saved messages" className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3 sm:px-7">
      <Input ref={searchInput} aria-label="Search messages and filenames" placeholder="Search messages and filenames…" className="min-w-32 flex-1" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { setSearchOpen(false); setQuery(""); input.current?.focus() } else if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) } }} />
      <span role="status" className="text-xs text-zinc-400">{searchTerm ? matches.length ? `${selectedIndex + 1} of ${matches.length}` : "No matches" : "Saved messages only"}</span>
      <Button variant="ghost" size="icon" aria-label="Previous match" disabled={!matches.length} onClick={() => moveMatch(-1)}><ChevronUp className="size-4" /></Button>
      <Button variant="ghost" size="icon" aria-label="Next match" disabled={!matches.length} onClick={() => moveMatch(1)}><ChevronDown className="size-4" /></Button>
      <Button variant="ghost" size="icon" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery(""); input.current?.focus() }}><X className="size-4" /></Button>
    </div>}
    {(error || sendError) && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-400/10 bg-amber-400/5 px-5 py-3 text-sm leading-relaxed text-amber-200"><p role="alert" className="min-w-0 flex-1">{sendError || error}</p><Button type="button" size="sm" variant="outline" disabled={sending} onClick={() => { setSendError(""); reconnect() }}><RotateCw className="mr-2 size-4" />{ready ? "Reconnect" : "Try opening again"}</Button></div>}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div ref={messagesViewport} role="region" aria-label="Conversation messages" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-6 sm:px-8" onScroll={event => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; setAwayFromBottom(!nearBottom.current); if (nearBottom.current) setUnseen(0) }}>
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="mx-auto max-w-sm py-8 text-center"><Shield className="mx-auto mb-3 size-8 text-indigo-300/60" /><h2 className="mb-2 text-xl text-zinc-300">{messages.length ? "Your conversation" : "Start with a hello."}</h2><p className="text-sm leading-relaxed text-zinc-500">Verify this contact’s address through another trusted channel. Messages are encrypted before leaving your device.</p><details className="mt-3 text-xs text-zinc-500"><summary className="cursor-pointer">Contact address</summary><p className="mt-2 select-all break-all font-mono leading-relaxed">{params.pubkey}</p></details></div>
        {messages.map((message, index) => {
          const mine = message.senderPubKey === myPub
          const day = new Date(message.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          const previousDay = index ? new Date(messages[index - 1].timestamp).toDateString() : ""
          const messageKey = `${message.senderPubKey}:${message.id}`
          return <div key={messageKey} ref={node => { if (node) messageNodes.current.set(messageKey, node); else messageNodes.current.delete(messageKey) }} className={activeMatch === messageKey ? "rounded-xl ring-2 ring-amber-300/60 ring-offset-4 ring-offset-zinc-950" : ""}>
            {previousDay !== new Date(message.timestamp).toDateString() && <p className="mb-5 text-center text-xs text-zinc-600">{day}</p>}
            <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}><span className="sr-only">{mine ? "You" : alias || shortAddress(params.pubkey)}:</span>
              <div className={`min-w-0 max-w-[90%] space-y-3 whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-base leading-relaxed [overflow-wrap:anywhere] sm:max-w-[80%] ${mine ? "rounded-br-md bg-indigo-100 text-zinc-950" : "rounded-bl-md border border-zinc-800 bg-zinc-900 text-zinc-200"}`}>
                {message.content && <p><MessageText content={message.content} query={searchTerm} /></p>}
                {!!message.attachments?.length && <MessageAttachments attachments={message.attachments} query={searchTerm} mine={mine} />}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400"><time title={new Date(message.timestamp).toLocaleString()} dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                {mine && message.delivery === "pending" && <span className="flex items-center gap-1"><Loader2 className="size-3 animate-spin" /> Sending</span>}
                {mine && message.delivery === "sent" && <span className="flex items-center gap-1" title="Accepted by the encrypted relay; this is not a read receipt."><Check className="size-3" /> Sent to relay</span>}
                {mine && message.delivery === "failed" && <button type="button" disabled={sending || !ready} className="flex items-center gap-1 rounded px-1 text-red-300 hover:text-red-200 disabled:opacity-50" onClick={() => void retryFailed([message])}><RotateCw className={`size-3 ${retrying === message.id ? "animate-spin" : ""}`} /> {retrying === message.id ? "Retrying" : "Unconfirmed · Retry"}</button>}
                {message.content && <button type="button" className="inline-flex min-h-7 items-center gap-1 rounded px-1 hover:text-zinc-200" aria-label={copiedMessage === messageKey ? "Message copied" : "Copy message text"} onClick={async () => {
                  try { await navigator.clipboard.writeText(message.content); clearTimeout(copyTimer.current); setCopiedMessage(messageKey); setAnnouncement("Message copied."); copyTimer.current = setTimeout(() => setCopiedMessage(""), 2500) }
                  catch { setSendError("Clipboard access was blocked. Select the message text to copy it.") }
                }}>{copiedMessage === messageKey ? <Check className="size-3" /> : <Copy className="size-3" />}{copiedMessage === messageKey ? "Copied" : "Copy"}</button>}
              </div>
            </div>
          </div>
        })}
      </div>
    </div>
    {(awayFromBottom || unseen > 0) && <div className="flex justify-center border-t border-zinc-800/60 py-2"><Button variant="secondary" size="sm" className="rounded-full" onClick={jumpToLatest}><ArrowDown className="mr-2 size-4" /><span aria-live="polite">{unseen ? `${unseen} new message${unseen === 1 ? "" : "s"}` : "Jump to latest"}</span></Button></div>}
    <footer className="shrink-0 border-t border-zinc-800/80 bg-zinc-950 p-4 sm:px-8 sm:py-5">
      {(unconfirmed.length > 1 || batchProgress) && <div className="mx-auto mb-3 flex max-w-3xl flex-wrap items-center justify-between gap-2 text-xs text-amber-200">
        <span role="status">{batchProgress ? `Retrying ${batchProgress.current} of ${batchProgress.total}…` : `${unconfirmed.length} messages have no delivery confirmation.`}</span>
        <Button type="button" size="sm" variant="outline" disabled={!ready || sending} onClick={() => void retryFailed(unconfirmed, true)}><RotateCw className={`mr-2 size-3 ${batchProgress ? "animate-spin" : ""}`} />{batchProgress ? "Retrying…" : `Retry ${unconfirmed.length} unconfirmed`}</Button>
      </div>}
      <form className="mx-auto max-w-3xl" onSubmit={event => { event.preventDefault(); void submit() }}
        onDragEnter={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current++; if (canAttach) setDraggingFiles(true) } }}
        onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = canAttach ? "copy" : "none" } }}
        onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDraggingFiles(false) }}
        onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDraggingFiles(false); if (canAttach && !sendLock.current) void addFiles(Array.from(event.dataTransfer.files)) }}>
        <div className={`rounded-xl border bg-zinc-900 p-2 focus-within:border-indigo-300/60 ${draggingFiles ? "border-indigo-300 ring-2 ring-indigo-300/30" : "border-zinc-700"}`}>
          {draggingFiles && <p role="status" className="px-2 pb-2 text-sm text-indigo-200">Drop files to attach them</p>}
          {!!files.length && <div className="p-1 pb-3"><PendingAttachments files={files} onRemove={removeFile} disabled={sending || preparing} /></div>}
          <div className="flex items-end gap-1 sm:gap-2">
            <input ref={fileInput} type="file" multiple className="hidden" tabIndex={-1} aria-label="Choose files to attach" disabled={!canAttach} onChange={event => { const chosen = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (canAttach && !sendLock.current) void addFiles(chosen) }} />
            <Button type="button" variant="ghost" size="icon" aria-label="Attach files" aria-describedby="attachment-guidance" title="Attach files" disabled={!canAttach || files.length >= MAX_ATTACHMENTS} className="mb-1 shrink-0 text-zinc-400" onClick={() => fileInput.current?.click()}><Paperclip aria-hidden="true" className="size-5" /></Button>
            <Textarea ref={input} aria-label="Message" aria-busy={busy} placeholder={ready ? files.length ? "Add a message…" : "Write a message…" : error ? "Conversation could not open. Try again above." : "Opening conversation…"} value={content} onChange={event => setContent(event.target.value)} maxLength={MAX_MESSAGE_LENGTH} disabled={!ready || !draftReady} readOnly={busy} rows={2} className="max-h-44 min-h-12 resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0"
              onPaste={event => { const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/")); if (images.length) { event.preventDefault(); if (canAttach && !sendLock.current) void addFiles(images) } }}
              onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
            <Button type="submit" aria-label={busy ? "Sending message" : files.length ? `Send message with ${files.length} attached file${files.length === 1 ? "" : "s"}` : "Send message"} disabled={!ready || !draftReady || !attachmentReady || (!content.trim() && !files.length) || sending || preparing} size="icon" className="mb-1 mr-1 shrink-0">{busy || preparing ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Send aria-hidden="true" className="size-4" />}</Button>
          </div>
        </div>
        <div id="attachment-guidance" className="mt-2 text-xs text-zinc-400"><span role="status">{preparing ? "Preparing files…" : files.length ? `${files.length} / ${MAX_ATTACHMENTS} files · ${formatFileSize(attachmentBytes)} / ${formatFileSize(MAX_ATTACHMENT_BYTES)}` : `Attach or drop files, or paste an image · Up to ${MAX_ATTACHMENTS} files and 1 MiB total`}</span>{!!files.length && <p className="mt-1 text-amber-200/80">Unsent files stay in this tab and are lost if you reload or close it.</p>}</div>
        {attachmentIssue && <p role="alert" className="mt-2 text-sm text-amber-200">{attachmentIssue}</p>}
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-zinc-400"><span>Enter to send · Shift + Enter for a new line</span><span className={!draftSaved ? "text-amber-300" : ""}>{!draftSaved ? draftIssue === "read" ? "Saved draft could not be loaded" : draftIssue === "clear" ? "Sent text is waiting to be cleared from storage" : "Draft is only in this tab · Do not reload or close it" : content ? "Draft saved on this browser" : "History saved on this browser"}</span></div>
        {!draftSaved && <Button type="button" size="sm" variant="ghost" onClick={retryDraftSave}>{draftIssue === "read" ? "Try loading draft again" : draftIssue === "clear" ? "Retry draft cleanup" : "Try saving draft again"}</Button>}
        {content.length > MAX_MESSAGE_LENGTH - 1000 && <p className="mt-1 text-right text-xs text-zinc-500">{content.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}</p>}
      </form>
    </footer>
  </div>
}
