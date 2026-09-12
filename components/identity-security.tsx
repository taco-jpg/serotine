"use client"

import { useId, useState } from "react"
import { Loader2, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { replaceRetiredIdentity, type Identity } from "@/lib/identity"
import { createRequestProof } from "@/lib/request-auth"
import { retireIdentity } from "@/lib/relay-client"

export function IdentitySecurity({ identity, onBusyChange }: { identity: Identity; onBusyChange?: (busy: boolean) => void }) {
  const id = useId()
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const retire = async () => {
    if (!confirmed || busy) return
    setBusy(true); onBusyChange?.(true); setError(null)
    try {
      await replaceRetiredIdentity(identity.publicKey, async () => {
        const data = {}
        const proof = await createRequestProof("identity:retire", data, identity.privateKey, identity.publicKey)
        const result = await retireIdentity(data, proof)
        if (!result.success) throw new Error(result.error)
      })
      window.location.assign("/chat")
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The identity could not be retired. Reconnect and retry.")
    } finally { setBusy(false); onBusyChange?.(false) }
  }
  return <div className="min-w-0 space-y-4">
    <div className="space-y-2 text-sm text-muted-foreground">
      <h3 className="font-semibold text-foreground">Leaked a backup password?</h3>
      <p>Downloaded backups cannot be erased or have their password changed remotely. Someone with an old file and its password can still read what is inside.</p>
      <p>Retiring this identity permanently blocks its keys from sending or receiving through this Serotine server, including copies in old backups and on linked devices.</p>
      <p>You will get a new address. Your contacts will be copied, and your old identity and chats will stay saved separately on this browser. Share your new address with your contacts and ask group administrators to add it.</p>
      <p>Afterward, make a fresh backup with a new password and use it to link your phone. Replacing a backup file alone does not retire an identity.</p>
    </div>
    <div className="rounded-md border p-3 text-xs">
      <p className="mb-1 font-medium">Address being retired</p>
      <p className="break-all font-mono select-all">{identity.publicKey}</p>
    </div>
    {error && <p role="alert" className="rounded-md border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">{error}</p>}
    <label htmlFor={`${id}-confirm`} className="flex items-start gap-3 text-sm">
      <input id={`${id}-confirm`} type="checkbox" className="mt-1 size-4 shrink-0" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
      <span>I understand this permanently disables my old address on this server and my linked devices must use a new backup.</span>
    </label>
    <Button variant="destructive" className="h-auto min-h-11 w-full whitespace-normal py-3" disabled={!confirmed || busy} onClick={() => void retire()}>
      {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldAlert className="size-4" />}
      {busy ? "Retiring identity…" : "Retire old identity and create new address"}
    </Button>
  </div>
}
