"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { ArrowLeft, Bell, BellOff, Check, Copy, Flag, Hash, Link2, Loader2, LogOut, Megaphone, MoreHorizontal, Plus, RefreshCw, Settings2, Trash2, Users } from "lucide-react"
import { useCommunities, useMessaging } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { QrCodeCard } from "@/components/qr-code"
import { QrScanner } from "@/components/qr-scanner"
import { shortAddress } from "@/lib/identity"
import { communityChannelKey, isCommunityModerator, parseCommunityInvite } from "@/lib/community-protocol"
import type { CommunityAdmission, CommunityChannel, CommunityInvite, CommunityJoinRequest, CommunityMessage, CommunityRecord } from "@/lib/community-types"
import { CommunityConversation } from "@/components/community-conversation"
import { useNavigationPreferences } from "@/hooks/use-navigation-preferences"
import { loadNavigationPreferences, preferredCommunity, rememberNavigation, sortByRecentActivity } from "@/lib/navigation-preferences"

type CommunityApi = ReturnType<typeof useCommunities>
const selectClass = "h-9 min-w-0 rounded-sm border border-input bg-background px-3 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
const failure = (cause: unknown) => cause instanceof Error ? cause.message : "Something went wrong. Please try again."
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`
const deliveryLabels: Record<string, string> = { delete: "Community deletion", transfer: "Ownership transfer", state: "Community update", join: "Join request", decision: "Admission decision", command: "Management request", leave: "Departure", hide: "Message hiding", report: "Report" }
const deliveryLabel = (kind: string) => deliveryLabels[kind] || "Community action"

function latestRequests(requests: CommunityJoinRequest[], key: (request: CommunityJoinRequest) => string) {
  const latest = new Map<string, CommunityJoinRequest>()
  for (const request of requests) {
    const previous = latest.get(key(request))
    if (!previous || request.timestamp >= previous.timestamp) latest.set(key(request), request)
  }
  return [...latest.values()]
}

function StatusText({ error, notice }: { error?: string | null; notice?: string }) {
  return <>{error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}{notice && <p role="status" className="break-words text-sm text-primary">{notice}</p>}</>
}

function AdmissionSelect({ value, onChange, id }: { value: CommunityAdmission; onChange: (value: CommunityAdmission) => void; id: string }) {
  return <div className="space-y-2"><Label htmlFor={id}>Joining</Label><select id={id} className={`${selectClass} w-full`} value={value} onChange={event => onChange(event.target.value as CommunityAdmission)}><option value="approval">Primary owner approval</option><option value="direct">Anyone with a valid invite</option></select><p className="text-xs leading-relaxed text-muted-foreground">The primary owner must have Serotine open to complete admissions. Communities hold up to 20 members.</p></div>
}

function CreateCommunity({ api, onClose, onCreated }: { api: CommunityApi; onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [admission, setAdmission] = useState<CommunityAdmission>("approval")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const create = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("")
    try { const id = await api.createCommunity({ name: name.trim(), description: description.trim(), admission }); onCreated(id); onClose() }
    catch (cause) { setError(failure(cause)) } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent><DialogHeader><DialogTitle>Create a community</DialogTitle><DialogDescription>A small shared space with text channels. Share invitations with people you want to join.</DialogDescription></DialogHeader><form onSubmit={event => void create(event)} className="space-y-4"><div className="space-y-2"><Label htmlFor="community-name">Name</Label><Input id="community-name" autoFocus required maxLength={80} value={name} onChange={event => setName(event.target.value)} placeholder="Your community" /></div><div className="space-y-2"><Label htmlFor="community-description">Description</Label><Textarea id="community-description" maxLength={500} value={description} onChange={event => setDescription(event.target.value)} placeholder="What is this space for?" /></div><AdmissionSelect id="community-admission" value={admission} onChange={setAdmission} /><p className="text-xs text-muted-foreground">New members see messages sent after they join. There is no public directory.</p><StatusText error={error} /><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !name.trim()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}Create community</Button></DialogFooter></form></DialogContent></Dialog>
}

function JoinCommunity({ api, initialInvite, onClose, onRequested }: { api: CommunityApi; initialInvite: string; onClose: () => void; onRequested: (id: string) => void }) {
  const [input, setInput] = useState(initialInvite)
  const [preview, setPreview] = useState<{ input: string; invite: CommunityInvite } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const ticket = useRef(0)
  const inspect = async (value: string) => {
    const current = ++ticket.current
    setBusy(true); setError(""); setPreview(null)
    try { const invite = await parseCommunityInvite(value); if (current === ticket.current) setPreview({ input: value, invite }) }
    catch (cause) { if (current === ticket.current) setError(failure(cause)) }
    finally { if (current === ticket.current) setBusy(false) }
  }
  useEffect(() => { if (initialInvite) void inspect(initialInvite); return () => { ticket.current++ } }, [initialInvite])
  const invite = preview?.input === input ? preview.invite : null
  const alreadyJoined = invite && api.model.communities.some(item => item.id === invite.communityId && item.joined && !item.deleted)
  const pending = invite && api.model.requests.some(item => item.communityId === invite.communityId && item.author === api.identity?.publicKey && item.status === "pending")
  const join = async () => {
    if (!invite || busy) return
    setBusy(true); setError("")
    try { const id = await api.joinCommunity(input); onRequested(id); onClose() }
    catch (cause) { setError(failure(cause)) } finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Join a community</DialogTitle><DialogDescription>Paste an invitation or scan its QR code. Review the community before choosing to join.</DialogDescription></DialogHeader><form className="space-y-3" onSubmit={event => { event.preventDefault(); void inspect(input) }}><Label htmlFor="community-invite">Community invite</Label><Textarea id="community-invite" value={input} disabled={busy} maxLength={48000} className="min-h-20 break-all font-mono text-xs" placeholder="Paste an invite link" onChange={event => { ticket.current++; setBusy(false); setInput(event.target.value); setPreview(null); setError("") }} /><div className="flex flex-wrap items-start gap-2"><Button type="submit" size="sm" variant="outline" disabled={busy || !input.trim()}>{busy && <Loader2 className="size-4 animate-spin" />}Preview invitation</Button><QrScanner disabled={busy} parseValue={async value => { await parseCommunityInvite(value); return value }} onScan={value => { setInput(value); void inspect(value) }} description="Scan a Serotine community invitation. QR images are read on this device." successMessage="Invitation read. Review the community before joining." /></div></form>
    {invite && <div className="space-y-3 rounded-sm border border-border bg-muted/30 p-4"><div className="flex items-center gap-3"><Users className="size-6 text-primary" /><h3 className="min-w-0 break-words font-medium">{invite.name}</h3></div>{invite.description && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{invite.description}</p>}<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"><dt className="text-muted-foreground">Owner</dt><dd className="break-all font-mono" title={invite.owner}>{shortAddress(invite.owner)}</dd><dt className="text-muted-foreground">Admission</dt><dd>{invite.admission === "approval" ? "Approval required" : "Anyone with this invite"}</dd><dt className="text-muted-foreground">Expires</dt><dd>{new Date(invite.expiresAt).toLocaleString()}</dd><dt className="text-muted-foreground">History</dt><dd>Messages sent after you join</dd></dl><p className="text-xs leading-relaxed text-muted-foreground">Your public address is shared with the owner when you request to join, and with the community after admission. The owner must have Serotine open to complete your admission. The owner may have changed or revoked this invitation.</p>{alreadyJoined ? <p className="text-sm text-primary">You are already a member.</p> : pending ? <p className="text-sm text-primary">Your request is pending. You have not joined yet.</p> : null}</div>}
    <StatusText error={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={!invite || busy || !!alreadyJoined || !!pending} onClick={() => void join()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4" />}{invite?.admission === "direct" ? "Join community" : "Request to join"}</Button></DialogFooter></DialogContent></Dialog>
}

type EditableCommunitySettings = Pick<CommunityRecord, "name" | "description" | "admission" | "joiningPaused" | "channels">
const settingsSnapshot = (settings: EditableCommunitySettings) => JSON.stringify({
  name: settings.name.trim(), description: settings.description.trim(), admission: settings.admission,
  joiningPaused: settings.joiningPaused,
  channels: settings.channels.map(channel => ({ id: channel.id, name: channel.name.trim(), posting: channel.posting })),
})

type SettingsTab = "about" | "members" | "requests" | "reports" | "ownership"
type OwnershipConfirmation =
  | { kind: "coOwner"; target: string; enabled: boolean }
  | { kind: "transfer"; target: string; keepAsCoOwner: boolean }
  | { kind: "delete" }

function CommunitySettings({ api, community, displayName, initialTab = "about", onClose, onCompleted }: {
  api: CommunityApi; community: CommunityRecord; displayName: (pub: string) => string
  initialTab?: SettingsTab; onClose: () => void; onCompleted: (message: string) => void
}) {
  const owner = community.owner === api.identity?.publicKey
  const coOwner = !!api.identity && !!community.coOwners?.includes(api.identity.publicKey)
  const manager = owner || coOwner
  const moderator = !!api.identity && isCommunityModerator(community, api.identity.publicKey)
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  const [name, setName] = useState(community.name)
  const [description, setDescription] = useState(community.description)
  const [admission, setAdmission] = useState(community.admission)
  const [paused, setPaused] = useState(community.joiningPaused)
  const [channels, setChannels] = useState(community.channels)
  const latestSettings = settingsSnapshot(community)
  const draftSettings = settingsSnapshot({ name, description, admission, joiningPaused: paused, channels })
  const [baseSettings, setBaseSettings] = useState(latestSettings)
  const settingsConflict = latestSettings !== baseSettings && draftSettings !== baseSettings && draftSettings !== latestSettings
  const reloadSettings = useCallback(() => {
    const latest = JSON.parse(latestSettings) as EditableCommunitySettings
    setName(latest.name); setDescription(latest.description); setAdmission(latest.admission)
    setPaused(latest.joiningPaused); setChannels(latest.channels); setBaseSettings(latestSettings)
  }, [latestSettings])
  useEffect(() => {
    // Follow incoming settings while pristine, and acknowledge our own accepted
    // save. A different incoming edit never replaces an unsaved local draft.
    if (latestSettings !== baseSettings && !settingsConflict) reloadSettings()
  }, [latestSettings, baseSettings, settingsConflict, reloadSettings])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [invite, setInvite] = useState("")
  const [copied, setCopied] = useState(false)
  const [successor, setSuccessor] = useState("")
  const [keepAsCoOwner, setKeepAsCoOwner] = useState(false)
  const [confirmation, setConfirmation] = useState<OwnershipConfirmation | null>(null)
  const [deleteName, setDeleteName] = useState("")
  const run = async (action: () => Promise<unknown>, success: string) => {
    if (busy) return false
    setBusy(true); setError(""); setNotice("")
    try { await action(); setNotice(success); return true }
    catch (cause) { setError(failure(cause)); return false }
    finally { setBusy(false) }
  }
  const managementNotice = owner
    ? "Community updated on this device. Changes are queued for delivery to members."
    : "Action queued for the primary owner. It takes effect after delivery and processing on their device."
  const requests = useMemo(() => latestRequests(api.model.requests.filter(item => item.communityId === community.id), item => item.author).filter(item => item.status === "pending"), [api.model.requests, community.id])
  const reports = api.model.reports.filter(item => item.communityId === community.id)
  const successors = community.effectiveMembers.filter(pub => pub !== community.owner)
  const validSuccessor = successors.includes(successor)
  const updateChannel = (id: string, changes: Partial<CommunityChannel>) => setChannels(current => current.map(item => item.id === id ? { ...item, ...changes } : item))
  const ask = (value: OwnershipConfirmation) => { setError(""); setNotice(""); setDeleteName(""); setConfirmation(value) }
  const confirm = async (event: FormEvent) => {
    event.preventDefault()
    if (!confirmation || !owner || busy) return
    if (confirmation.kind === "coOwner") {
      const { target, enabled } = confirmation
      if (await run(() => api.setCoOwner(community.id, target, enabled), `${enabled ? "Co-owner role added" : "Co-owner role removed"}. The update is queued for members.`)) setConfirmation(null)
    } else if (confirmation.kind === "transfer") {
      const { target, keepAsCoOwner: keep } = confirmation
      if (!successors.includes(target)) { setError("Choose someone who is still a member of this community."); return }
      if (await run(() => api.transferOwnership(community.id, target, keep), "")) {
        onCompleted(`Ownership transferred to ${displayName(target)} on this device. You are now ${keep ? "a co-owner" : "a member"}. Previous invitations are revoked; the update is queued for members.`)
        onClose()
      }
    } else if (deleteName === community.name) {
      if (await run(() => api.deleteCommunity(community.id), "")) {
        onCompleted("Community deleted on this device. The deletion is queued for members and closes their community when it arrives. Saved copies cannot be recalled.")
        onClose()
      }
    }
  }
  const confirmationTitle = confirmation?.kind === "delete" ? "Delete this community?"
    : confirmation?.kind === "transfer" ? "Transfer primary ownership?"
    : confirmation?.enabled ? "Make this member a co-owner?" : "Remove the co-owner role?"
  const confirmationLabel = confirmation?.kind === "delete" ? "Delete community"
    : confirmation?.kind === "transfer" ? "Confirm transfer"
    : confirmation?.enabled ? "Make co-owner" : "Remove co-owner role"
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>Community settings</DialogTitle><DialogDescription className="break-words">{community.name} · {plural(community.effectiveMembers.length, "member")}</DialogDescription></DialogHeader>
      <nav aria-label="Community settings sections" className="flex flex-wrap gap-1 border-b border-border pb-3">
        {(["about", "members", ...(owner ? ["requests", "reports", "ownership"] : moderator ? ["reports"] : [])] as SettingsTab[]).map(item => <Button key={item} size="sm" disabled={busy} variant="ghost" className={tab === item ? "rounded-none border-b border-primary bg-primary/5 text-primary" : "rounded-none border-b border-transparent text-muted-foreground"} onClick={() => setTab(item)} aria-current={tab === item ? "page" : undefined}>{item[0].toUpperCase() + item.slice(1)}{item === "requests" && requests.length > 0 ? ` (${requests.length})` : ""}</Button>)}
      </nav>
      {!owner && moderator && <p className="text-xs leading-relaxed text-muted-foreground">{coOwner ? "As a co-owner, you can manage settings, channels, moderators, and members. " : "Membership decisions are queued for the primary owner. "}Changes take effect when the primary owner has Serotine open and processes them. Hiding a message updates this device immediately and is queued for other members.</p>}
      {tab === "about" && <div className="space-y-5">
        {manager ? <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (settingsConflict) return; void run(() => api.updateCommunity(community.id, { name: name.trim(), description: description.trim(), admission, joiningPaused: paused, channels: channels.map(channel => ({ ...channel, name: channel.name.trim() })) }), managementNotice) }}>
          {settingsConflict && <div role="alert" className="space-y-2 rounded-sm border border-border bg-muted/40 p-3">
            <p className="text-sm font-medium">Community settings changed while you were editing.</p>
            <p className="text-xs leading-relaxed text-muted-foreground">Your edits are still here. Reload the latest settings before saving. Reloading discards your unsaved edits.</p>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { reloadSettings(); setError(""); setNotice("Latest settings loaded. Review them before making changes.") }}><RefreshCw className="size-4" />Reload latest settings</Button>
          </div>}
          <div className="space-y-2"><Label htmlFor="edit-community-name">Name</Label><Input id="edit-community-name" required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="edit-community-description">Description</Label><Textarea id="edit-community-description" maxLength={500} value={description} onChange={event => setDescription(event.target.value)} /></div>
          <AdmissionSelect id="edit-community-admission" value={admission} onChange={setAdmission} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4 accent-primary" checked={paused} onChange={event => setPaused(event.target.checked)} />Pause new members</label>
          <fieldset className="space-y-3"><legend className="app-eyebrow mb-3">Channels ({channels.length}/8)</legend>
            {channels.map(channel => <div key={channel.id} className="flex min-w-0 flex-wrap items-center gap-2">
              <Input aria-label={`Channel name ${channel.name}`} maxLength={40} required className="min-w-32 flex-1" value={channel.name} onChange={event => updateChannel(channel.id, { name: event.target.value })} />
              <select className={`${selectClass} max-w-full`} aria-label={`Who can post in ${channel.name}`} value={channel.posting} onChange={event => updateChannel(channel.id, { posting: event.target.value as CommunityChannel["posting"] })}><option value="members">Everyone can post</option><option value="moderators">Announcements</option></select>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove channel ${channel.name}`} disabled={channels.length <= 1 || busy} onClick={() => setChannels(current => current.filter(item => item.id !== channel.id))}><Trash2 className="size-4" /></Button>
            </div>)}
            <Button type="button" variant="outline" size="sm" disabled={channels.length >= 8 || busy} onClick={() => setChannels(current => [...current, { id: crypto.randomUUID(), name: `channel-${current.length + 1}`, posting: "members" }])}><Plus className="size-4" />Add channel</Button>
            <p className="text-xs text-muted-foreground">Owners and moderators can post in announcement channels. Removed channels disappear from navigation.</p>
          </fieldset>
          <Button type="submit" disabled={busy || settingsConflict || !name.trim() || channels.some(channel => !channel.name.trim())}>{busy && <Loader2 className="size-4 animate-spin" />}{owner ? "Save settings" : "Request settings update"}</Button>
        </form> : <div className="space-y-3">
          <p className="whitespace-pre-wrap break-words text-sm">{community.description || "No description yet."}</p>
          <p className="text-sm text-muted-foreground">{community.admission === "approval" ? "Joining requires approval." : "Anyone with a valid invite may request admission."} {community.joiningPaused && "New memberships are paused."} New members see messages sent after they join.</p>
          <p className="break-words text-xs text-muted-foreground">Primary owner: {displayName(community.owner)}</p>
        </div>}
        {manager && <section className="space-y-3 border-t border-border pt-4">
          <h3 className="app-eyebrow">Invitations</h3>
          <p className="text-xs text-muted-foreground">{owner ? "Generate a signed invitation to share. " : "The primary owner generates invitations and completes admissions. "}Revoking invitations makes all previously issued invitations unusable for new joins.</p>
          <div className="flex flex-wrap gap-2">
            {owner && <Button variant="outline" size="sm" disabled={busy || community.joiningPaused} onClick={() => void run(async () => { setInvite(await api.createInvite(community.id)); setCopied(false) }, "Invitation ready to share.")}><Link2 className="size-4" />Generate invite</Button>}
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void run(async () => { await api.revokeInvites(community.id); setInvite("") }, owner ? "Previous invitations revoked on this device. The update is queued for members." : managementNotice)}>{owner ? "Revoke all invites" : "Request invite revocation"}</Button>
          </div>
          {owner && invite && <div className="space-y-3 rounded-sm border border-border p-3"><QrCodeCard value={invite} title="Community invitation QR code" caption="Scan this invitation in Serotine, review the community, and choose to join." downloadName="serotine-community-invite.png" /><Label htmlFor="share-community-invite">Invite link</Label><div className="flex min-w-0 gap-2"><Input id="share-community-invite" readOnly value={invite} className="font-mono text-xs" onFocus={event => event.target.select()} /><Button aria-label="Copy community invite" variant="outline" onClick={() => void run(async () => { await navigator.clipboard.writeText(invite); setCopied(true) }, "Invite copied.")}>{copied ? <Check className="size-4" /> : <Copy className="size-4" />}</Button></div></div>}
        </section>}
      </div>}
      {tab === "members" && <div className="space-y-4">
        {owner && <p className="text-xs leading-relaxed text-muted-foreground">Use a member’s menu to add or remove co-owners. Co-owners manage settings, channels, moderators, and members. Only the primary owner can change co-owners, transfer ownership, or delete the community.</p>}
        <div className="space-y-2">{community.effectiveMembers.map(pub => {
          const isOwner = pub === community.owner
          const isCoOwner = !!community.coOwners?.includes(pub)
          const isModerator = community.moderators.includes(pub)
          const editable = moderator && !isOwner && pub !== api.identity?.publicKey && (owner || (!isCoOwner && (coOwner || !isModerator)))
          return <div key={pub} className="flex flex-wrap items-center gap-3 border-b border-border py-3">
            <IdentityIcon pubKey={pub} size={28} /><div className="min-w-0 flex-1"><p className="truncate text-sm" title={pub}>{displayName(pub)}</p><p className="text-xs text-muted-foreground">{isOwner ? "Primary owner" : isCoOwner ? "Co-owner" : isModerator ? "Moderator" : "Member"}</p></div>
            {editable && <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" disabled={busy} aria-label={`Manage ${displayName(pub)}`}><MoreHorizontal className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
              {owner && <DropdownMenuItem onClick={() => ask({ kind: "coOwner", target: pub, enabled: !isCoOwner })}>{isCoOwner ? "Remove co-owner role" : "Make co-owner"}</DropdownMenuItem>}
              {owner && <DropdownMenuItem onClick={() => { setSuccessor(pub); setTab("ownership"); setError(""); setNotice("") }}>Transfer ownership…</DropdownMenuItem>}
              {!isCoOwner && <>
                {manager && <DropdownMenuItem onClick={() => void run(() => api.moderate(community.id, isModerator ? "demote" : "promote", pub), managementNotice)}>{isModerator ? "Remove moderator role" : "Make moderator"}</DropdownMenuItem>}
                <DropdownMenuItem onClick={() => void run(() => api.moderate(community.id, "remove", pub), managementNotice)}>Remove member</DropdownMenuItem>
                <DropdownMenuItem className="text-destructive" onClick={() => void run(() => api.moderate(community.id, "ban", pub), managementNotice)}>Ban member</DropdownMenuItem>
              </>}
            </DropdownMenuContent></DropdownMenu>}
          </div>
        })}</div>
        {moderator && community.bans.length > 0 && <section className="space-y-2 border-t border-border pt-3"><h3 className="app-eyebrow">Banned addresses</h3>{community.bans.map(pub => <div key={pub} className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm" title={pub}>{displayName(pub)}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.moderate(community.id, "unban", pub), managementNotice)}>Unban</Button></div>)}</section>}
      </div>}
      {tab === "requests" && owner && <div className="space-y-3">{requests.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No pending join requests.</p>}{requests.map(request => <div key={request.id} className="flex flex-wrap items-center gap-3 border-b border-border py-3"><IdentityIcon pubKey={request.author} size={28} /><div className="min-w-0 flex-1"><p className="truncate text-sm" title={request.author}>{displayName(request.author)}</p><p className="text-xs text-muted-foreground">Requested {new Date(request.timestamp).toLocaleDateString()}</p></div><Button variant="outline" size="sm" disabled={busy} onClick={() => void run(() => api.rejectRequest(community.id, request.id), managementNotice)}>Reject</Button><Button size="sm" disabled={busy || community.effectiveMembers.length >= 20 || community.joiningPaused} onClick={() => void run(() => api.approveRequest(community.id, request.id), managementNotice)}>Approve</Button></div>)}</div>}
      {tab === "reports" && moderator && <div className="space-y-3"><p className="text-xs text-muted-foreground">Reports are shared with owners and moderators. Hiding a message conceals it in Serotine; it cannot erase copies someone already saved.</p>{reports.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No reports.</p>}{reports.map(report => { const message = api.model.messages.find(item => item.id === report.targetId && item.conversationId === community.id); return <div key={report.id} className="space-y-2 rounded-sm border border-border p-3"><p className="text-xs text-muted-foreground">Reported by {displayName(report.author)} · #{community.channels.find(channel => channel.id === report.channelId)?.name || "removed-channel"}</p><p className="whitespace-pre-wrap break-words text-sm">{report.reason}</p><blockquote className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-xs text-muted-foreground">{message?.hidden ? "Message hidden by a moderator." : message?.content || "Message is not available on this device."}</blockquote>{message && !message.hidden && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.hideMessage(community.id, report.targetId), "Message hidden on this device. The moderation update is queued for members.")}>Hide message</Button>}</div> })}</div>}
      {tab === "ownership" && owner && <div className="space-y-5">
        <p className="text-sm leading-relaxed text-muted-foreground">You are the primary owner. To leave, transfer ownership to a current member first. You can also delete the community for everyone.</p>
        <section className="space-y-3"><h3 className="app-eyebrow">Co-owners</h3><p className="text-xs leading-relaxed text-muted-foreground">Co-owners can manage settings, channels, moderators, and members. Their changes wait for you to have Serotine open. Only you can assign co-owners, transfer ownership, delete the community, generate invitations, and complete admissions.</p><Button size="sm" variant="outline" onClick={() => setTab("members")}><Users className="size-4" />Manage co-owners</Button></section>
        <section className="space-y-3 border-t border-border pt-4"><h3 className="app-eyebrow">Transfer ownership</h3>
          {successors.length > 0 ? <>
            <div className="space-y-2"><Label htmlFor="community-successor">New primary owner</Label><select id="community-successor" className={`${selectClass} w-full`} value={validSuccessor ? successor : ""} onChange={event => setSuccessor(event.target.value)}><option value="" disabled>Choose a current member</option>{successors.map(pub => <option key={pub} value={pub}>{displayName(pub)} · {shortAddress(pub)}</option>)}</select></div>
            {validSuccessor && <p className="break-all font-mono text-[10px] text-muted-foreground" aria-label="New owner public address">{successor}</p>}
            <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={keepAsCoOwner} onChange={event => setKeepAsCoOwner(event.target.checked)} />Keep me as a co-owner</label>
            <p className="text-xs leading-relaxed text-muted-foreground">Channels, members, and existing message history stay in place. Previous invitations are revoked. {keepAsCoOwner ? "You keep co-owner permissions." : "You become a regular member and can leave afterward."} The new primary owner must open Serotine to receive the transfer and manage the community.</p>
            <Button size="sm" variant="outline" disabled={busy || !validSuccessor} onClick={() => ask({ kind: "transfer", target: successor, keepAsCoOwner })}>Review ownership transfer</Button>
          </> : <p className="text-xs leading-relaxed text-muted-foreground">Another member must join before you can transfer ownership.</p>}
        </section>
        <section className="space-y-3 rounded-sm border border-destructive/30 bg-destructive/5 p-3"><h3 className="app-eyebrow">Delete community</h3><p className="text-xs leading-relaxed text-muted-foreground">Closes this community and its channels for all members when the deletion reaches their devices. Messages or copies someone already saved cannot be recalled.</p><Button size="sm" variant="destructive" disabled={busy} onClick={() => ask({ kind: "delete" })}><Trash2 className="size-4" />Delete community…</Button></section>
      </div>}
      {!confirmation && <StatusText error={error} notice={notice} />}
      <DialogFooter><Button variant="outline" onClick={onClose} disabled={busy}>Done</Button></DialogFooter>
    </DialogContent>
    <Dialog open={!!confirmation && owner} onOpenChange={open => { if (!open && !busy) { setConfirmation(null); setError("") } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{confirmationTitle}</DialogTitle><DialogDescription className="break-words">{confirmation?.kind === "delete" ? `This permanently closes ${community.name}. This action cannot be undone.` : confirmation?.kind === "transfer" ? `${displayName(confirmation.target)} will become the primary owner of ${community.name}.` : confirmation ? `${displayName(confirmation.target)} ${confirmation.enabled ? "will gain" : "will lose"} co-owner permissions.` : ""}</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={event => void confirm(event)}>
          {confirmation?.kind === "delete" ? <>
            <p className="text-sm leading-relaxed text-muted-foreground">The community closes on this device immediately and on other members’ devices when they receive the deletion. New messages and joins stop after that update. Saved message copies cannot be recalled.</p>
            <div className="space-y-2"><Label htmlFor="confirm-delete-community" className="block break-words">Type the community name to confirm: <strong>{community.name}</strong></Label><Input id="confirm-delete-community" autoFocus autoComplete="off" spellCheck={false} value={deleteName} disabled={busy} onChange={event => setDeleteName(event.target.value)} /></div>
          </> : confirmation?.kind === "transfer" ? <>
            <p className="break-all font-mono text-xs text-muted-foreground">{confirmation.target}</p>
            <p className="text-sm leading-relaxed text-muted-foreground">You will become {confirmation.keepAsCoOwner ? "a co-owner" : "a regular member"}. Only the new primary owner can transfer ownership back, change co-owners, or delete the community.</p>
            <p className="text-sm leading-relaxed text-muted-foreground">Channels, members, and existing message history stay in place. Previous invitations are revoked. The update is queued for members; the new owner must open Serotine to receive it.</p>
          </> : confirmation && <>
            <p className="break-all font-mono text-xs text-muted-foreground">{confirmation.target}</p>
            <p className="text-sm leading-relaxed text-muted-foreground">{confirmation.enabled ? "They can manage settings, channels, moderators, and members. Their changes wait for the primary owner to process them. Only the primary owner can assign co-owners, transfer ownership, or delete the community." : "They stay in the community as a regular member. The role change is queued for all members."}</p>
          </>}
          <StatusText error={error} />
          <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setConfirmation(null); setError("") }}>Cancel</Button><Button type="submit" variant={confirmation?.kind === "delete" ? "destructive" : "default"} disabled={busy || !confirmation || (confirmation.kind === "delete" && deleteName !== community.name) || (confirmation.kind === "transfer" && !successors.includes(confirmation.target))}>{busy && <Loader2 className="size-4 animate-spin" />}{confirmationLabel}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </Dialog>
}

export function CommunityHub() {
  const api = useCommunities()
  const messaging = useMessaging()
  const owner = api.identity?.publicKey || ""
  const navigationPreferences = useNavigationPreferences(owner)
  const [selectionOwner, setSelectionOwner] = useState("")
  const [selectedId, setSelectedId] = useState("")
  const [pendingCommunityId, setPendingCommunityId] = useState("")
  const [channelId, setChannelId] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [joinInput, setJoinInput] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("about")
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [report, setReport] = useState<CommunityMessage | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const communities = useMemo(() => sortByRecentActivity(api.model.communities.filter(item => item.joined && !item.deleted), navigationPreferences), [api.model.communities, navigationPreferences])
  const community = communities.find(item => item.id === selectedId) || communities[0]
  const channel = community?.channels.find(item => item.id === channelId) || community?.channels.find(item => item.id === navigationPreferences.channels[community.id]) || community?.channels[0]
  const key = community && channel ? communityChannelKey(community.id, channel.id) : ""
  const ownRequests = useMemo(() => latestRequests(api.model.requests.filter(item => item.author === api.identity?.publicKey), item => item.communityId).filter(item => item.status !== "approved" && !communities.some(community => community.id === item.communityId)), [api.model.requests, api.identity?.publicKey, communities])
  const deliveryIssues = (api.deliveryIssues ?? []).filter(issue => issue.kind !== "message" && (issue.communityId === community?.id || ownRequests.some(request => request.communityId === issue.communityId) || !communities.some(item => item.id === issue.communityId)))
  const displayName = (pub: string) => pub === api.identity?.publicKey ? "You" : messaging.contacts.find(item => item.pub === pub)?.alias || shortAddress(pub)
  const run = useCallback(async (action: () => Promise<unknown>, success = "") => {
    if (busy) return
    setBusy(true); setError(""); setNotice("")
    try { await action(); if (success) setNotice(success) } catch (cause) { setError(failure(cause)) } finally { setBusy(false) }
  }, [busy])
  const reportMessage = useCallback((message: CommunityMessage) => { setReport(message); setReason(""); setError("") }, [])
  const hideMessage = useCallback((message: CommunityMessage) => { void run(() => api.hideMessage(message.conversationId, message.id), "Message hidden on this device. The moderation update is queued for members.") }, [run, api.hideMessage])
  useEffect(() => {
    if (!owner || !api.ready || selectionOwner === owner) return
    const saved = loadNavigationPreferences(owner)
    const params = new URLSearchParams(window.location.hash.slice(1))
    const restored = preferredCommunity(api.model.communities, saved, params.get("id"))
    setSelectedId(restored?.id || "")
    setChannelId(restored?.channels.find(item => item.id === params.get("channel"))?.id || (restored && saved.channels[restored.id]) || "")
    setSelectionOwner(owner)
  }, [owner, api.ready, api.model.communities, selectionOwner])
  useEffect(() => {
    if (!owner || !api.ready || selectionOwner !== owner) return
    const newlyJoined = communities.find(item => item.id === pendingCommunityId)
    if (newlyJoined) {
      setSelectedId(newlyJoined.id); setChannelId(""); setPendingCommunityId("")
    } else if (community && selectedId !== community.id) {
      // Pin a surviving fallback so incoming activity cannot move the open server.
      setSelectedId(community.id); setChannelId(channel?.id || "")
    }
  }, [owner, api.ready, selectionOwner, communities, pendingCommunityId, selectedId, community?.id, channel?.id])
  useEffect(() => {
    if (!owner || !api.ready || selectionOwner !== owner || !community || !channel || selectedId !== community.id) return
    rememberNavigation(owner, { kind: "community", id: community.id }, channel.id)
  }, [owner, api.ready, selectionOwner, selectedId, community?.id, channel?.id])
  useEffect(() => {
    if (!api.identity || !api.ready || selectionOwner !== owner) return
    const consumeInvite = () => {
      const params = new URLSearchParams(window.location.hash.slice(1))
      const target = api.model.communities.find(item => item.id === params.get("id") && item.joined && !item.deleted)
      const targetChannel = target?.channels.find(item => item.id === params.get("channel"))
      if (target && (!params.has("channel") || targetChannel)) {
        setSelectedId(target.id); setChannelId(targetChannel?.id || "")
        params.delete("id"); params.delete("channel")
        const remaining = params.toString()
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`)
      }
      const hash = params.get("community")
      let input = hash
      try { input ||= sessionStorage.getItem("serotine_pending_community_invite"); sessionStorage.removeItem("serotine_pending_community_invite") } catch { /* Direct links still work when session storage is unavailable. */ }
      if (!input) return
      if (input.length > 48000) { setError("This community invitation is too long."); return }
      setJoinInput(input)
      if (hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`)
    }
    consumeInvite(); window.addEventListener("hashchange", consumeInvite)
    return () => window.removeEventListener("hashchange", consumeInvite)
  }, [api.identity, api.ready, api.model.communities, owner, selectionOwner])
  useEffect(() => { setSettingsOpen(false) }, [key])
  if (!api.ready || !api.identity || selectionOwner !== owner) return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading communities…</div>
  return <div className="flex h-full min-h-0 min-w-0 flex-col bg-background"><header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-background px-4 py-3 sm:px-6"><Button asChild size="icon-sm" variant="ghost" className="md:hidden"><Link href="/chat" aria-label="Back to chats"><ArrowLeft className="size-4" /></Link></Button><div className="mr-auto min-w-0"><p className="app-eyebrow mb-1 hidden sm:flex">YOUR SHARED SPACES</p><h1 className="text-lg font-medium leading-none tracking-[-0.04em]">Communities<span className="text-primary">.</span></h1></div><Button size="sm" variant="outline" onClick={() => setJoinInput("")}><Link2 className="size-4" />Join</Button><Button size="sm" onClick={() => setCreateOpen(true)}><Plus className="size-4" />Create</Button></header>
    {(error || api.error || notice || api.status !== "online") && <div className="space-y-1 border-b border-border px-4 py-2"><StatusText error={error || api.error} notice={notice} />{api.status !== "online" && <p role="status" className="text-xs text-muted-foreground">{api.status === "connecting" ? "Connecting to the relay…" : "Offline. New messages and membership changes may be delayed."}</p>}</div>}
    {deliveryIssues.length > 0 && <div role="alert" aria-label="Community delivery failures" className="max-h-36 space-y-2 overflow-y-auto border-b border-border bg-destructive/5 px-4 py-2">{deliveryIssues.map(issue => <div key={issue.id} className="flex min-w-0 items-start gap-2"><div className="min-w-0 flex-1"><p className="break-words text-xs font-medium text-destructive">{deliveryLabel(issue.kind)} not fully delivered · {api.model.communities.find(item => item.id === issue.communityId)?.name || ownRequests.find(item => item.communityId === issue.communityId)?.invite.name || "Community"}</p><p className="break-words text-xs text-muted-foreground">{issue.error}</p></div><Button size="sm" variant="outline" disabled={busy} aria-label={`Retry ${deliveryLabel(issue.kind).toLowerCase()}`} onClick={() => void run(() => api.retry(issue.id))}><RefreshCw className="size-3.5" />Retry</Button></div>)}</div>}
    {ownRequests.length > 0 && <div className="max-h-28 space-y-1 overflow-y-auto border-b border-border bg-muted/30 px-4 py-2" aria-label="Your community join requests">{ownRequests.map(request => <div key={request.id} className="flex min-w-0 items-center gap-2"><p className="min-w-0 flex-1 break-words text-xs text-muted-foreground"><span className="font-medium text-foreground">{request.invite.name}</span> · {request.status === "rejected" ? `Request declined${request.reason ? `: ${request.reason}` : "."}` : api.status !== "online" ? "Waiting to reconnect. Your admission request or membership confirmation may still be in transit." : "Waiting for owner approval or membership confirmation. You have not joined on this device yet."}</p>{request.status === "pending" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await api.sync(); await api.retryJoinRequest(request.communityId, request.id); await api.sync() }, "Admission recovery requested. Membership confirmation will appear when received.")}><RefreshCw className="size-3.5" />Retry admission</Button>}</div>)}</div>}
    {community ? <><div className="flex min-w-0 items-center gap-2 border-b border-border bg-card px-4 py-2.5 sm:px-6"><select aria-label="Choose community" className={`${selectClass} flex-1 font-medium`} value={community.id} onChange={event => { setSelectedId(event.target.value); setChannelId(""); setPendingCommunityId("") }}>{communities.map(item => <option key={item.id} value={item.id}>{item.name}{item.unreadCount ? ` (${item.unreadCount} unread)` : ""}</option>)}</select><Button size="icon-sm" variant="ghost" aria-label={community.notificationMode === "muted" ? "Unmute community" : "Mute community"} title={community.notificationMode === "muted" ? "Unmute community" : "Mute community"} disabled={busy} onClick={() => void run(() => api.setNotificationMode(community.id, community.notificationMode === "muted" ? "all" : "muted"))}>{community.notificationMode === "muted" ? <BellOff className="size-4" /> : <Bell className="size-4" />}</Button><Button size="icon-sm" variant="ghost" aria-label="Community settings" onClick={() => { setSettingsTab("about"); setSettingsOpen(true) }}><Settings2 className="size-4" /></Button><Button size="icon-sm" variant="ghost" aria-label={community.owner === api.identity.publicKey ? "Leave or delete community" : "Leave community"} onClick={() => { if (community.owner === api.identity?.publicKey) { setSettingsTab("ownership"); setSettingsOpen(true) } else setLeaveOpen(true) }}><LogOut className="size-4" /></Button></div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row"><nav aria-label="Community channels" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card p-2 lg:w-44 lg:flex-col lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-3"><p className="app-eyebrow mb-2 hidden px-2 pt-2 lg:flex">CHANNELS / {community.channels.length}</p>{community.channels.map(item => { const unread = community.channelUnread[item.id] || 0; return <button key={item.id} type="button" className={`flex min-h-9 shrink-0 items-center gap-2 rounded-sm border-l-2 px-2 text-left text-[13px] transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring ${channel?.id === item.id ? "border-primary bg-primary/8 font-medium text-primary" : "border-transparent text-muted-foreground"}`} aria-current={channel?.id === item.id ? "page" : undefined} onClick={() => setChannelId(item.id)}>{item.posting === "moderators" ? <Megaphone className="size-3.5 shrink-0" /> : <Hash className="size-3.5 shrink-0" />}<span className="max-w-36 truncate lg:flex-1">{item.name}</span>{unread > 0 && <span className="ml-auto min-w-4 rounded-sm bg-primary px-1 font-medium tabular-nums text-center text-[11px] leading-4 text-primary-foreground" aria-label={`${unread} unread messages`}>{unread > 99 ? "99+" : unread}</span>}</button> })}</nav>
        {channel && <CommunityConversation key={`${owner}:${key}`} api={api} community={community} channel={channel} onReport={reportMessage} onHide={hideMessage} />}
        </div></> : <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-10 sm:px-10"><div className="my-auto w-full max-w-xl py-4"><div className="mb-6 flex items-center justify-between border-t border-border pt-5"><p className="app-eyebrow">A SPACE OF YOUR OWN</p><Users className="size-6 text-primary" aria-hidden="true" /></div><h2 className="max-w-lg text-[clamp(2.4rem,4.4vw,4rem)] font-normal leading-[1.06] tracking-[-0.055em]">Your people.<br /><span className="text-primary">In one place.</span></h2><p className="mt-5 max-w-md text-sm leading-7 text-muted-foreground">Create a community with text and announcement channels, or join one with an invitation. Up to 20 members, with simple roles and moderation.</p><div className="mt-7 flex flex-wrap gap-3"><Button className="min-h-11" onClick={() => setCreateOpen(true)}><Plus className="size-4" />Create community</Button><Button className="min-h-11" variant="outline" onClick={() => setJoinInput("")}><Link2 className="size-4" />Use an invite</Button></div><p className="mt-8 max-w-md border-t border-border pt-4 text-xs leading-6 text-muted-foreground">Communities are shared by invitation. There is no public directory, and new members see messages from after they join.</p></div></div>}
    {createOpen && <CreateCommunity api={api} onClose={() => setCreateOpen(false)} onCreated={id => { setSelectedId(id); setChannelId(""); setNotice("Community created. Open settings to share an invitation.") }} />}
    {joinInput !== null && <JoinCommunity api={api} initialInvite={joinInput} onClose={() => setJoinInput(null)} onRequested={id => { setPendingCommunityId(id); setNotice("Admission request queued. You will join after delivery and processing on the owner’s device.") }} />}
    {settingsOpen && community && <CommunitySettings key={community.id} api={api} community={community} displayName={displayName} initialTab={settingsTab} onClose={() => setSettingsOpen(false)} onCompleted={setNotice} />}
    <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}><DialogContent><DialogHeader><DialogTitle>Leave {community?.name}?</DialogTitle><DialogDescription>You will leave this community on this device immediately. Other members stop sending when they receive your departure, until the owner updates membership. Joining again requires an invitation. Existing members may retain messages you sent.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setLeaveOpen(false)}>Cancel</Button><Button variant="destructive" disabled={busy || !community} onClick={() => { if (community) void run(async () => { await api.leave(community.id); setLeaveOpen(false) }, "You left on this device. Your departure is queued for delivery to members and the owner.") }}>Leave community</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!report} onOpenChange={open => { if (!open) setReport(null) }}><DialogContent><DialogHeader><DialogTitle>Report message</DialogTitle><DialogDescription>Owners and moderators receive your report and public address. Tell them what needs attention.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => { event.preventDefault(); if (report) void run(async () => { await api.reportMessage(report.conversationId, report.id, reason.trim()); setReport(null) }, "Report queued for delivery to owners and moderators.") }}><Label htmlFor="community-report-reason">Reason</Label><Textarea id="community-report-reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={500} required placeholder="Why are you reporting this message?" /><StatusText error={error} /><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setReport(null)}>Cancel</Button><Button type="submit" disabled={busy || !reason.trim()}><Flag className="size-4" />Send report</Button></DialogFooter></form></DialogContent></Dialog>
  </div>
}
