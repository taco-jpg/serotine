"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, KeyRound, Upload, Eye, EyeOff } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createIdentity, loadIdentity, restoreIdentityBackup } from "@/lib/identity"

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
  useEffect(() => {
    void loadIdentity().then(identity => setHasIdentity(!!identity)).catch(cause => { setError(cause.message); setRestore(true); setRecoveryRequired(true) }).finally(() => setChecking(false))
  }, [])
  const run = async (action: () => Promise<unknown>) => {
    setLoading(true); setError(null)
    try { await action(); router.replace("/chat") }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open your identity.") }
    finally { setLoading(false) }
  }
  if (checking) return <p role="status" className="flex items-center gap-2 text-sm text-zinc-400"><Loader2 className="size-4 animate-spin" /> Checking this browser…</p>
  return <div className="space-y-5">
    {error && <p role="alert" className="rounded-lg border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200">{error}</p>}
    {hasIdentity ? <>
      <p className="text-sm leading-relaxed text-zinc-400">Your identity is ready on this browser. Pick up where you left off.</p>
      <Button className="w-full h-12" onClick={() => router.replace("/chat")}>Open messages</Button>
    </> : <>
      {!restore ? <>
        <p className="text-base leading-relaxed text-zinc-400">Create an address on this device. No email, phone number, or account password required.</p>
        <Button className="w-full h-12" disabled={loading} onClick={() => void run(createIdentity)}>
          {loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <KeyRound className="mr-2 size-4" />} Create my identity
        </Button>
        <p className="text-sm leading-relaxed text-zinc-500">After entering, download a backup. Clearing browser data without one permanently removes access to your identity.</p>
      </> : <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (file) void run(async () => { if (file.size > 32000) throw new Error("Choose a Serotine backup smaller than 32 KB."); return restoreIdentityBackup(await file.text(), password) }) }}>
        <div className="space-y-2"><Label htmlFor="backup-file">Identity backup</Label><Input id="backup-file" type="file" accept=".json,application/json" required onChange={event => setFile(event.target.files?.[0] ?? null)} /></div>
        <div className="space-y-2"><Label htmlFor="backup-password">Backup password</Label><Input id="backup-password" type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /><Button type="button" variant="ghost" size="sm" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff className="mr-2 size-4" /> : <Eye className="mr-2 size-4" />}{showPassword ? "Hide password" : "Show password"}</Button><p className="text-sm text-zinc-500">Leave blank for an older unencrypted key export.</p></div>
        <Button className="w-full h-12" disabled={!file || loading}>{loading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />} Restore identity</Button>
      </form>}
      {recoveryRequired ? <p className="text-sm leading-relaxed text-zinc-400">The identity saved on this browser could not be opened. Restore its backup to repair it. Your existing local data has been preserved.</p> : <Button variant="ghost" className="w-full" disabled={loading} onClick={() => { setRestore(!restore); setError(null) }}>{restore ? "Create a new identity" : "I have an identity backup"}</Button>}
    </>}
  </div>
}
