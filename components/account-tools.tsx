"use client"

import { useId, useState } from "react"
import { Download, HardDriveDownload, Loader2, MonitorSmartphone, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import type { Identity } from "@/lib/identity"
import { exportFullBackup, MAX_BACKUP_FILE_BYTES, restoreBackup } from "@/lib/full-backup"

export function AccountTools({ identity }: { identity: Identity }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<"backup" | "link" | "restore">("backup")
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const download = async () => {
    if (password !== confirmation) throw new Error("The backup passwords do not match.")
    const text = await exportFullBackup(identity, password)
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `serotine-backup-${identity.publicKey.slice(0, 10)}-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setStatus(mode === "link" ? "Download started. Transfer this file to your other device and restore it there using this password." : "Backup download started. Keep the file and its password somewhere you can recover them.")
    setPassword(""); setConfirmation("")
  }
  const run = async () => {
    setBusy(true); setError(null); setStatus(null)
    try {
      if (mode === "restore") {
        if (!file) throw new Error("Choose a Serotine backup first.")
        if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error("Choose a backup no larger than 100 MiB.")
        await restoreBackup(await file.text(), password)
        window.location.assign("/chat")
      } else await download()
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The backup could not be completed.") }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={value => {
    if (busy) return
    setOpen(value); setError(null); setStatus(null)
    if (!value) { setPassword(""); setConfirmation(""); setFile(null); setShowPassword(false) }
  }}>
    <DialogTrigger asChild><Button variant="ghost" size="icon" title="Backups and linked devices" aria-label="Backups and linked devices"><HardDriveDownload className="size-4" /></Button></DialogTrigger>
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>{mode === "link" ? "Link another device" : mode === "restore" ? "Restore a backup" : "Back up your conversations"}</DialogTitle>
        <DialogDescription>{mode === "link" ? "Use the same Serotine identity on your computer and phone." : mode === "restore" ? "Restore your identity and merge saved conversations into this browser." : "Save an encrypted copy of your identity, contacts, messages, polls, files, voice messages and chat settings."}</DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-2" aria-label="Backup actions">
        {(["backup", "link", "restore"] as const).map(value => <Button key={value} size="sm" variant={mode === value ? "secondary" : "ghost"} aria-pressed={mode === value} disabled={busy} onClick={() => {
          setMode(value); setError(null); setStatus(null); setPassword(""); setConfirmation("")
        }}>{value === "backup" ? "Backup" : value === "link" ? "Link another device" : "Restore"}</Button>)}
      </div>
      {mode === "link" && <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
        <li>Choose a password below and download your encrypted backup.</li>
        <li>Transfer that file to your other device.</li>
        <li>Open Serotine there, choose <strong>I have a backup</strong>, and restore the file with your password.</li>
        <li>Keep Serotine open to receive new messages on either device. This backup carries your existing history.</li>
      </ol>}
      {error && <p role="alert" className="rounded-md border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-300">{error}</p>}
      {status && <p role="status" className="rounded-md border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-300">{status}</p>}
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); void run() }}>
        {mode === "restore" && <div className="space-y-2"><Label htmlFor={`${id}-file`}>Serotine backup</Label><Input id={`${id}-file`} type="file" accept=".json,application/json" required disabled={busy} onChange={event => setFile(event.target.files?.[0] ?? null)} /><p className="text-xs text-muted-foreground">Full backups and older identity backups are supported, up to 100 MiB. Existing messages are preserved.</p></div>}
        <div className="space-y-2"><Label htmlFor={`${id}-password`}>Backup password</Label><Input id={`${id}-password`} type={showPassword ? "text" : "password"} autoComplete={mode === "restore" ? "current-password" : "new-password"} minLength={mode === "restore" ? undefined : 12} maxLength={1024} required={mode !== "restore"} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} />
          <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={showPassword} onChange={event => setShowPassword(event.target.checked)} />Show password</label>
          <p className="text-xs text-muted-foreground">{mode === "restore" ? "Leave blank only for an older unencrypted identity export." : "At least 12 characters. You need this password to restore the file."}</p>
        </div>
        {mode !== "restore" && <div className="space-y-2"><Label htmlFor={`${id}-confirmation`}>Confirm password</Label><Input id={`${id}-confirmation`} type={showPassword ? "text" : "password"} autoComplete="new-password" required maxLength={1024} disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></div>}
        <Button type="submit" className="w-full" disabled={busy || (mode === "restore" ? !file : password.length < 12 || !confirmation)}>
          {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : mode === "restore" ? <Upload className="mr-2 size-4" /> : mode === "link" ? <MonitorSmartphone className="mr-2 size-4" /> : <Download className="mr-2 size-4" />}
          {busy ? (mode === "restore" ? "Restoring…" : "Encrypting backup…") : mode === "restore" ? "Restore backup" : mode === "link" ? "Download device transfer" : "Download encrypted backup"}
        </Button>
      </form>
    </DialogContent>
  </Dialog>
}
