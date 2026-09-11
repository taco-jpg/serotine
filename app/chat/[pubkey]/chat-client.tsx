"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowLeft, Check, Loader2, Lock, Send, Shield, RotateCw, ArrowDown, Search, X, ChevronUp, ChevronDown } from "lucide-react"
import { useP2PChat } from "@/hooks/use-p2p-chat"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { loadContacts, shortAddress } from "@/lib/identity"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"
import { useChatDraft } from "@/hooks/use-chat-draft"
import { MessageSendError } from "@/lib/message-send-error"
import { Input } from "@/components/ui/input"

export default function ChatWindow({ params }: { params: { pubkey: string } }) {
  const { sendMessage, status, messages, myPub, ready, error } = useP2PChat(params.pubkey)
  const { content, setContent, clearSubmittedDraft, draftReady, draftSaved } = useChatDraft(myPub, params.pubkey)
  const [busy, setBusy] = useState(false)
  const [alias, setAlias] = useState("")
  const [sendError, setSendError] = useState("")
  const [retrying, setRetrying] = useState<string | null>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [unseen, setUnseen] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matchIndex, setMatchIndex] = useState(0)
  const seenIds = useRef<Set<string> | null>(null)
  const messageNodes = useRef(new Map<string, HTMLDivElement>())
  const searchInput = useRef<HTMLInputElement>(null)
  const searchTerm = query.trim().toLocaleLowerCase()
  const matches = useMemo(() => searchTerm ? messages.filter(message => message.content.toLocaleLowerCase().includes(searchTerm)).map(message => `${message.senderPubKey}:${message.id}`) : [], [messages, searchTerm])
  const selectedIndex = matches.length ? Math.min(matchIndex, matches.length - 1) : 0
  const activeMatch = matches[selectedIndex]
  const bottom = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const sendLock = useRef(false)
  useEffect(() => {
    if (!ready) return
    const ids = new Set(messages.map(message => `${message.senderPubKey}:${message.id}`))
    if (seenIds.current && !nearBottom.current) {
      const added = messages.filter(message => message.senderPubKey !== myPub && !seenIds.current!.has(`${message.senderPubKey}:${message.id}`)).length
      if (added) setUnseen(previous => previous + added)
    }
    seenIds.current = ids
    if (nearBottom.current && !searchTerm) bottom.current?.scrollIntoView({ behavior: "instant" })
  }, [messages, ready, myPub, searchTerm])
  useEffect(() => {
    if (activeMatch) {
      nearBottom.current = false
      messageNodes.current.get(activeMatch)?.scrollIntoView({ behavior: "instant", block: "center" })
    }
  }, [activeMatch, searchTerm])
  useEffect(() => { if (searchOpen) searchInput.current?.focus() }, [searchOpen])
  const jumpToLatest = () => {
    setQuery(""); nearBottom.current = true; setAwayFromBottom(false); setUnseen(0)
    bottom.current?.scrollIntoView({ behavior: "instant" })
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
    if (!content.trim() || sendLock.current || !ready || !draftReady) return
    sendLock.current = true; setBusy(true); setSendError(""); jumpToLatest()
    const draft = content
    try { await sendMessage(draft); clearSubmittedDraft() }
    catch (cause) {
      setSendError(cause instanceof Error ? cause.message : "Message was not sent.")
      // A durable failed bubble owns its retry. Otherwise keep the only copy here.
      if (cause instanceof MessageSendError && cause.savedLocally) clearSubmittedDraft()
    }
    finally { sendLock.current = false; setBusy(false); input.current?.focus() }
  }
  const statusLabel = { connecting: "Connecting…", online: "Direct connection", relay: "Encrypted relay", offline: "Connection unavailable" }[status]
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex min-h-20 shrink-0 items-center justify-between gap-3 border-b border-zinc-800/80 px-4 py-4 sm:px-7">
      <div className="flex min-w-0 items-center gap-3"><Link href="/chat" aria-label="Back to contacts" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 md:hidden"><ArrowLeft className="size-5" /></Link><IdentityIcon pubKey={params.pubkey} size={38} /><div className="min-w-0"><h1 className="truncate font-sans text-base font-medium">{alias || shortAddress(params.pubkey)}</h1><span className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500"><Lock className="size-3" /> End-to-end encrypted</span></div></div>
      <div className="flex items-center gap-2"><Button variant="ghost" size="icon" aria-label="Search conversation" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(""); setMatchIndex(0) }}><Search className="size-4" /></Button><span role="status" className={`max-w-32 rounded-lg border px-2.5 py-1.5 text-center text-xs sm:max-w-none ${status === "offline" ? "border-amber-400/20 text-amber-300" : "border-zinc-800 text-zinc-400"}`}>{statusLabel}</span></div>
    </header>
    {searchOpen && <div role="search" aria-label="Search saved messages" className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-3 sm:px-7">
      <Input ref={searchInput} aria-label="Search messages" placeholder="Search this conversation…" className="min-w-32 flex-1" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={event => { if (event.key === "Escape") { setSearchOpen(false); setQuery(""); input.current?.focus() } else if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) } }} />
      <span role="status" className="text-xs text-zinc-400">{searchTerm ? matches.length ? `${selectedIndex + 1} of ${matches.length}` : "No matches" : "Saved messages only"}</span>
      <Button variant="ghost" size="icon" aria-label="Previous match" disabled={!matches.length} onClick={() => moveMatch(-1)}><ChevronUp className="size-4" /></Button>
      <Button variant="ghost" size="icon" aria-label="Next match" disabled={!matches.length} onClick={() => moveMatch(1)}><ChevronDown className="size-4" /></Button>
      <Button variant="ghost" size="icon" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery(""); input.current?.focus() }}><X className="size-4" /></Button>
    </div>}
    {(error || sendError) && <div role="alert" className="border-b border-amber-400/10 bg-amber-400/5 px-5 py-3 text-sm leading-relaxed text-amber-200">{sendError || error}</div>}
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8" onScroll={event => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; setAwayFromBottom(!nearBottom.current); if (nearBottom.current) setUnseen(0) }}>
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="mx-auto max-w-sm py-8 text-center"><Shield className="mx-auto mb-3 size-8 text-indigo-300/60" /><h2 className="mb-2 text-xl text-zinc-300">{messages.length ? "Your conversation" : "Start with a hello."}</h2><p className="text-sm leading-relaxed text-zinc-500">Verify this contact’s address through another trusted channel. Messages are encrypted before leaving your device.</p><details className="mt-3 text-xs text-zinc-500"><summary className="cursor-pointer">Contact address</summary><p className="mt-2 select-all break-all font-mono leading-relaxed">{params.pubkey}</p></details></div>
        {messages.map((message, index) => {
          const mine = message.senderPubKey === myPub
          const day = new Date(message.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          const previousDay = index ? new Date(messages[index - 1].timestamp).toDateString() : ""
          const messageKey = `${message.senderPubKey}:${message.id}`
          return <div key={messageKey} ref={node => { if (node) messageNodes.current.set(messageKey, node); else messageNodes.current.delete(messageKey) }} className={activeMatch === messageKey ? "rounded-xl ring-2 ring-amber-300/60 ring-offset-4 ring-offset-zinc-950" : ""}>
            {previousDay !== new Date(message.timestamp).toDateString() && <p className="mb-5 text-center text-xs text-zinc-600">{day}</p>}
            <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              <div className={`max-w-[90%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-base leading-relaxed [overflow-wrap:anywhere] sm:max-w-[80%] ${mine ? "rounded-br-md bg-indigo-100 text-zinc-950" : "rounded-bl-md border border-zinc-800 bg-zinc-900 text-zinc-200"}`}>{message.content}</div>
              <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500"><time dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                {mine && message.delivery === "pending" && <span className="flex items-center gap-1"><Loader2 className="size-3 animate-spin" /> Sending</span>}
                {mine && message.delivery === "sent" && <span className="flex items-center gap-1" title="Accepted by the encrypted relay; this is not a read receipt."><Check className="size-3" /> Sent to relay</span>}
                {mine && message.delivery === "failed" && <button disabled={retrying === message.id} className="flex items-center gap-1 rounded px-1 text-red-300 hover:text-red-200 disabled:opacity-50" onClick={async () => { setRetrying(message.id); setSendError(""); try { await sendMessage(message.content, message) } catch (cause) { setSendError((cause as Error).message) } finally { setRetrying(null) } }}><RotateCw className={`size-3 ${retrying === message.id ? "animate-spin" : ""}`} /> {retrying === message.id ? "Retrying" : "Not sent · Retry"}</button>}
              </div>
            </div>
          </div>
        })}
        <div ref={bottom} />
      </div>
    </div>
    {(awayFromBottom || unseen > 0) && <div className="flex justify-center border-t border-zinc-800/60 py-2"><Button variant="secondary" size="sm" className="rounded-full" onClick={jumpToLatest}><ArrowDown className="mr-2 size-4" /><span aria-live="polite">{unseen ? `${unseen} new message${unseen === 1 ? "" : "s"}` : "Jump to latest"}</span></Button></div>}
    <footer className="shrink-0 border-t border-zinc-800/80 bg-zinc-950 p-4 sm:px-8 sm:py-5">
      <form className="mx-auto max-w-3xl" onSubmit={event => { event.preventDefault(); void submit() }}>
        <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-2 focus-within:border-indigo-300/60">
          <Textarea ref={input} aria-label="Message" placeholder={ready ? "Write a message…" : "Opening conversation…"} value={content} onChange={event => setContent(event.target.value)} maxLength={MAX_MESSAGE_LENGTH} disabled={!ready || !draftReady || busy} rows={2} className="max-h-44 min-h-12 resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0" onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
          <Button type="submit" aria-label="Send message" disabled={!ready || !draftReady || !content.trim() || busy} size="icon" className="mb-1 mr-1 shrink-0">{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button>
        </div>
        <div className="mt-2 flex justify-between gap-3 text-xs text-zinc-500"><span>Enter to send · Shift + Enter for a new line</span><span className={!draftSaved ? "text-amber-300" : ""}>{!draftSaved ? "Draft could not be saved · Keep this tab open" : content ? "Draft saved on this browser" : "History saved on this browser"}</span></div>
        {content.length > MAX_MESSAGE_LENGTH - 1000 && <p className="mt-1 text-right text-xs text-zinc-500">{content.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}</p>}
      </form>
    </footer>
  </div>
}
