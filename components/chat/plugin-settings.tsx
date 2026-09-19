"use client"

import { useState } from "react"
import { Loader2, Puzzle, ShieldCheck, Trash2 } from "lucide-react"
import { useMessaging } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"

function PluginSettingsContent({ onClose }: { onClose: () => void }) {
  const { plugins, ready, setPluginEnabled, removePlugin } = useMessaging()
  const [consentId, setConsentId] = useState<string | null>(null)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const selected = plugins.find(plugin => plugin.manifest.id === consentId)
  const act = async (action: () => Promise<void>) => {
    if (busy || !ready) return
    setBusy(true); setError("")
    try { await action(); setConsentId(null); setAccepted(false) }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The plugin could not be updated. Try again.") }
    finally { setBusy(false) }
  }
  return <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
    <DialogHeader><DialogTitle>{selected ? `Enable ${selected.manifest.name}?` : "Plugins"}</DialogTitle><DialogDescription>{selected ? "Review what this optional feature can access before enabling it." : "Optional Serotine features for this identity on this browser. Installing here does not install a plugin for anyone else."}</DialogDescription></DialogHeader>
    {selected ? <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{selected.manifest.description}</p>
      <ul className="space-y-3">{selected.manifest.permissions.map(permission => <li key={permission.id} className="rounded-lg border border-border p-3"><p className="flex items-center gap-2 text-sm font-medium"><ShieldCheck className="size-4 shrink-0" />{permission.label}</p><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{permission.description}</p></li>)}</ul>
      <label className="flex cursor-pointer items-start gap-3 text-sm"><input type="checkbox" className="mt-1 size-4 shrink-0 accent-primary" checked={accepted} disabled={busy || !ready} onChange={event => setAccepted(event.target.checked)} /><span>Allow these permissions for this identity on this browser</span></label>
      <p className="text-xs leading-relaxed text-muted-foreground">You can disable or remove this plugin at any time. Ordinary messages stay intact.</p>
    </div> : <div className="space-y-4">{plugins.map(plugin => <section key={plugin.manifest.id} role="group" aria-label={plugin.manifest.name} className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 text-sm font-medium"><Puzzle className="size-4 shrink-0" />{plugin.manifest.name}</h3><p className="mt-1 text-xs text-muted-foreground">Version {plugin.manifest.version} · {plugin.manifest.shared ? "Requires compatible peer support" : "Local feature"}</p></div><span className="shrink-0 rounded bg-muted px-2 py-1 text-xs">{plugin.enabled ? "Enabled" : plugin.installed ? "Disabled" : "Not installed"}</span></div>
      <p className="text-sm leading-relaxed text-muted-foreground">{plugin.manifest.description}</p>
      <div className="flex flex-wrap gap-2">{plugin.enabled ? <Button size="sm" variant="outline" disabled={busy || !ready} onClick={() => void act(() => setPluginEnabled(plugin.manifest.id, false))}>Disable</Button> : <Button size="sm" disabled={busy || !ready} onClick={() => { setConsentId(plugin.manifest.id); setAccepted(false); setError("") }}>{plugin.installed ? "Enable" : "Install and enable"}</Button>}{plugin.installed && <Button size="sm" variant="ghost" disabled={busy || !ready} onClick={() => void act(() => removePlugin(plugin.manifest.id))}><Trash2 className="size-4" />Remove</Button>}</div>
    </section>)}<p className="text-xs leading-relaxed text-muted-foreground">Existing private-message timers keep running when Private Chat is disabled or removed. AI summaries are discarded when closed and are never saved unless you choose to send one.</p></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <DialogFooter>{selected ? <><Button variant="outline" disabled={busy} onClick={() => { setConsentId(null); setAccepted(false); setError("") }}>Back</Button><Button disabled={!accepted || busy || !ready} onClick={() => void act(() => setPluginEnabled(selected.manifest.id, true, true))}>{busy && <Loader2 className="size-4 animate-spin" />}Allow and enable</Button></> : <Button variant="outline" onClick={onClose}>Done</Button>}</DialogFooter>
  </DialogContent>
}

export function PluginSettings({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { identity } = useMessaging()
  return <Dialog open={open} onOpenChange={onOpenChange}>{open && <PluginSettingsContent key={identity?.publicKey || "loading"} onClose={() => onOpenChange(false)} />}</Dialog>
}
