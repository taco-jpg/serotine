"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, KeyRound, Upload, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createIdentity, loadIdentity, IdentityAccessError, IdentityConflictError } from "@/lib/identity"
import { MAX_BACKUP_FILE_BYTES, restoreBackup } from "@/lib/full-backup"
import { RestoreConfirmation } from "@/components/auth/restore-confirmation"

export function LoginForm() {
  const router = useRouter()
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [checking, setChecking] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasIdentity, setHasIdentity] = useState(false)
  const [restore, setRestore] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [password, setPassword] = useState("")
  const [blocked, setBlocked] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [conflict, setConflict] = useState<IdentityConflictError | null>(null)
  useEffect(() => {
    let active = true
    setChecking(true); setBlocked(false); setRecoveryRequired(false); setError(null)
    void loadIdentity().then(identity => { if (active) setHasIdentity(!!identity) }).catch(cause => {
      if (!active) return
      setHasIdentity(false); setError(cause.message)
      if (cause instanceof IdentityAccessError) setBlocked(true)
      else { setRestore(true); setRecoveryRequired(true) }
    }).finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [attempt])
  const run = async (action: () => Promise<unknown>) => {
    setLoading(true); setError(null)
    try { await action(); router.replace("/chat") }
    catch (cause) {
      if (cause instanceof IdentityConflictError) { setConflict(cause); setShowPassword(false) }
      else { setConflict(null); setError(cause instanceof Error ? cause.message : "Could not open your identity.") }
    }
    finally { setLoading(false) }
  }
  const restoreFile = (replaceIdentity?: string) => run(async () => {
    if (!file) throw new Error("Choose a Serotine backup first.")
    if (file.size > MAX_BACKUP_FILE_BYTES) throw new Error("Choose a Serotine backup no larger than 100 MiB.")
    return restoreBackup(await file.text(), password, { replaceIdentity })
  })
  const toggleRestore = () => { setRestore(!restore); setError(null); setConflict(null); setPassword(""); setShowPassword(false); setFile(null) }
  if (checking) return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Checking this browser…</p>
  return <div className="space-y-5">
    {error && <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {blocked ? <Button className="h-12 w-full" onClick={() => setAttempt(value => value + 1)}>Check again</Button> : hasIdentity && !restore ? <>
      <p className="text-sm leading-relaxed text-muted-foreground">Your identity is ready on this browser. Pick up where you left off.</p>
      <Button className="w-full h-12" onClick={() => router.replace("/chat")}>Open messages</Button>
      <Button variant="ghost" className="w-full" onClick={toggleRestore}>I have a backup from another device</Button>
    </> : <>
      {!restore ? <>
        <p className="text-base leading-relaxed text-muted-foreground">Create an address on this device. No email, phone number, or account password required.</p>
        <Button className="w-full h-12" disabled={loading} onClick={() => void run(createIdentity)}>
          {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <KeyRound className="mr-2 size-4" />} Create my identity
        </Button>
        <p className="text-sm leading-relaxed text-muted-foreground">After entering, download a backup. Clearing browser data without one permanently removes access to your identity.</p>
      </> : <>
      {conflict && <RestoreConfirmation conflict={conflict} busy={loading} onConfirm={() => void restoreFile(conflict.existingPublicKey)} onCancel={() => setConflict(null)} />}
      <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (file && !conflict) void restoreFile() }}>
        <div className="space-y-2"><Label htmlFor="backup-file">Serotine backup</Label><Input id="backup-file" type="file" accept=".json,application/json" required disabled={loading} onChange={event => { setFile(event.target.files?.[0] ?? null); setConflict(null) }} /><p className="text-sm text-muted-foreground">Restore a full chat backup or an older identity backup. This also links a device to your existing identity.</p></div>
        <div className="space-y-2"><Label htmlFor="backup-password">Backup password</Label><Input id="backup-password" type={showPassword ? "text" : "password"} autoComplete="current-password" maxLength={1024} disabled={loading} value={password} onChange={event => { setPassword(event.target.value); setConflict(null) }} /><Button type="button" variant="ghost" size="sm" disabled={loading} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff className="mr-2 size-4" /> : <Eye className="mr-2 size-4" />}{showPassword ? "Hide password" : "Show password"}</Button><p className="text-sm text-muted-foreground">Leave blank for an older unencrypted key export.</p></div>
        <Button className="w-full h-12" disabled={!file || loading || !!conflict}>{loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />} Restore backup</Button>
      </form></>}
      {recoveryRequired ? <p className="text-sm leading-relaxed text-muted-foreground">The identity saved on this browser could not be opened. Restore its backup to repair it. Your existing local data has been preserved.</p> : <Button variant="ghost" className="w-full" disabled={loading} onClick={toggleRestore}>{restore ? hasIdentity ? "Back to my saved identity" : "Create a new identity" : "I have a backup"}</Button>}
    </>}
  </div>
}
