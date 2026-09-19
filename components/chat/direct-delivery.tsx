"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { DIRECT_FILE_BYTES, DIRECT_NOTICE } from "@/lib/direct-protocol"
import type { MessagingContextValue } from "@/lib/messaging-types"

export function DirectDelivery({ messaging, conversationId, privateMode }: { messaging: MessagingContextValue; conversationId: string; privateMode: boolean }) {
  const mode = messaging.getDeliveryMode(conversationId), status = messaging.getDirectStatus(conversationId)
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("")
  const [progress, setProgress] = useState<number | null>(null)
  const transfer = useRef<AbortController | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  useEffect(() => () => { transfer.current?.abort() }, [conversationId])
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(""); try { await action() } catch (cause) { setError(cause instanceof Error ? cause.message : "Direct setup failed.") } finally { setBusy(false) } }
  return <div className="border-b border-border px-4 py-2 text-xs">
    <details>
      <summary className="cursor-pointer py-1">Delivery: {mode === "direct-only" ? "Force P2P" : "Encrypted relay"}</summary>
      <p className="my-2 max-w-2xl leading-6">{DIRECT_NOTICE}</p>
      <p className="mb-2 text-muted-foreground">Earlier relay traffic remains earlier traffic. Switching modes does not resend pending direct messages. Force P2P supports text and files up to 2 MiB; polls, edits, pins, voice recording and server file tools are unavailable.</p>
      {mode === "relay" ? <><label className="mb-2 flex items-start gap-2"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />I understand online-only delivery and network address sharing.</label><Button size="sm" disabled={!consent || busy} onClick={() => void act(() => messaging.setDeliveryMode(conversationId, "direct-only"))}>Enable Force P2P</Button></>
        : <Button size="sm" variant="outline" disabled={busy || progress !== null} onClick={() => void act(() => messaging.setDeliveryMode(conversationId, "relay"))}>Use encrypted relay for new messages</Button>}
    </details>
    {mode === "direct-only" && <div className="mt-2 flex flex-wrap items-center gap-2">
      <span role="status">{status.reason}</span>
      <Button size="sm" variant="outline" disabled={busy || status.state === "connecting" || progress !== null} onClick={() => void act(() => messaging.connectDirect(conversationId))}>{status.state === "connected" ? "Reconnect directly" : "Connect directly"}</Button>
      {!privateMode && <><input ref={picker} type="file" aria-label="Direct file, up to 2 MiB" className="hidden" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return
        if (file.size > DIRECT_FILE_BYTES) { setError("Choose a file up to 2 MiB. This file has not been uploaded."); return }
        const controller = new AbortController(); transfer.current = controller; setProgress(0)
        void act(() => messaging.sendDirectFile(conversationId, file, controller.signal, setProgress)).finally(() => { setProgress(null); transfer.current = null })
      }} /><Button size="sm" variant="outline" disabled={busy || status.state !== "connected" || progress !== null} onClick={() => picker.current?.click()}>Send direct file · 2 MiB max</Button></>}
      {progress !== null && <><progress aria-label="Direct file transfer" max={100} value={progress} /><span>{progress}%</span><Button size="sm" variant="ghost" onClick={() => transfer.current?.abort()}>Cancel transfer</Button></>}
    </div>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
  </div>
}
