"use client"

import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { ArrowLeft, Check, Loader2, Lock, Send, Shield, RotateCw } from "lucide-react"
import { useP2PChat } from "@/hooks/use-p2p-chat"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { loadContacts, shortAddress } from "@/lib/identity"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"

export default function ChatWindow({ params }: { params: { pubkey: string } }) {
  const { sendMessage, status, messages, myPub, ready, error } = useP2PChat(params.pubkey)
  const [content, setContent] = useState("")
  const [busy, setBusy] = useState(false)
  const [alias, setAlias] = useState("")
  const [sendError, setSendError] = useState("")
  const [retrying, setRetrying] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const sendLock = useRef(false)
  useEffect(() => {
    if (nearBottom.current) bottom.current?.scrollIntoView({ behavior: "instant" })
  }, [messages])
  useEffect(() => {
    const refresh = () => { if (myPub) { try { setAlias(loadContacts(myPub).find(c => c.pub === params.pubkey)?.alias || "") } catch { setAlias("") } } }
    refresh(); window.addEventListener("serotine:contacts", refresh)
    return () => window.removeEventListener("serotine:contacts", refresh)
  }, [myPub, params.pubkey])
  const submit = async () => {
    if (!content.trim() || sendLock.current || !ready) return
    sendLock.current = true; setBusy(true); setSendError(""); nearBottom.current = true
    const draft = content
    try { await sendMessage(draft); setContent("") }
    catch (cause) { setSendError(cause instanceof Error ? cause.message : "Message was not sent."); setContent("") }
    finally { sendLock.current = false; setBusy(false); input.current?.focus() }
  }
  const statusLabel = { connecting: "Connecting…", online: "Direct connection", relay: "Encrypted relay", offline: "Connection unavailable" }[status]
  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex min-h-20 shrink-0 items-center justify-between gap-3 border-b border-zinc-800/80 px-4 py-4 sm:px-7">
      <div className="flex min-w-0 items-center gap-3"><Link href="/chat" aria-label="Back to contacts" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-900 md:hidden"><ArrowLeft className="size-5" /></Link><IdentityIcon pubKey={params.pubkey} size={38} /><div className="min-w-0"><h1 className="truncate font-sans text-base font-medium">{alias || shortAddress(params.pubkey)}</h1><span className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500"><Lock className="size-3" /> End-to-end encrypted</span></div></div>
      <span role="status" className={`max-w-32 rounded-lg border px-2.5 py-1.5 text-center text-xs sm:max-w-none ${status === "offline" ? "border-amber-400/20 text-amber-300" : "border-zinc-800 text-zinc-400"}`}>{statusLabel}</span>
    </header>
    {(error || sendError) && <div role="alert" className="border-b border-amber-400/10 bg-amber-400/5 px-5 py-3 text-sm leading-relaxed text-amber-200">{sendError || error}</div>}
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8" onScroll={event => { const node = event.currentTarget; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120 }}>
      <div className="mx-auto max-w-3xl space-y-5">
        <div className="mx-auto max-w-sm py-8 text-center"><Shield className="mx-auto mb-3 size-8 text-indigo-300/60" /><h2 className="mb-2 text-xl text-zinc-300">{messages.length ? "Your conversation" : "Start with a hello."}</h2><p className="text-sm leading-relaxed text-zinc-500">Verify this contact’s address through another trusted channel. Messages are encrypted before leaving your device.</p><details className="mt-3 text-xs text-zinc-500"><summary className="cursor-pointer">Contact address</summary><p className="mt-2 select-all break-all font-mono leading-relaxed">{params.pubkey}</p></details></div>
        {messages.map((message, index) => {
          const mine = message.senderPubKey === myPub
          const day = new Date(message.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
          const previousDay = index ? new Date(messages[index - 1].timestamp).toDateString() : ""
          return <div key={`${message.senderPubKey}:${message.id}`}>
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
    <footer className="shrink-0 border-t border-zinc-800/80 bg-zinc-950 p-4 sm:px-8 sm:py-5">
      <form className="mx-auto max-w-3xl" onSubmit={event => { event.preventDefault(); void submit() }}>
        <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 p-2 focus-within:border-indigo-300/60">
          <Textarea ref={input} aria-label="Message" placeholder={ready ? "Write a message…" : "Opening conversation…"} value={content} onChange={event => setContent(event.target.value)} maxLength={MAX_MESSAGE_LENGTH} disabled={!ready || busy} rows={2} className="max-h-44 min-h-12 resize-none border-0 bg-transparent text-base shadow-none focus-visible:ring-0" onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit() } }} />
          <Button type="submit" aria-label="Send message" disabled={!ready || !content.trim() || busy} size="icon" className="mb-1 mr-1 shrink-0">{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button>
        </div>
        <div className="mt-2 flex justify-between gap-3 text-xs text-zinc-500"><span>Enter to send · Shift + Enter for a new line</span><span>{content.length > 7000 ? `${content.length.toLocaleString()} / 8,000` : "Saved on this browser"}</span></div>
      </form>
    </footer>
  </div>
}
