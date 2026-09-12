"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { Shield, Plus, Copy, Check, Loader2, Search, Pencil, Users, QrCode, Archive, UserRound, Settings2, Bell, Ban, Trash2, Inbox, RefreshCw, PanelLeftClose, PanelLeftOpen, CircleAlert } from "lucide-react"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { MessagingProvider, useMessaging } from "@/components/messaging-provider"
import { AccountTools } from "@/components/account-tools"
import { ModeToggle } from "@/components/mode-toggle"
import { ConversationRow, messagePreview } from "@/components/conversation-sidebar"
import { ConversationActions } from "@/components/conversation-actions"
import { QrCodeCard } from "@/components/qr-code"
import { QrScanner } from "@/components/qr-scanner"
import { loadContacts, saveContacts, shortAddress, type Contact } from "@/lib/identity"
import { parseContactCode } from "@/lib/contact-code"
import type { ConversationRecord } from "@/lib/messaging-types"
import { requestMessagingNotifications } from "@/lib/message-notifications"
import { conversationFromPathname, conversationHref } from "@/lib/conversation-route"

function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : "Something went wrong. Please try again." }
const SIDEBAR_STORAGE_KEY = "serotine_sidebar_collapsed"

export default function ChatLayoutClient({ children }: { children: React.ReactNode }) {
  return <MessagingProvider><InboxLayout>{children}</InboxLayout></MessagingProvider>
}

function InboxLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const selectedConversation = conversationFromPathname(pathname)
  const messaging = useMessaging()
  const { identity, contacts, conversations, messages, requests, preferences, ready, status } = messaging
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [newPub, setNewPub] = useState("")
  const [newAlias, setNewAlias] = useState("")
  const [adding, setAdding] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [addError, setAddError] = useState("")
  const [filter, setFilter] = useState("")
  const [conversationView, setConversationView] = useState<"inbox" | "archived">("inbox")
  const [editing, setEditing] = useState<Contact | null>(null)
  const [editAlias, setEditAlias] = useState("")
  const [editError, setEditError] = useState("")
  const [remove, setRemove] = useState<Contact | null>(null)
  const [groupOpen, setGroupOpen] = useState(false)
  const [groupName, setGroupName] = useState("")
  const [groupMembers, setGroupMembers] = useState<string[]>([])
  const [groupError, setGroupError] = useState("")
  const [creating, setCreating] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [shareOpen, setShareOpen] = useState(false)
  const [inviteLink, setInviteLink] = useState("")
  const [copied, setCopied] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsError, setSettingsError] = useState("")
  const [requestsOpen, setRequestsOpen] = useState(false)
  const [requestError, setRequestError] = useState("")
  const [busyRequest, setBusyRequest] = useState<string | null>(null)
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default")
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const inConversation = pathname !== "/chat"

  useEffect(() => {
    try { setSidebarCollapsed(localStorage.getItem(SIDEBAR_STORAGE_KEY) === "true") } catch { /* The sidebar still works when storage is unavailable. */ }
    const syncSidebar = (event: StorageEvent) => {
      if (event.key === SIDEBAR_STORAGE_KEY) setSidebarCollapsed(event.newValue === "true")
    }
    window.addEventListener("storage", syncSidebar)
    return () => window.removeEventListener("storage", syncSidebar)
  }, [])
  const changeSidebar = (collapsed: boolean) => {
    setSidebarCollapsed(collapsed)
    try { localStorage.setItem(SIDEBAR_STORAGE_KEY, String(collapsed)) } catch { /* Keep the current session preference without storage. */ }
  }

  useEffect(() => {
    if (!ready || identity) return
    const invite = new URLSearchParams(window.location.hash.slice(1)).get("invite")
    if (invite) {
      try { sessionStorage.setItem("serotine_pending_invite", invite.slice(0, 150)) } catch { /* The public invitation can still be pasted after signing in. */ }
    }
    router.replace("/login")
  }, [ready, identity, router])
  useEffect(() => {
    setPermission("Notification" in window ? Notification.permission : "unsupported")
  }, [])
  useEffect(() => {
    if (!identity) return
    setInviteLink(`${window.location.origin}/chat#invite=${identity.publicKey}`)
    const readInvite = () => {
      const hashAddress = new URLSearchParams(window.location.hash.slice(1)).get("invite")
      let address = hashAddress
      try {
        address ||= sessionStorage.getItem("serotine_pending_invite")
        sessionStorage.removeItem("serotine_pending_invite")
      } catch { /* Direct invitations also work when session storage is unavailable. */ }
      if (!address) return
      setNewPub(address.slice(0, 150)); setNewAlias(""); setAddError(""); setAddOpen(true)
      // An invitation only opens the form; adding a contact always requires a click.
      if (hashAddress) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`)
    }
    readInvite()
    window.addEventListener("hashchange", readInvite)
    return () => window.removeEventListener("hashchange", readInvite)
  }, [identity, pathname])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault(); setSearchOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const listedConversations = useMemo(() => conversations.filter(item => item.kind !== "self" && (item.archived || (!item.blocked && !item.request))).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name)), [conversations])
  const activeConversations = listedConversations.filter(item => !item.archived)
  const archivedConversations = listedConversations.filter(item => item.archived)
  const visibleConversations = conversationView === "archived" ? archivedConversations : activeConversations
  const filteredConversations = visibleConversations.filter(item => `${item.name} ${item.id}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const selfConversation = conversations.find(item => item.kind === "self")
  const totalUnread = activeConversations.reduce((count, item) => count + item.unreadCount, 0)
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return []
    const allowed = new Set(conversations.filter(item => !item.blocked && !item.request).map(item => item.id))
    return messages.filter(message => !message.private && allowed.has(message.conversationId) && [message.content, message.attachment?.name, message.poll?.question, ...(message.poll?.options || [])].filter(Boolean).join(" ").toLocaleLowerCase().includes(query)).sort((a, b) => b.timestamp - a.timestamp)
  }, [searchQuery, messages, conversations])

  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2500) }
    catch { setError("Clipboard access was blocked. Open Invite a friend to select and copy your address or link.") }
  }
  const renameContact = (event: React.FormEvent) => {
    event.preventDefault()
    if (!identity || !editing) return
    try {
      const current = loadContacts(identity.publicKey)
      if (!current.some(contact => contact.pub === editing.pub)) throw new Error("This contact was removed in another tab.")
      saveContacts(identity.publicKey, current.map(contact => contact.pub === editing.pub ? { ...contact, alias: editAlias.trim().slice(0, 60) } : contact))
      setEditing(null)
    } catch (cause) { setEditError(errorMessage(cause)) }
  }
  const addContact = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!identity || adding) return
    setAdding(true); setAddError("")
    try {
      const pub = await parseContactCode(newPub)
      if (pub !== identity.publicKey) {
        const current = loadContacts(identity.publicKey)
        if (!current.some(contact => contact.pub === pub)) saveContacts(identity.publicKey, [...current, { pub, alias: newAlias.trim().slice(0, 60) }])
        await messaging.acceptRequest(pub)
      }
      setNewPub(""); setNewAlias(""); setAddOpen(false); setFilter(""); setConversationView("inbox"); router.push(conversationHref(pub))
    } catch (cause) { setAddError(errorMessage(cause)) }
    finally { setAdding(false) }
  }
  const createGroup = async (event: React.FormEvent) => {
    event.preventDefault()
    if (creating) return
    setCreating(true); setGroupError("")
    try {
      const id = await messaging.createGroup(groupName.trim(), groupMembers)
      setGroupOpen(false); setGroupName(""); setGroupMembers([]); setFilter(""); setConversationView("inbox"); router.push(conversationHref(id))
    } catch (cause) { setGroupError(errorMessage(cause)) }
    finally { setCreating(false) }
  }
  const requestNotifications = async () => {
    setSettingsError("")
    try {
      if (!("Notification" in window)) { setPermission("unsupported"); return }
      const result = await requestMessagingNotifications()
      setPermission(result)
      if (result === "denied") setSettingsError("Notifications are blocked in this browser. You can allow them in this site's browser settings.")
    } catch (cause) { setSettingsError(errorMessage(cause)) }
  }
  const requestAction = async (conversation: ConversationRecord, accept: boolean) => {
    setBusyRequest(conversation.id); setRequestError("")
    try {
      if (accept) { await messaging.acceptRequest(conversation.id); setRequestsOpen(false); router.push(conversationHref(conversation.id)) }
      else await messaging.blockContact(conversation.group?.admin || conversation.id)
    } catch (cause) { setRequestError(errorMessage(cause)) }
    finally { setBusyRequest(null) }
  }
  if (!identity) return <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-muted-foreground" role="status"><Loader2 className="size-5 animate-spin" /><p>Opening your identity…</p>{messaging.error && <p role="alert" className="max-w-md text-center text-sm text-destructive">{messaging.error}</p>}</main>
  return <div className="chat-shell flex min-h-0 overflow-hidden bg-background text-foreground">
    <aside id="serotine-sidebar" aria-label="Inbox" data-collapsed={sidebarCollapsed} className={`${inConversation ? "hidden md:flex" : "flex"} min-h-0 min-w-0 w-full flex-col overflow-hidden border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-out motion-reduce:transition-none md:shrink-0 ${sidebarCollapsed ? "md:w-16" : "md:w-[17.5rem]"}`}>
      <div className={`flex h-14 shrink-0 items-center justify-between border-b border-border px-3 ${sidebarCollapsed ? "md:justify-center md:px-2" : ""}`}>
        <Link href="/chat" className={`flex min-h-11 items-center gap-2 rounded-lg focus-visible:outline-2 focus-visible:outline-ring ${sidebarCollapsed ? "md:hidden" : ""}`}><Shield className="size-5 text-primary" /><span className="text-base font-semibold tracking-tight text-foreground">Serotine</span></Link>
        <Button variant="ghost" size="icon" className="hidden size-11 text-muted-foreground md:inline-flex" title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!sidebarCollapsed} aria-controls="serotine-sidebar" onClick={() => changeSidebar(!sidebarCollapsed)}>{sidebarCollapsed ? <PanelLeftOpen className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}</Button>
      </div>
      <div className={`border-b border-border px-3 py-2.5 ${sidebarCollapsed ? "md:hidden" : ""}`}>
        <div className="mb-2 flex items-center gap-2.5"><IdentityIcon pubKey={identity.publicKey} size={28} /><button type="button" onClick={() => void copy(identity.publicKey)} title="Copy your public address" aria-label="Copy your public address" className="min-h-11 min-w-0 flex-1 rounded-lg text-left focus-visible:outline-2 focus-visible:outline-ring"><span className="block text-xs font-medium text-foreground">My identity</span><span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">{shortAddress(identity.publicKey)}{copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}</span></button><Button variant="ghost" size="icon" className="size-11 text-muted-foreground" aria-label="Invite a friend" title="Invite a friend" onClick={() => { setCopied(false); setShareOpen(true) }}><QrCode className="size-4" /></Button></div>
        <Button variant="outline" className="h-11 w-full justify-start gap-2 border-border bg-background/60 text-xs text-muted-foreground shadow-none md:h-9" onClick={() => setSearchOpen(true)}><Search className="size-3.5" /> Search all messages<span className="ml-auto hidden text-[9px] text-muted-foreground lg:inline">Ctrl ⇧ F</span></Button>
      </div>
      <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${sidebarCollapsed ? "md:hidden" : ""}`}>
        <div className="px-2 pt-2">{selfConversation ? <ConversationRow conversation={selfConversation} selected={selectedConversation === identity.publicKey} owner={identity.publicKey} /> : <Link href={conversationHref(identity.publicKey)} className="flex min-h-11 items-center gap-2 rounded-xl px-3 py-2 text-[13px] font-medium text-primary hover:bg-accent"><UserRound className="size-4" /> Message yourself</Link>}</div>
        <div className="flex items-center justify-between px-3 pt-2"><h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Chats {totalUnread > 0 && <span className="ml-1 font-medium normal-case tracking-normal text-primary">{totalUnread} unread</span>}</h2><div className="flex"><Button size="icon" variant="ghost" className="size-11 text-muted-foreground md:size-8" aria-label="Create group chat" title="Create group chat" onClick={() => { setGroupError(""); setGroupOpen(true) }}><Users className="size-4" /></Button><Button size="icon" variant="ghost" className="size-11 text-muted-foreground md:size-8" aria-label="Add contact" title="Add contact" onClick={() => { setAddError(""); setAddOpen(true) }}><Plus className="size-4" /></Button></div></div>
        <div className="mx-3 mb-2 flex gap-1 rounded-lg bg-muted/70 p-1" role="group" aria-label="Conversation view">
          <button type="button" aria-pressed={conversationView === "inbox"} onClick={() => { setConversationView("inbox"); setFilter(""); setNotice("") }} className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-ring md:min-h-7 ${conversationView === "inbox" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}><Inbox className="size-3.5" />Inbox<span className="text-muted-foreground">{activeConversations.length}</span></button>
          <button type="button" aria-pressed={conversationView === "archived"} onClick={() => { setConversationView("archived"); setFilter(""); setNotice("") }} className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-ring md:min-h-7 ${conversationView === "archived" ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground"}`}><Archive className="size-3.5" />Archived<span className="text-muted-foreground">{archivedConversations.length}</span></button>
        </div>
        {conversationView === "archived" && <p className="mx-5 mb-3 text-xs leading-relaxed text-muted-foreground">Hidden from your inbox. Messages stay saved until you delete the chat.</p>}
        {conversationView === "inbox" && requests.length > 0 && <button type="button" onClick={() => { setRequestError(""); setRequestsOpen(true) }} className="mx-4 mb-3 flex w-[calc(100%-2rem)] items-center gap-3 rounded-xl border border-primary/20 bg-primary/5 px-3 py-3 text-left text-sm text-primary"><Inbox className="size-4" /><span className="flex-1">Message requests</span><span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs">{requests.length}</span></button>}
        {(visibleConversations.length > 3 || filter) && <div className="relative mx-4 mb-3"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input aria-label="Filter conversations" placeholder="Filter conversations" value={filter} onChange={event => setFilter(event.target.value)} className="pl-9" /></div>}
        {(error || messaging.error) && <p role="alert" className="mx-5 mb-4 break-words text-sm leading-relaxed text-destructive">{error || messaging.error}</p>}
        {notice && <p role="status" className="mx-5 mb-4 text-sm text-primary">{notice}</p>}
        <nav className="space-y-0.5 px-2 pb-3" aria-label={conversationView === "archived" ? "Archived conversations" : "Conversations"}>
          {!ready && <p role="status" className="px-4 py-6 text-sm text-muted-foreground">Loading conversations…</p>}
          {ready && conversationView === "inbox" && activeConversations.length === 0 && <div className="px-4 py-6 text-center"><Inbox className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="text-sm text-muted-foreground">No chats in your inbox.</p><p className="mt-2 text-sm leading-relaxed text-muted-foreground">{archivedConversations.length ? "Open Archived to restore a chat, or start a new one." : "Add a friend or create a group to start talking."}</p><div className="mt-4 flex flex-wrap justify-center gap-2"><Button size="sm" onClick={() => setAddOpen(true)}><Plus className="size-3.5" /> Add contact</Button><Button size="sm" variant="outline" onClick={() => setGroupOpen(true)}><Users className="size-3.5" /> New group</Button></div></div>}
          {ready && conversationView === "archived" && archivedConversations.length === 0 && <div className="px-4 py-6 text-center"><Archive className="mx-auto mb-3 size-7 text-muted-foreground" /><p className="text-sm text-muted-foreground">No archived chats.</p><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Open a chat’s options and choose Archive chat to hide it here.</p></div>}
          {visibleConversations.length > 0 && filteredConversations.length === 0 && <p role="status" className="px-4 py-6 text-center text-sm text-muted-foreground">No conversations match your filter.</p>}
          {filteredConversations.map(conversation => {
            const contact = contacts.find(item => item.pub === conversation.id)
            return <ConversationRow key={conversation.id} conversation={conversation} selected={selectedConversation === conversation.id} owner={identity.publicKey} actions={<ConversationActions conversation={conversation} onError={setError} onNotice={setNotice}>{conversation.kind === "direct" && <>{contact ? <DropdownMenuItem onSelect={() => { setEditing(contact); setEditAlias(contact.alias); setEditError("") }}><Pencil /> Rename contact</DropdownMenuItem> : <DropdownMenuItem onSelect={() => { setNewPub(conversation.id); setNewAlias(""); setAddError(""); setAddOpen(true) }}><Plus /> Add to contacts</DropdownMenuItem>}<DropdownMenuItem onSelect={() => void copy(conversation.id)}><Copy /> Copy address</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { void messaging.blockContact(conversation.id).catch(cause => setError(errorMessage(cause))) }}><Ban /> Block messages</DropdownMenuItem>{contact && <DropdownMenuItem variant="destructive" onSelect={() => setRemove(contact)}><Trash2 /> Remove contact</DropdownMenuItem>}</>}</ConversationActions>} />
          })}
        </nav>
      </div>
      <div className={`${sidebarCollapsed ? "hidden md:flex" : "hidden"} min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden overscroll-contain px-2 py-2`}>
        <Button variant="ghost" size="icon" className="size-11 text-muted-foreground" aria-label="Search all messages" title="Search all messages" onClick={() => setSearchOpen(true)}><Search className="size-[18px]" /></Button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-11 text-muted-foreground" aria-label="Start a chat" title="Start a chat"><Plus className="size-[18px]" /></Button></DropdownMenuTrigger><DropdownMenuContent side="right" align="start">
          <DropdownMenuItem onSelect={() => { setAddError(""); setAddOpen(true) }}><Plus />Add contact</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setGroupError(""); setGroupOpen(true) }}><Users />Create group chat</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setCopied(false); setShareOpen(true) }}><QrCode />Invite a friend</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
        <Button variant="ghost" size="icon" className={`size-11 ${conversationView === "archived" ? "bg-primary/10 text-primary" : "text-muted-foreground"}`} aria-label={conversationView === "archived" ? "Show inbox" : "Show archived chats"} title={conversationView === "archived" ? "Show inbox" : "Show archived chats"} onClick={() => { setConversationView(current => current === "archived" ? "inbox" : "archived"); setFilter(""); setNotice("") }}>{conversationView === "archived" ? <Inbox className="size-[18px]" /> : <Archive className="size-[18px]" />}</Button>
        {requests.length > 0 && <Button variant="ghost" size="icon" className="relative size-11 text-primary" aria-label={`${requests.length} message requests`} title="Message requests" onClick={() => { setRequestError(""); setRequestsOpen(true) }}><Inbox className="size-[18px]" /><span aria-hidden="true" className="absolute right-0 top-0 rounded-full bg-primary px-1 text-[9px] leading-4 text-primary-foreground">{requests.length > 99 ? "99+" : requests.length}</span></Button>}
        <div className="my-1 h-px w-7 shrink-0 bg-border" />
        {selfConversation ? <ConversationRow collapsed conversation={selfConversation} selected={selectedConversation === identity.publicKey} owner={identity.publicKey} /> : <Link href={conversationHref(identity.publicKey)} title="Message yourself" aria-label="Message yourself" className="flex size-11 shrink-0 items-center justify-center rounded-xl text-primary hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"><UserRound className="size-[18px]" /></Link>}
        <nav aria-label={conversationView === "archived" ? "Archived conversations" : "Conversations"} className="flex flex-col items-center gap-1 pt-1">
          {visibleConversations.map(conversation => <ConversationRow key={conversation.id} collapsed conversation={conversation} selected={selectedConversation === conversation.id} owner={identity.publicKey} />)}
        </nav>
        {(error || messaging.error) && <Button variant="ghost" size="icon" className="size-11 text-destructive" aria-label={`Show inbox error: ${error || messaging.error}`} title={error || messaging.error || undefined} onClick={() => changeSidebar(false)}><CircleAlert className="size-[18px]" /></Button>}
      </div>
      <div className={`chat-bottom shrink-0 border-t border-border bg-sidebar px-3 py-2 text-muted-foreground ${sidebarCollapsed ? "md:px-2" : ""}`}>
        <div className={`flex items-center justify-between gap-1 ${sidebarCollapsed ? "md:flex-col" : ""}`}>
          <span className={`flex min-w-0 flex-1 items-center gap-1.5 text-[10px] ${sidebarCollapsed ? "md:py-1" : ""}`} role="status" title={status === "online" ? "Inbox connected" : status === "connecting" ? "Connecting inbox…" : "Inbox sync unavailable"}><span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${status === "online" ? "bg-emerald-500" : status === "connecting" ? "animate-pulse bg-amber-500 motion-reduce:animate-none" : "bg-muted-foreground"}`} /><span className={sidebarCollapsed ? "md:sr-only" : ""}>{status === "online" ? "Connected" : status === "connecting" ? "Connecting…" : "Offline"}</span></span>
          {status === "offline" && <Button variant="ghost" size="icon" className="size-11 md:size-8" aria-label="Reconnect inbox" title="Reconnect inbox" onClick={() => void messaging.sync().catch(cause => setError(errorMessage(cause)))}><RefreshCw className="size-3.5" /></Button>}
          <div className={`flex items-center [&>button]:size-11 md:[&>button]:size-9 ${sidebarCollapsed ? "md:flex-col" : ""}`}>
            <AccountTools identity={identity} />
            <ModeToggle />
            <Button variant="ghost" size="icon" aria-label="Notification and privacy settings" title="Notification and privacy settings" onClick={() => { setSettingsError(""); setSettingsOpen(true) }}><Settings2 className="size-4" /></Button>
          </div>
        </div>
      </div>
    </aside>
    <main className={`${inConversation ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1 flex-col`}>{children}</main>

    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Add a contact</DialogTitle><DialogDescription>Scan your friend's QR code or paste their public address or invite link. Review it, then choose Add contact.</DialogDescription></DialogHeader><form onSubmit={event => void addContact(event)} className="space-y-4">
      <QrScanner disabled={adding || !addOpen} onScan={address => { setNewPub(address); setAddError("") }} />
      <div className="space-y-2"><Label htmlFor="contact-address">Address or invite link</Label><Input id="contact-address" placeholder="Scan a QR code or paste their address" value={newPub} onChange={event => setNewPub(event.target.value)} required maxLength={2048} spellCheck={false} autoComplete="off" /></div><div className="space-y-2"><Label htmlFor="contact-name">Name <span className="text-muted-foreground">(optional)</span></Label><Input id="contact-name" placeholder="How you know them" value={newAlias} onChange={event => setNewAlias(event.target.value)} maxLength={60} /></div>{addError && <p role="alert" className="text-sm text-destructive">{addError}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button><Button type="submit" disabled={!newPub.trim() || adding}>{adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add contact</Button></DialogFooter></form></DialogContent></Dialog>

    <Dialog open={groupOpen} onOpenChange={open => { if (!creating) setGroupOpen(open) }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Create a group chat</DialogTitle><DialogDescription>Choose a name and the people to invite. You will be the group admin.</DialogDescription></DialogHeader><form onSubmit={event => void createGroup(event)} className="space-y-4"><div className="space-y-2"><Label htmlFor="group-name">Group name</Label><Input id="group-name" placeholder="Study group, weekend plans…" value={groupName} onChange={event => setGroupName(event.target.value)} maxLength={80} required /></div><fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Add members <span className="font-normal text-muted-foreground">({groupMembers.length} selected)</span></legend><div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-border p-2">{contacts.filter(contact => !preferences.blocked.includes(contact.pub)).map(contact => <label key={contact.pub} className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-accent"><input type="checkbox" className="size-4 accent-primary" checked={groupMembers.includes(contact.pub)} onChange={event => setGroupMembers(current => event.target.checked ? [...current, contact.pub] : current.filter(pub => pub !== contact.pub))} /><IdentityIcon pubKey={contact.pub} size={28} /><span className="min-w-0"><span className="block truncate text-sm">{contact.alias || shortAddress(contact.pub)}</span><span className="block font-mono text-[10px] text-muted-foreground">{shortAddress(contact.pub)}</span></span></label>)}{contacts.filter(contact => !preferences.blocked.includes(contact.pub)).length === 0 && <p className="p-3 text-sm text-muted-foreground">Add a contact first to invite them to a group.</p>}</div></fieldset>{groupError && <p role="alert" className="text-sm text-destructive">{groupError}</p>}<DialogFooter><Button type="button" variant="outline" disabled={creating} onClick={() => setGroupOpen(false)}>Cancel</Button><Button type="submit" disabled={creating || !groupName.trim() || groupMembers.length === 0}>{creating ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4" />} Create group</Button></DialogFooter></form></DialogContent></Dialog>

    <Dialog open={shareOpen} onOpenChange={setShareOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Invite a friend</DialogTitle><DialogDescription>This QR code contains your full public address. Your friend can scan it in Serotine’s Add a contact screen, then add you.</DialogDescription></DialogHeader>
      <QrCodeCard value={identity.publicKey} title="Your address QR code" />
      <div className="space-y-2"><Label htmlFor="invite-link">Your invite link</Label><div className="flex gap-2"><Input id="invite-link" readOnly value={inviteLink} onFocus={event => event.target.select()} className="font-mono text-xs" /><Button aria-label="Copy invite link" onClick={() => void copy(inviteLink)}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button></div><p aria-live="polite" className="min-h-4 text-xs text-primary">{copied ? "Copied to clipboard" : ""}</p></div><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">View full public address</summary><p className="mt-2 select-all break-all rounded-lg bg-muted p-3 font-mono leading-relaxed text-muted-foreground">{identity.publicKey}</p></details></DialogContent></Dialog>

    <Dialog open={searchOpen} onOpenChange={setSearchOpen}><DialogContent className="max-h-[90dvh] sm:max-w-2xl"><DialogHeader><DialogTitle>Search all messages</DialogTitle><DialogDescription>Find messages, links, filenames, and polls across your conversations.</DialogDescription></DialogHeader><div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" /><Input autoFocus aria-label="Search messages, links, and files" placeholder="Search messages, links, and files" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} className="pl-9" /></div><div className="max-h-[55dvh] space-y-2 overflow-y-auto" aria-live="polite">{!searchQuery.trim() ? <p className="py-8 text-center text-sm text-muted-foreground">Enter a word, phrase, or filename.</p> : searchResults.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">No matching messages.</p> : <><p className="text-xs text-muted-foreground">{searchResults.length} result{searchResults.length === 1 ? "" : "s"}{searchResults.length > 100 ? " · showing the latest 100" : ""}</p>{searchResults.slice(0, 100).map(message => { const conversation = conversations.find(item => item.id === message.conversationId); return <Link key={message.id} href={`${conversationHref(message.conversationId)}#message-${message.id}`} onClick={() => setSearchOpen(false)} className="block rounded-xl border border-border p-3 hover:border-primary/40 hover:bg-muted"><span className="flex gap-3 text-xs"><span className="truncate font-medium text-primary">{conversation?.kind === "self" ? "Message yourself" : conversation?.name || shortAddress(message.conversationId)}</span><time className="ml-auto shrink-0 text-muted-foreground" dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleDateString()}</time></span><p className="mt-2 line-clamp-3 break-words text-sm text-foreground">{messagePreview(message)}</p></Link> })}</>}</div></DialogContent></Dialog>

    <Dialog open={requestsOpen} onOpenChange={setRequestsOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Message requests</DialogTitle><DialogDescription>Accept a request to start talking. Blocking stops messages from that sender.</DialogDescription></DialogHeader>{requestError && <p role="alert" className="text-sm text-destructive">{requestError}</p>}{requests.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">No pending requests.</p>}<div className="space-y-3">{requests.map(request => <div key={request.id} className="rounded-xl border border-border p-4"><div className="flex items-center gap-3">{request.kind === "group" ? <Users className="size-7 text-primary" /> : <IdentityIcon pubKey={request.id} size={32} />}<span className="min-w-0"><span className="block truncate text-sm font-medium">{request.name}</span><span className="block text-xs text-muted-foreground">{request.kind === "group" ? `Group invitation · ${request.members.length} members` : shortAddress(request.id)}</span></span></div><p className="mt-3 line-clamp-3 break-words text-sm text-muted-foreground">{messagePreview(request.lastMessage)}</p><div className="mt-4 flex justify-end gap-2"><Button size="sm" variant="outline" disabled={busyRequest !== null} onClick={() => void requestAction(request, false)}><Ban className="size-3.5" />{request.kind === "group" ? "Block sender" : "Block"}</Button><Button size="sm" disabled={busyRequest !== null} onClick={() => void requestAction(request, true)}>{busyRequest === request.id ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Accept</Button></div></div>)}</div></DialogContent></Dialog>

    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Notifications and privacy</DialogTitle><DialogDescription>Choose what Serotine shares and who can contact you.</DialogDescription></DialogHeader><div className="space-y-5"><section className="space-y-2"><h3 className="text-sm font-medium">Browser notifications</h3><p className="text-sm text-muted-foreground">{permission === "granted" ? "Notifications are enabled. Mute a chat or choose mentions only from its conversation menu." : permission === "unsupported" ? "Notifications are unavailable in this browser." : permission === "denied" ? "Notifications are blocked. Allow them in this site's browser settings to turn them on." : "Get notified of new messages while Serotine is open."}</p>{permission !== "granted" && permission !== "unsupported" && permission !== "denied" && <Button size="sm" onClick={() => void requestNotifications()}><Bell className="size-4" /> Enable notifications</Button>}</section><label className="flex items-start gap-3 border-t border-border pt-4"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={preferences.readReceipts} onChange={event => { void messaging.setReadReceipts(event.target.checked).catch(cause => setSettingsError(errorMessage(cause))) }} /><span><span className="block text-sm font-medium">Send read receipts</span><span className="mt-1 block text-sm text-muted-foreground">Let people know when you have opened their messages.</span></span></label><section className="space-y-3 border-t border-border pt-4"><h3 className="text-sm font-medium">Blocked contacts</h3>{preferences.blocked.length === 0 ? <p className="text-sm text-muted-foreground">No blocked contacts.</p> : preferences.blocked.map(pub => <div key={pub} className="flex items-center gap-3"><IdentityIcon pubKey={pub} size={28} /><span className="min-w-0 flex-1 truncate text-sm">{contacts.find(contact => contact.pub === pub)?.alias || shortAddress(pub)}</span><Button size="sm" variant="outline" onClick={() => { void messaging.blockContact(pub, false).catch(cause => setSettingsError(errorMessage(cause))) }}>Unblock</Button></div>)}</section>{settingsError && <p role="alert" className="text-sm text-destructive">{settingsError}</p>}</div></DialogContent></Dialog>

    <Dialog open={!!editing} onOpenChange={open => { if (!open) setEditing(null) }}><DialogContent><DialogHeader><DialogTitle>Rename contact</DialogTitle><DialogDescription>This name is only shown to you. Their address stays the same.</DialogDescription></DialogHeader><form onSubmit={renameContact} className="space-y-4"><Label htmlFor="edit-contact-name">Contact name</Label><Input id="edit-contact-name" value={editAlias} onChange={event => setEditAlias(event.target.value)} maxLength={60} placeholder="How you know them" />{editError && <p role="alert" className="text-sm text-destructive">{editError}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit">Save name</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={!!remove} onOpenChange={open => { if (!open) setRemove(null) }}><DialogContent><DialogHeader><DialogTitle>Remove this contact?</DialogTitle><DialogDescription>This removes {remove?.alias || "the contact"} from your address book. Your conversation and messages remain in the inbox. To stop new messages, choose Block messages.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setRemove(null)}>Cancel</Button><Button variant="destructive" onClick={() => { if (!remove) return; try { saveContacts(identity.publicKey, loadContacts(identity.publicKey).filter(contact => contact.pub !== remove.pub)); setNotice("Contact removed. Your message history is still available."); setRemove(null) } catch (cause) { setError(errorMessage(cause)); setRemove(null) } }}>Remove contact</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
