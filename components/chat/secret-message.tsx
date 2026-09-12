"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Copy, Eye, EyeOff, KeyRound, Timer } from "lucide-react"
import { Button } from "@/components/ui/button"

function timeRemaining(expiresAt: number, now: number) {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${seconds}s`
}

export function SecretMessage({ content, expiresAt, secret = false }: { content: string; expiresAt: number; secret?: boolean }) {
  const [now, setNow] = useState(Date.now)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState("")
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const expired = now >= expiresAt
  useEffect(() => {
    const refresh = () => setNow(Date.now())
    const hide = () => { setRevealed(false); refresh() }
    const interval = setInterval(refresh, 1000)
    const expiryTimer = setTimeout(hide, Math.max(0, expiresAt - Date.now()))
    window.addEventListener("blur", hide)
    document.addEventListener("visibilitychange", hide)
    return () => { clearInterval(interval); clearTimeout(expiryTimer); clearTimeout(revealTimer.current); clearTimeout(copyTimer.current); window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", hide) }
  }, [expiresAt])
  if (expired) return <p className="text-sm opacity-70">{secret ? "Access key expired" : "Private message expired"}</p>
  return <div className={secret ? "min-w-44 space-y-2 py-1" : "space-y-1"} data-private-message={secret ? "secret" : "text"}>
    {secret ? <><p className="flex items-center gap-2 text-sm font-medium"><KeyRound className="size-4" />Access key</p>{revealed ? <p className="max-h-52 overflow-y-auto whitespace-pre-wrap break-all rounded-md bg-background/15 p-2 font-mono text-sm" data-secret-value>{content}</p> : <p className="font-mono tracking-widest opacity-60" aria-label="Access key hidden">••••••••••••</p>}<div className="flex flex-wrap items-center gap-1"><Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-inherit hover:bg-current/10 hover:text-inherit" onClick={() => {
      if (Date.now() >= expiresAt) { setNow(Date.now()); return }
      clearTimeout(revealTimer.current); setRevealed(value => !value)
      revealTimer.current = setTimeout(() => setRevealed(false), 30000)
    }}>{revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}{revealed ? "Hide key" : "Reveal key"}</Button><Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-inherit hover:bg-current/10 hover:text-inherit" onClick={async () => {
      if (Date.now() >= expiresAt) { setNow(Date.now()); return }
      try { await navigator.clipboard.writeText(content); setCopied(true); setError(""); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 2500) } catch { setError("Clipboard access was blocked. Reveal the key to select and copy it.") }
    }}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "Key copied" : "Copy key"}</Button></div></> : <p className="whitespace-pre-wrap">{content}</p>}
    <p className="flex items-center gap-1 text-[11px] opacity-70" title={`Expires ${new Date(expiresAt).toLocaleString()}`}><Timer className="size-3" />Disappears in {timeRemaining(expiresAt, now)}</p>
    {error && <p role="alert" className="text-xs">{error}</p>}
  </div>
}
