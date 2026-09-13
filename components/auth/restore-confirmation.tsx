"use client"

import { Button } from "@/components/ui/button"
import type { IdentityConflictError } from "@/lib/identity"

export function RestoreConfirmation({ conflict, busy, onConfirm, onCancel }: {
  conflict: IdentityConflictError
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return <div className="space-y-3 rounded-sm border border-primary/35 bg-primary/5 p-4 text-sm" role="region" aria-label="Confirm identity switch">
    <p className="font-medium text-foreground">Use the identity from your other device?</p>
    <p className="text-muted-foreground">This browser already has a different identity. Its key and conversations will stay saved separately, and you can return to it from Restore. The backup identity becomes active here.</p>
    <dl className="divide-y divide-border border-y border-border text-xs"><div className="py-3"><dt className="app-eyebrow">Current address</dt><dd className="mt-1 break-all font-mono">{conflict.existingPublicKey}</dd></div><div className="py-3"><dt className="app-eyebrow">Backup address</dt><dd className="mt-1 break-all font-mono">{conflict.backupPublicKey}</dd></div></dl>
    <div className="flex flex-wrap gap-2"><Button type="button" className="h-auto min-h-10 whitespace-normal" disabled={busy} onClick={onConfirm}>{busy ? "Restoring…" : "Switch identity and restore"}</Button><Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button></div>
  </div>
}
