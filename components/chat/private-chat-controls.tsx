"use client"

import { useEffect, useRef, useState } from "react"
import { Check, Copy, Eye, EyeOff, KeyRound, Loader2, Timer, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { PrivateTtlSeconds } from "@/lib/messaging-types"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"

export const privateDurationLabel = (seconds: number) => seconds === 300 ? "5 minutes" : seconds === 3600 ? "1 hour" : "24 hours"
const durationOptions = <><option value="300">5 minutes</option><option value="3600">1 hour</option><option value="86400">24 hours</option></>
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "That action could not be completed. Try again."

function PrivateModeDetails() {
  return <details className="text-xs leading-relaxed text-muted-foreground"><summary className="cursor-pointer">How private messages work</summary><div className="mt-2 space-y-2"><p>Both people need an updated Serotine. Timers start when a message is sent. Private messages are excluded from backups, search, and pins.</p><p>A recipient can keep a copy or screenshot. Expiration does not revoke an access key; revoke it with the service that issued it when needed.</p><p>Encrypted relay copies age out under the relay’s retention policy; destroying history does not immediately erase them.</p></div></details>
}

export function PrivateChatControls({ open, onOpenChange, ttlSeconds, disabled, onSetMode, onDestroy }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  ttlSeconds: PrivateTtlSeconds
  disabled: boolean
  onSetMode: (seconds: PrivateTtlSeconds) => Promise<void>
  onDestroy: () => Promise<void>
}) {
  const [selected, setSelected] = useState(ttlSeconds)
  const [busy, setBusy] = useState(false)
  const [confirmDestroy, setConfirmDestroy] = useState(false)
  const [error, setError] = useState("")
  const cancelDestroy = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (open) { setSelected(ttlSeconds); setConfirmDestroy(false); setError("") } }, [open, ttlSeconds])
  useEffect(() => { if (confirmDestroy) cancelDestroy.current?.focus() }, [confirmDestroy])
  const act = async (action: () => Promise<void>) => {
    if (busy || disabled) return
    setBusy(true); setError("")
    try { await action(); onOpenChange(false) } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value) }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{confirmDestroy ? "Destroy private history?" : "Private chat"}</DialogTitle><DialogDescription>{confirmDestroy ? "Remove all private messages and access keys sent so far in this conversation. This cannot be undone." : "Set a shared timer for new text messages in this direct conversation."}</DialogDescription></DialogHeader>
    {confirmDestroy ? <><p className="text-sm leading-relaxed text-muted-foreground">They disappear here immediately. The other person’s updated Serotine removes them when it receives the request. Ordinary messages remain. Copies or screenshots they saved cannot be removed.</p>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<DialogFooter><Button ref={cancelDestroy} variant="outline" disabled={busy} onClick={() => setConfirmDestroy(false)}>Cancel</Button><Button variant="destructive" disabled={busy || disabled} onClick={() => void act(onDestroy)}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}Destroy private history</Button></DialogFooter></> : <div className="space-y-4">
      <div className="space-y-2"><Label htmlFor="private-chat-duration">New messages disappear after</Label><select id="private-chat-duration" value={selected} disabled={busy || disabled} onChange={event => setSelected(Number(event.target.value) as PrivateTtlSeconds)} className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm"><option value="0">Off — keep new messages</option>{durationOptions}</select><p className="text-xs leading-relaxed text-muted-foreground">Changing this setting applies to both people’s new messages. Existing timers keep running. Private mode supports plain text and access keys.</p></div>
      <PrivateModeDetails />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || disabled || selected === ttlSeconds} onClick={() => void act(() => onSetMode(selected))}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Timer className="size-4" />}Save timer</Button></DialogFooter>
      <div className="border-t border-border pt-4"><Button variant="outline" className="text-destructive" disabled={busy || disabled} onClick={() => setConfirmDestroy(true)}><Trash2 className="size-4" />Destroy private history</Button></div>
    </div>}
  </DialogContent></Dialog>
}

// Mounted only while open, so cancelling or switching conversations discards the input.
export function ShareSecretDialog({ recipientName, recipientAddress, disabled, onClose, onSend }: {
  recipientName: string
  recipientAddress: string
  disabled: boolean
  onClose: () => void
  onSend: (content: string, ttlSeconds: number) => Promise<void>
}) {
  const [secret, setSecret] = useState("")
  const [revealed, setRevealed] = useState(false)
  const [ttlSeconds, setTtlSeconds] = useState(3600)
  const [copiedAddress, setCopiedAddress] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    const hide = () => setRevealed(false)
    window.addEventListener("blur", hide)
    document.addEventListener("visibilitychange", hide)
    return () => { window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", hide) }
  }, [])
  useEffect(() => { if (revealed) { const timer = setTimeout(() => setRevealed(false), 30000); return () => clearTimeout(timer) } }, [revealed])
  return <Dialog open onOpenChange={open => { if (!open && !busy) { setSecret(""); onClose() } }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Share an access key</DialogTitle><DialogDescription>Send an encrypted, hidden key to {recipientName}. The timer starts when you send it.</DialogDescription></DialogHeader>
    <form autoComplete="off" className="space-y-4" onSubmit={async event => {
      event.preventDefault()
      if (busy || disabled || !secret.trim()) return
      setBusy(true); setError(""); setRevealed(false)
      try { await onSend(secret, ttlSeconds); setSecret(""); onClose() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
    }}>
      <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3"><p className="text-sm font-medium">Recipient: {recipientName}</p><p className="select-all break-all font-mono text-xs text-muted-foreground">{recipientAddress}</p><div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={async () => { try { await navigator.clipboard.writeText(recipientAddress); setCopiedAddress(true) } catch { setError("Clipboard access was blocked. Select the address to copy it.") } }}>{copiedAddress ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copiedAddress ? "Address copied" : "Copy address"}</Button><p className="text-xs text-muted-foreground">Verify this address with them first.</p></div></div>
      <div className="space-y-2"><Label htmlFor="shared-access-key">Access key</Label><div className="flex items-center gap-2"><Input id="shared-access-key" type={revealed ? "text" : "password"} autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false} data-1p-ignore data-lpignore="true" value={secret} onChange={event => setSecret(event.target.value)} maxLength={MAX_MESSAGE_LENGTH} disabled={busy || disabled} required aria-describedby="access-key-draft-note" className="min-w-0 font-mono" /><Button type="button" variant="ghost" size="icon" aria-label={revealed ? "Hide access key input" : "Reveal access key input"} disabled={busy || disabled} onClick={() => setRevealed(value => !value)}>{revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button></div><p id="access-key-draft-note" className="text-xs text-muted-foreground">This draft stays only in this open dialog. Its value is sent exactly as entered.</p></div>
      <div className="space-y-2"><Label htmlFor="access-key-duration">Key message disappears after</Label><select id="access-key-duration" value={ttlSeconds} disabled={busy || disabled} onChange={event => setTtlSeconds(Number(event.target.value))} className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm">{durationOptions}</select></div>
      <p className="text-xs leading-relaxed text-muted-foreground">The recipient needs an updated Serotine and can reveal or copy this key. Deleting the message cannot revoke the key or remove copies they keep.</p>
      <PrivateModeDetails />
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setSecret(""); onClose() }}>Cancel</Button><Button type="submit" disabled={busy || disabled || !secret.trim()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />}Send access key</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}
