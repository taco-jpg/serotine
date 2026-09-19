"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Send, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { requestAiSummary } from "@/lib/ai-summary-client"
import { selectSummaryRange } from "@/lib/ai-summary"
import type { Identity } from "@/lib/identity"
import type { MessageRecord } from "@/lib/messaging-types"

// Mount only while open. The preview and generated result never enter draft or history storage.
export function AiSummaryDialog({ identity, conversationId, messages, isAllowed, canSend = true, onClose, onSend }: {
  identity: Identity
  conversationId: string
  messages: readonly MessageRecord[]
  isAllowed: () => boolean
  canSend?: boolean
  onClose: () => void
  onSend: (summary: string) => Promise<void>
}) {
  const [range] = useState(() => selectSummaryRange(messages, conversationId, identity.publicKey))
  const [summary, setSummary] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [sending, setSending] = useState(false)
  const request = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    mounted.current = true
    const cancel = () => { request.current?.abort(); closeRef.current() }
    window.addEventListener("serotine:identity-changing", cancel)
    return () => { mounted.current = false; request.current?.abort(); window.removeEventListener("serotine:identity-changing", cancel) }
  }, [])
  const close = () => { request.current?.abort(); setSummary(""); onClose() }
  const generate = async () => {
    if (busy || !range.messages.length || !isAllowed()) return
    const controller = new AbortController()
    request.current = controller; setBusy(true); setError("")
    try {
      const result = await requestAiSummary(identity, range.messages, controller.signal, isAllowed)
      if (mounted.current && !controller.signal.aborted && request.current === controller && isAllowed()) setSummary(result)
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The summary could not be generated. Try again.")
    } finally { if (mounted.current && request.current === controller) { request.current = null; setBusy(false) } }
  }
  const send = async () => {
    if (sending || !summary || !isAllowed() || !canSend) return
    setSending(true); setError("")
    try { await onSend(summary); if (mounted.current) close() }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : "The summary could not be sent. Your draft is unchanged.") }
    finally { if (mounted.current) setSending(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open) close() }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{summary ? "Your local summary" : "Summarize conversation"}</DialogTitle><DialogDescription>{summary ? "Only you can see this result. It will disappear when you close this dialog or leave the conversation." : "Review the exact message text that will be shared before continuing."}</DialogDescription></DialogHeader>
    {summary ? <div className="space-y-3"><div aria-label="Generated summary" className="max-h-[45dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-4 text-sm leading-relaxed">{summary}</div><p className="text-xs leading-relaxed text-muted-foreground">AI can make mistakes. Check the original messages. “Send summary” shares this result with the conversation as an ordinary message.</p></div> : <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed"><p className="font-medium">The text below will be sent to the Serotine server and Cloudflare AI.</p><p className="mt-2 text-muted-foreground">Private messages, access-key messages, files, and polls are excluded. Contact names and addresses are not added to the text. Ordinary text may itself contain sensitive information; review it before sharing.</p></div>
      <p className="text-sm text-muted-foreground">{range.mode === "since-reply" ? "Ordinary messages since your last sent text reply." : "No earlier text reply was found. Using ordinary messages from the last 24 hours."} {range.messages.length} messages.{range.truncated && " Limited to the most recent text that fits; some text is shortened."}</p>
      {range.fromTimestamp !== undefined && range.toTimestamp !== undefined && <p className="text-xs text-muted-foreground">{new Date(range.fromTimestamp).toLocaleString()} – {new Date(range.toTimestamp).toLocaleString()}</p>}
      <div role="region" aria-label="Messages to summarize" tabIndex={0} className="max-h-[30dvh] space-y-3 overflow-y-auto rounded-lg border border-border p-3">{range.messages.length ? range.messages.map((message, index) => <div key={index}><p className="text-xs font-medium text-muted-foreground">{message.speaker}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm">{message.text}</p></div>) : <p className="text-sm text-muted-foreground">There are no eligible ordinary messages in this range.</p>}</div>
      <p className="text-xs text-muted-foreground">The summary is shown only here. This action does not send a message to the conversation.</p>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter><Button variant="outline" onClick={close}>{busy ? "Cancel request" : summary ? "Close summary" : "Cancel"}</Button>{summary ? <Button disabled={sending || !isAllowed() || !canSend} onClick={() => void send()}>{sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}Send summary</Button> : <Button disabled={busy || !range.messages.length || !isAllowed()} onClick={() => void generate()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{busy ? "Summarizing…" : "Send to AI and summarize"}</Button>}</DialogFooter>
  </DialogContent></Dialog>
}
