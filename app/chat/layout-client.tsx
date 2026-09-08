"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { Shield, Plus, X, Copy, Check, Download, Loader2, MessageSquare } from "lucide-react"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { loadIdentity, loadContacts, saveContacts, validateAddress, shortAddress, exportIdentityBackup, type Contact, type Identity } from "@/lib/identity"

export default function ChatLayoutClient({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const [identity, setIdentity] = useState<Identity | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [error, setError] = useState("")
  const [newPub, setNewPub] = useState("")
  const [newAlias, setNewAlias] = useState("")
  const [adding, setAdding] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [password, setPassword] = useState("")
  const [exporting, setExporting] = useState(false)
  const [backupError, setBackupError] = useState("")
  const [remove, setRemove] = useState<Contact | null>(null)
  const inConversation = pathname !== "/chat"

  useEffect(() => {
    let active = true
    void loadIdentity().then(value => {
      if (!active) return
      if (!value) { router.replace("/login"); return }
      setIdentity(value)
      try { setContacts(loadContacts(value.publicKey)) } catch (cause) { setError((cause as Error).message) }
    }).catch(() => router.replace("/login"))
    return () => { active = false }
  }, [router])
  const copyAddress = async () => {
    if (!identity) return
    try { await navigator.clipboard.writeText(identity.publicKey); setCopied(true); setTimeout(() => setCopied(false), 2500) }
    catch { setError("Clipboard access was blocked. Select and copy your address below.") }
  }
  const addContact = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!identity || adding) return
    setAdding(true); setError("")
    try {
      const pub = await validateAddress(newPub)
      if (pub === identity.publicKey) throw new Error("That is your own address. Ask your contact to share theirs.")
      if (contacts.some(contact => contact.pub === pub)) throw new Error("This contact is already in your list.")
      const updated = [...contacts, { pub, alias: newAlias.trim().slice(0, 60) }]
      saveContacts(identity.publicKey, updated); setContacts(updated)
      setNewPub(""); setNewAlias(""); setAddOpen(false); router.push(`/chat/${pub}`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not add this contact.") }
    finally { setAdding(false) }
  }
  const backup = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!identity || exporting) return
    setExporting(true); setBackupError("")
    try {
      const text = await exportIdentityBackup(identity, password)
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }))
      const link = document.createElement("a")
      link.href = url; link.download = `serotine-identity-${identity.publicKey.slice(-8)}.json`; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setPassword(""); setBackupOpen(false)
    } catch (cause) { setBackupError((cause as Error).message) }
    finally { setExporting(false) }
  }
  if (!identity) return <main className="flex min-h-dvh items-center justify-center gap-2 text-zinc-400" role="status"><Loader2 className="size-5 animate-spin" /> Opening your identity…</main>
  return <div className="flex h-dvh min-h-0 overflow-hidden bg-zinc-950 text-zinc-200">
    <aside aria-label="Contacts" className={`${inConversation ? "hidden md:flex" : "flex"} w-full flex-col border-r border-zinc-800/80 bg-zinc-900/25 md:w-80 md:shrink-0`}>
      <div className="flex h-20 shrink-0 items-center justify-between border-b border-zinc-800/80 px-5">
        <Link href="/chat" className="flex items-center gap-3"><Shield className="size-6 text-indigo-300" /><span className="font-serif text-2xl text-zinc-100">Serotine</span></Link>
        <Button variant="ghost" size="icon" aria-label="Back up identity" onClick={() => { setBackupError(""); setBackupOpen(true) }}><Download className="size-4" /></Button>
      </div>
      <div className="border-b border-zinc-800/80 p-5">
        <div className="mb-3 flex items-center justify-between"><span className="text-xs font-medium uppercase tracking-[0.15em] text-zinc-500">Your address</span><span aria-live="polite" className="text-xs text-indigo-300">{copied ? "Copied" : ""}</span></div>
        <button type="button" onClick={() => void copyAddress()} className="flex w-full items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3 text-left transition hover:border-zinc-600">
          <IdentityIcon pubKey={identity.publicKey} size={36} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">My identity</span><span className="font-mono text-xs text-zinc-400">{shortAddress(identity.publicKey)}</span></span>{copied ? <Check className="size-4 text-indigo-300" /> : <Copy className="size-4 text-zinc-500" />}
        </button>
        <details className="mt-3 text-xs text-zinc-500"><summary className="cursor-pointer hover:text-zinc-300">View full address</summary><p className="mt-2 select-all break-all rounded-lg bg-zinc-900 p-2 font-mono leading-relaxed text-zinc-400">{identity.publicKey}</p></details>
      </div>
      <div className="flex items-center justify-between px-5 pb-3 pt-5"><h2 className="font-sans text-sm font-medium text-zinc-300">Conversations <span className="ml-1 text-zinc-600">{contacts.length}</span></h2><Button size="icon" variant="ghost" aria-label="Add contact" onClick={() => { setError(""); setAddOpen(!addOpen) }}><Plus className="size-4" /></Button></div>
      {(addOpen || contacts.length === 0) && <form onSubmit={event => void addContact(event)} className="mx-5 mb-5 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="space-y-2"><Label htmlFor="contact-address">Contact address</Label><Input id="contact-address" placeholder="Paste their public address" value={newPub} onChange={event => setNewPub(event.target.value)} required maxLength={150} spellCheck={false} autoComplete="off" /></div>
        <div className="space-y-2"><Label htmlFor="contact-name">Name <span className="text-zinc-500">(optional)</span></Label><Input id="contact-name" placeholder="How you know them" value={newAlias} onChange={event => setNewAlias(event.target.value)} maxLength={60} /></div>
        <Button type="submit" disabled={!newPub.trim() || adding} className="w-full">{adding ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Plus className="mr-2 size-4" />} Add contact</Button>
      </form>}
      {error && <p role="alert" className="mx-5 mb-4 text-sm leading-relaxed text-red-300">{error}</p>}
      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4" aria-label="Conversations">
        {contacts.length === 0 && <div className="px-4 py-7 text-center"><MessageSquare className="mx-auto mb-3 size-7 text-zinc-600" /><p className="text-sm text-zinc-400">Your first conversation starts here.</p><p className="mt-2 text-sm leading-relaxed text-zinc-500">Exchange addresses with someone you trust, then add them above.</p></div>}
        {contacts.map(contact => <div key={contact.pub} className={`flex items-center gap-1 rounded-xl ${pathname === `/chat/${contact.pub}` ? "bg-indigo-400/10 ring-1 ring-inset ring-indigo-400/20" : "hover:bg-zinc-900"}`}>
          <Link href={`/chat/${contact.pub}`} aria-current={pathname === `/chat/${contact.pub}` ? "page" : undefined} className="flex min-w-0 flex-1 items-center gap-3 p-3"><IdentityIcon pubKey={contact.pub} size={36} /><span className="min-w-0"><span className="block truncate text-sm font-medium">{contact.alias || shortAddress(contact.pub)}</span><span className="block truncate font-mono text-xs text-zinc-500">{shortAddress(contact.pub)}</span></span></Link>
          <Button className="mr-1 text-zinc-500 hover:text-red-300" variant="ghost" size="icon" aria-label={`Remove ${contact.alias || shortAddress(contact.pub)}`} onClick={() => setRemove(contact)}><X className="size-4" /></Button>
        </div>)}
      </nav>
      <p className="border-t border-zinc-800/80 px-5 py-4 text-xs leading-relaxed text-zinc-500">History stays on this browser.<br />Back up your identity before clearing site data.</p>
    </aside>
    <main className={`${inConversation ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1 flex-col`}>{children}</main>
    <Dialog open={backupOpen} onOpenChange={open => { setBackupOpen(open); if (!open) setPassword("") }}><DialogContent><DialogHeader><DialogTitle>Back up your identity</DialogTitle><DialogDescription>Keep this file and its password somewhere safe. It restores your address and private key; message history stays on this browser.</DialogDescription></DialogHeader><form onSubmit={event => void backup(event)} className="space-y-4"><Label htmlFor="export-password">Backup password</Label><Input id="export-password" type="password" autoComplete="new-password" minLength={12} required placeholder="At least 12 characters" value={password} onChange={event => setPassword(event.target.value)} />{backupError && <p role="alert" className="text-sm text-red-300">{backupError}</p>}<p className="text-sm text-zinc-400">This password cannot be recovered. Anyone with the file and password can use your identity.</p><DialogFooter><Button type="submit" disabled={exporting || password.length < 12}>{exporting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />} Download encrypted backup</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={!!remove} onOpenChange={open => { if (!open) setRemove(null) }}><DialogContent><DialogHeader><DialogTitle>Remove this contact?</DialogTitle><DialogDescription>This removes {remove?.alias || "the contact"} from your list. Their message history stays on this browser, and you can add their address again.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setRemove(null)}>Cancel</Button><Button variant="destructive" onClick={() => { if (!remove) return; try { const updated = contacts.filter(c => c.pub !== remove.pub); saveContacts(identity.publicKey, updated); setContacts(updated); if (pathname === `/chat/${remove.pub}`) router.push("/chat"); setRemove(null) } catch { setError("Could not update contacts. Check browser storage."); setRemove(null) } }}>Remove contact</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
