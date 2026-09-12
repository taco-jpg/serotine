"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { Shield, Plus, Copy, Check, Loader2, Search, Pencil, Users, Link2, Archive, UserRound, Settings2, Bell, BellOff, Ban, Trash2, Inbox, RefreshCw } from "lucide-react"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { MessagingProvider, useMessaging } from "@/components/messaging-provider"
import { AccountTools } from "@/components/account-tools"
import { ConversationRow, messagePreview } from "@/components/conversation-sidebar"
import { ConversationActions } from "@/components/conversation-actions"
import { loadContacts, saveContacts, validateAddress, shortAddress, type Contact } from "@/lib/identity"
import type { ConversationRecord } from "@/lib/messaging-types"
import { requestMessagingNotifications } from "@/lib/message-notifications"
import { conversationFromPathname, conversationHref } from "@/lib/conversation-route"

function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : "Something went wrong. Please try again." }

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
  const inConversation = pathname !== "/chat"

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
    return messages.filter(message => allowed.has(message.conversationId) && [message.content, message.attachment?.name, message.poll?.question, ...(message.poll?.options || [])].filter(Boolean).join(" ").toLocaleLowerCase().includes(query)).sort((a, b) => b.timestamp - a.timestamp)
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
      let address = newPub.trim()
      if (/^https?:\/\//i.test(address)) {
        const invitation = new URL(address)
        address = new URLSearchParams(invitation.hash.slice(1)).get("invite") || ""
      }
      const pub = await validateAddress(address)
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
  if (!identity) return <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-zinc-400" role="status"><Loader2 className="size-5 animate-spin" /><p>Opening your identity…</p>{messaging.error && <p role="alert" className="max-w-md text-center text-sm text-red-300">{messaging.error}</p>}</main>
  return <div className="chat-shell flex min-h-0 overflow-hidden bg-zinc-950 text-zinc-200">
    <aside aria-label="Inbox" className={`${inConversation ? "hidden md:flex" : "flex"} min-h-0 min-w-0 w-full flex-col border-r border-zinc-800/80 bg-zinc-900/25 md:w-[22rem] md:shrink-0`}>
      <div className="flex h-20 shrink-0 items-center justify-between border-b border-zinc-800/80 px-5">
        <Link href="/chat" className="flex items-center gap-3"><Shield className="size-6 text-indigo-300" /><span className="font-serif text-2xl text-zinc-100">Serotine</span></Link>
        <div className="flex items-center"><AccountTools identity={identity} /><Button variant="ghost" size="icon" aria-label="Notification and privacy settings" onClick={() => { setSettingsError(""); setSettingsOpen(true) }}><Settings2 className="size-4" /></Button></div>
      </div>
      <div className="border-b border-zinc-800/80 px-4 py-4">
        <div className="mb-3 flex items-center gap-3"><IdentityIcon pubKey={identity.publicKey} size={32} /><span className="min-w-0 flex-1"><span className="block text-xs font-medium text-zinc-300">My identity</span><button type="button" onClick={() => void copy(identity.publicKey)} title="Copy your public address" className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-500 hover:text-zinc-300">{shortAddress(identity.publicKey)}{copied ? <Check className="size-3 text-indigo-300" /> : <Copy className="size-3" />}</button></span><Button variant="outline" size="sm" className="text-xs" onClick={() => { setCopied(false); setShareOpen(true) }}><Link2 className="size-3.5" /> Invite a friend</Button></div>
        <Button variant="outline" className="w-full justify-start gap-2 border-zinc-800 text-zinc-400" onClick={() => setSearchOpen(true)}><Search className="size-4" /> Search all messages<span className="ml-auto hidden text-[10px] text-zinc-600 lg:inline">Ctrl ⇧ F</span></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="px-3 pt-3">{selfConversation ? <ConversationRow conversation={selfConversation} selected={selectedConversation === identity.publicKey} owner={identity.publicKey} /> : <Link href={conversationHref(identity.publicKey)} className="flex items-center gap-3 rounded-xl p-3 text-sm font-medium text-indigo-200 hover:bg-zinc-900"><UserRound className="size-5" /> Message yourself</Link>}</div>
        <div className="flex items-center justify-between px-5 pb-2 pt-5"><h2 className="text-sm font-medium text-zinc-300">Chats {totalUnread > 0 && <span className="ml-1 text-xs text-indigo-300">{totalUnread} unread</span>}</h2><div className="flex gap-1"><Button size="icon" variant="ghost" aria-label="Create group chat" onClick={() => { setGroupError(""); setGroupOpen(true) }}><Users className="size-4" /></Button><Button size="icon" variant="ghost" aria-label="Add contact" onClick={() => { setAddError(""); setAddOpen(true) }}><Plus className="size-4" /></Button></div></div>
        <div className="mx-4 mb-3 flex gap-1 rounded-lg bg-zinc-900 p-1" role="group" aria-label="Conversation view">
          <button type="button" aria-pressed={conversationView === "inbox"} onClick={() => { setConversationView("inbox"); setFilter(""); setNotice("") }} className={`flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md px-2 text-xs font-medium ${conversationView === "inbox" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}><Inbox className="size-3.5" />Inbox<span className="text-zinc-400">{activeConversations.length}</span></button>
          <button type="button" aria-pressed={conversationView === "archived"} onClick={() => { setConversationView("archived"); setFilter(""); setNotice("") }} className={`flex min-h-10 flex-1 items-center justify-center gap-2 rounded-md px-2 text-xs font-medium ${conversationView === "archived" ? "bg-zinc-800 text-zinc-100" : "text-zinc-500 hover:text-zinc-200"}`}><Archive className="size-3.5" />Archived<span className="text-zinc-400">{archivedConversations.length}</span></button>
        </div>
        {conversationView === "archived" && <p className="mx-5 mb-3 text-xs leading-relaxed text-zinc-500">Hidden from your inbox. Messages stay saved until you delete the chat.</p>}
        {conversationView === "inbox" && requests.length > 0 && <button type="button" onClick={() => { setRequestError(""); setRequestsOpen(true) }} className="mx-4 mb-3 flex w-[calc(100%-2rem)] items-center gap-3 rounded-xl border border-indigo-400/20 bg-indigo-400/5 px-3 py-3 text-left text-sm text-indigo-200"><Inbox className="size-4" /><span className="flex-1">Message requests</span><span className="rounded-full bg-indigo-400/15 px-2 py-0.5 text-xs">{requests.length}</span></button>}
        {(visibleConversations.length > 3 || filter) && <div className="relative mx-4 mb-3"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-zinc-500" /><Input aria-label="Filter conversations" placeholder="Filter conversations" value={filter} onChange={event => setFilter(event.target.value)} className="pl-9" /></div>}
        {(error || messaging.error) && <p role="alert" className="mx-5 mb-4 break-words text-sm leading-relaxed text-red-300">{error || messaging.error}</p>}
        {notice && <p role="status" className="mx-5 mb-4 text-sm text-indigo-200">{notice}</p>}
        <nav className="space-y-1 px-3 pb-4" aria-label={conversationView === "archived" ? "Archived conversations" : "Conversations"}>
          {!ready && <p role="status" className="px-4 py-6 text-sm text-zinc-500">Loading conversations…</p>}
          {ready && conversationView === "inbox" && activeConversations.length === 0 && <div className="px-4 py-6 text-center"><Inbox className="mx-auto mb-3 size-7 text-zinc-600" /><p className="text-sm text-zinc-400">No chats in your inbox.</p><p className="mt-2 text-sm leading-relaxed text-zinc-500">{archivedConversations.length ? "Open Archived to restore a chat, or start a new one." : "Add a friend or create a group to start talking."}</p><div className="mt-4 flex flex-wrap justify-center gap-2"><Button size="sm" onClick={() => setAddOpen(true)}><Plus className="size-3.5" /> Add contact</Button><Button size="sm" variant="outline" onClick={() => setGroupOpen(true)}><Users className="size-3.5" /> New group</Button></div></div>}
          {ready && conversationView === "archived" && archivedConversations.length === 0 && <div className="px-4 py-6 text-center"><Archive className="mx-auto mb-3 size-7 text-zinc-600" /><p className="text-sm text-zinc-400">No archived chats.</p><p className="mt-2 text-sm leading-relaxed text-zinc-500">Open a chat’s options and choose Archive chat to hide it here.</p></div>}
          {visibleConversations.length > 0 && filteredConversations.length === 0 && <p role="status" className="px-4 py-6 text-center text-sm text-zinc-400">No conversations match your filter.</p>}
          {filteredConversations.map(conversation => {
            const contact = contacts.find(item => item.pub === conversation.id)
            return <ConversationRow key={conversation.id} conversation={conversation} selected={selectedConversation === conversation.id} owner={identity.publicKey} actions={<ConversationActions conversation={conversation} onError={setError} onNotice={setNotice}>{conversation.kind === "direct" && <>{contact ? <DropdownMenuItem onSelect={() => { setEditing(contact); setEditAlias(contact.alias); setEditError("") }}><Pencil /> Rename contact</DropdownMenuItem> : <DropdownMenuItem onSelect={() => { setNewPub(conversation.id); setNewAlias(""); setAddError(""); setAddOpen(true) }}><Plus /> Add to contacts</DropdownMenuItem>}<DropdownMenuItem onSelect={() => void copy(conversation.id)}><Copy /> Copy address</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { void messaging.blockContact(conversation.id).catch(cause => setError(errorMessage(cause))) }}><Ban /> Block messages</DropdownMenuItem>{contact && <DropdownMenuItem variant="destructive" onSelect={() => setRemove(contact)}><Trash2 /> Remove contact</DropdownMenuItem>}</>}</ConversationActions>} />
          })}
        </nav>
      </div>
      <div className="chat-bottom flex shrink-0 items-center gap-2 border-t border-zinc-800/80 px-5 py-3 text-xs text-zinc-500"><span className={`size-1.5 rounded-full ${status === "online" ? "bg-emerald-400" : status === "connecting" ? "animate-pulse bg-amber-300" : "bg-zinc-500"}`} /><span role="status" className="min-w-0 flex-1">{status === "online" ? "Inbox connected" : status === "connecting" ? "Connecting inbox…" : "Inbox sync unavailable"}</span>{status === "offline" && <Button variant="ghost" size="icon" className="size-6" aria-label="Reconnect inbox" onClick={() => void messaging.sync().catch(cause => setError(errorMessage(cause)))}><RefreshCw className="size-3" /></Button>}<Button variant="ghost" size="icon" className="size-7" aria-label="Set up notifications" onClick={() => { setSettingsError(""); setSettingsOpen(true) }}>{permission === "granted" ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}</Button></div>
    </aside>
    <main className={`${inConversation ? "flex" : "hidden md:flex"} min-h-0 min-w-0 flex-1 flex-col`}>{children}</main>

    <Dialog open={addOpen} onOpenChange={setAddOpen}><DialogContent><DialogHeader><DialogTitle>Add a contact</DialogTitle><DialogDescription>Paste your friend's public address or invite link. Review it, then choose Add contact.</DialogDescription></DialogHeader><form onSubmit={event => void addContact(event)} className="space-y-4"><div className="space-y-2"><Label htmlFor="contact-address">Address or invite link</Label><Input id="contact-address" placeholder="Paste their public address or link" value={newPub} onChange={event => setNewPub(event.target.value)} required maxLength={2048} spellCheck={false} autoComplete="off" /></div><div className="space-y-2"><Label htmlFor="contact-name">Name <span className="text-zinc-500">(optional)</span></Label><Input id="contact-name" placeholder="How you know them" value={newAlias} onChange={event => setNewAlias(event.target.value)} maxLength={60} /></div>{addError && <p role="alert" className="text-sm text-red-300">{addError}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button><Button type="submit" disabled={!newPub.trim() || adding}>{adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Add contact</Button></DialogFooter></form></DialogContent></Dialog>

    <Dialog open={groupOpen} onOpenChange={open => { if (!creating) setGroupOpen(open) }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Create a group chat</DialogTitle><DialogDescription>Choose a name and the people to invite. You will be the group admin.</DialogDescription></DialogHeader><form onSubmit={event => void createGroup(event)} className="space-y-4"><div className="space-y-2"><Label htmlFor="group-name">Group name</Label><Input id="group-name" placeholder="Study group, weekend plans…" value={groupName} onChange={event => setGroupName(event.target.value)} maxLength={80} required /></div><fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Add members <span className="font-normal text-zinc-500">({groupMembers.length} selected)</span></legend><div className="max-h-64 space-y-1 overflow-y-auto rounded-xl border border-zinc-800 p-2">{contacts.filter(contact => !preferences.blocked.includes(contact.pub)).map(contact => <label key={contact.pub} className="flex cursor-pointer items-center gap-3 rounded-lg p-2 hover:bg-zinc-800"><input type="checkbox" className="size-4 accent-indigo-400" checked={groupMembers.includes(contact.pub)} onChange={event => setGroupMembers(current => event.target.checked ? [...current, contact.pub] : current.filter(pub => pub !== contact.pub))} /><IdentityIcon pubKey={contact.pub} size={28} /><span className="min-w-0"><span className="block truncate text-sm">{contact.alias || shortAddress(contact.pub)}</span><span className="block font-mono text-[10px] text-zinc-500">{shortAddress(contact.pub)}</span></span></label>)}{contacts.filter(contact => !preferences.blocked.includes(contact.pub)).length === 0 && <p className="p-3 text-sm text-zinc-500">Add a contact first to invite them to a group.</p>}</div></fieldset>{groupError && <p role="alert" className="text-sm text-red-300">{groupError}</p>}<DialogFooter><Button type="button" variant="outline" disabled={creating} onClick={() => setGroupOpen(false)}>Cancel</Button><Button type="submit" disabled={creating || !groupName.trim() || groupMembers.length === 0}>{creating ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4" />} Create group</Button></DialogFooter></form></DialogContent></Dialog>

    <Dialog open={shareOpen} onOpenChange={setShareOpen}><DialogContent><DialogHeader><DialogTitle>Invite a friend</DialogTitle><DialogDescription>Send this link to someone you want to chat with. They can review your address and add you.</DialogDescription></DialogHeader><div className="space-y-2"><Label htmlFor="invite-link">Your invite link</Label><div className="flex gap-2"><Input id="invite-link" readOnly value={inviteLink} onFocus={event => event.target.select()} className="font-mono text-xs" /><Button aria-label="Copy invite link" onClick={() => void copy(inviteLink)}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button></div><p aria-live="polite" className="min-h-4 text-xs text-indigo-300">{copied ? "Copied to clipboard" : ""}</p></div><details className="text-xs text-zinc-500"><summary className="cursor-pointer">View full public address</summary><p className="mt-2 select-all break-all rounded-lg bg-zinc-900 p-3 font-mono leading-relaxed text-zinc-400">{identity.publicKey}</p></details></DialogContent></Dialog>

    <Dialog open={searchOpen} onOpenChange={setSearchOpen}><DialogContent className="max-h-[90dvh] sm:max-w-2xl"><DialogHeader><DialogTitle>Search all messages</DialogTitle><DialogDescription>Find messages, links, filenames, and polls across your conversations.</DialogDescription></DialogHeader><div className="relative"><Search className="pointer-events-none absolute left-3 top-3 size-4 text-zinc-500" /><Input autoFocus aria-label="Search messages, links, and files" placeholder="Search messages, links, and files" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} className="pl-9" /></div><div className="max-h-[55dvh] space-y-2 overflow-y-auto" aria-live="polite">{!searchQuery.trim() ? <p className="py-8 text-center text-sm text-zinc-500">Enter a word, phrase, or filename.</p> : searchResults.length === 0 ? <p className="py-8 text-center text-sm text-zinc-500">No matching messages.</p> : <><p className="text-xs text-zinc-500">{searchResults.length} result{searchResults.length === 1 ? "" : "s"}{searchResults.length > 100 ? " · showing the latest 100" : ""}</p>{searchResults.slice(0, 100).map(message => { const conversation = conversations.find(item => item.id === message.conversationId); return <Link key={message.id} href={`${conversationHref(message.conversationId)}#message-${message.id}`} onClick={() => setSearchOpen(false)} className="block rounded-xl border border-zinc-800 p-3 hover:border-indigo-400/40 hover:bg-zinc-900"><span className="flex gap-3 text-xs"><span className="truncate font-medium text-indigo-200">{conversation?.kind === "self" ? "Message yourself" : conversation?.name || shortAddress(message.conversationId)}</span><time className="ml-auto shrink-0 text-zinc-500" dateTime={new Date(message.timestamp).toISOString()}>{new Date(message.timestamp).toLocaleDateString()}</time></span><p className="mt-2 line-clamp-3 break-words text-sm text-zinc-300">{messagePreview(message)}</p></Link> })}</>}</div></DialogContent></Dialog>

    <Dialog open={requestsOpen} onOpenChange={setRequestsOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Message requests</DialogTitle><DialogDescription>Accept a request to start talking. Blocking stops messages from that sender.</DialogDescription></DialogHeader>{requestError && <p role="alert" className="text-sm text-red-300">{requestError}</p>}{requests.length === 0 && <p className="py-6 text-center text-sm text-zinc-500">No pending requests.</p>}<div className="space-y-3">{requests.map(request => <div key={request.id} className="rounded-xl border border-zinc-800 p-4"><div className="flex items-center gap-3">{request.kind === "group" ? <Users className="size-7 text-indigo-300" /> : <IdentityIcon pubKey={request.id} size={32} />}<span className="min-w-0"><span className="block truncate text-sm font-medium">{request.name}</span><span className="block text-xs text-zinc-500">{request.kind === "group" ? `Group invitation · ${request.members.length} members` : shortAddress(request.id)}</span></span></div><p className="mt-3 line-clamp-3 break-words text-sm text-zinc-400">{messagePreview(request.lastMessage)}</p><div className="mt-4 flex justify-end gap-2"><Button size="sm" variant="outline" disabled={busyRequest !== null} onClick={() => void requestAction(request, false)}><Ban className="size-3.5" />{request.kind === "group" ? "Block sender" : "Block"}</Button><Button size="sm" disabled={busyRequest !== null} onClick={() => void requestAction(request, true)}>{busyRequest === request.id ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Accept</Button></div></div>)}</div></DialogContent></Dialog>

    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Notifications and privacy</DialogTitle><DialogDescription>Choose what Serotine shares and who can contact you.</DialogDescription></DialogHeader><div className="space-y-5"><section className="space-y-2"><h3 className="text-sm font-medium">Browser notifications</h3><p className="text-sm text-zinc-500">{permission === "granted" ? "Notifications are enabled. Mute a chat or choose mentions only from its conversation menu." : permission === "unsupported" ? "Notifications are unavailable in this browser." : permission === "denied" ? "Notifications are blocked. Allow them in this site's browser settings to turn them on." : "Get notified of new messages while Serotine is open."}</p>{permission !== "granted" && permission !== "unsupported" && permission !== "denied" && <Button size="sm" onClick={() => void requestNotifications()}><Bell className="size-4" /> Enable notifications</Button>}</section><label className="flex items-start gap-3 border-t border-zinc-800 pt-4"><input type="checkbox" className="mt-0.5 size-4 accent-indigo-400" checked={preferences.readReceipts} onChange={event => { void messaging.setReadReceipts(event.target.checked).catch(cause => setSettingsError(errorMessage(cause))) }} /><span><span className="block text-sm font-medium">Send read receipts</span><span className="mt-1 block text-sm text-zinc-500">Let people know when you have opened their messages.</span></span></label><section className="space-y-3 border-t border-zinc-800 pt-4"><h3 className="text-sm font-medium">Blocked contacts</h3>{preferences.blocked.length === 0 ? <p className="text-sm text-zinc-500">No blocked contacts.</p> : preferences.blocked.map(pub => <div key={pub} className="flex items-center gap-3"><IdentityIcon pubKey={pub} size={28} /><span className="min-w-0 flex-1 truncate text-sm">{contacts.find(contact => contact.pub === pub)?.alias || shortAddress(pub)}</span><Button size="sm" variant="outline" onClick={() => { void messaging.blockContact(pub, false).catch(cause => setSettingsError(errorMessage(cause))) }}>Unblock</Button></div>)}</section>{settingsError && <p role="alert" className="text-sm text-red-300">{settingsError}</p>}</div></DialogContent></Dialog>

    <Dialog open={!!editing} onOpenChange={open => { if (!open) setEditing(null) }}><DialogContent><DialogHeader><DialogTitle>Rename contact</DialogTitle><DialogDescription>This name is only shown to you. Their address stays the same.</DialogDescription></DialogHeader><form onSubmit={renameContact} className="space-y-4"><Label htmlFor="edit-contact-name">Contact name</Label><Input id="edit-contact-name" value={editAlias} onChange={event => setEditAlias(event.target.value)} maxLength={60} placeholder="How you know them" />{editError && <p role="alert" className="text-sm text-red-300">{editError}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit">Save name</Button></DialogFooter></form></DialogContent></Dialog>
    <Dialog open={!!remove} onOpenChange={open => { if (!open) setRemove(null) }}><DialogContent><DialogHeader><DialogTitle>Remove this contact?</DialogTitle><DialogDescription>This removes {remove?.alias || "the contact"} from your address book. Your conversation and messages remain in the inbox. To stop new messages, choose Block messages.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setRemove(null)}>Cancel</Button><Button variant="destructive" onClick={() => { if (!remove) return; try { saveContacts(identity.publicKey, loadContacts(identity.publicKey).filter(contact => contact.pub !== remove.pub)); setNotice("Contact removed. Your message history is still available."); setRemove(null) } catch (cause) { setError(errorMessage(cause)); setRemove(null) } }}>Remove contact</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
