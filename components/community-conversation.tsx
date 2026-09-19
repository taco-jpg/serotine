"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, AtSign, BarChart3, Bell, Check, CheckCheck, ChevronDown, ChevronUp, Copy, ExternalLink, Flag, Hash, Info, Loader2, Megaphone, MoreHorizontal, Pencil, Pin, PinOff, Plus, Reply, RotateCw, Search, Send, Shield, Sparkles, Trash2, X } from "lucide-react"
import { useMessaging, type CommunityContextValue } from "@/components/messaging-provider"
import { AiSummaryDialog } from "@/components/chat/ai-summary-dialog"
import { AI_SUMMARY_PLUGIN_ID, resolvePluginCommand } from "@/lib/plugins"
import { AttachmentComposer, type AttachmentComposerHandle, type AttachmentComposerState } from "@/components/chat/attachment-composer"
import { AttachmentView } from "@/components/chat/attachment-view"
import { VoiceChannelPanel } from "@/components/calling/voice-channel-panel"
import { EditMessageDialog, PollCard, PollCreator } from "@/components/chat/conversation-controls"
import { RichMessage } from "@/components/chat/rich-message"
import { MessageFormattingPreview, MessageFormattingTools } from "@/components/chat/message-formatting"
import type { FormattedInsertion } from "@/lib/composer-formatting"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useChatDraft } from "@/hooks/use-chat-draft"
import { useMentionDraft } from "@/hooks/use-mention-draft"
import { useLocalNickname } from "@/hooks/use-local-nickname"
import { attachmentFileLimit, sendAttachment, stageAttachment, publishAttachment } from "@/lib/attachments"
import { canJoinCommunityVoiceChannel, canPostToCommunityChannel, communityChannelKey, isCommunityModerator } from "@/lib/community-protocol"
import { findMentionQuery, insertMention, serializeMentionDraft, updateMentionSpans, validMentionSpans, type MentionQuery } from "@/lib/composer-mentions"
import { formatMentionText } from "@/lib/mention-display"
import { shortAddress } from "@/lib/identity"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"
import type { CommunityChannel, CommunityMessage, CommunityRecord } from "@/lib/community-types"
import type { GroupState, NotificationMode } from "@/lib/messaging-types"

const failure = (cause: unknown) => cause instanceof Error ? cause.message : "This action could not be completed. Try again."
const summary = (message: CommunityMessage) => message.hidden ? "Message hidden by a moderator." : message.content || message.poll?.question || message.attachment?.name || "Message"
const detailTabs = [["settings", "Settings"], ["files", "Files"], ["links", "Links"], ["pins", "Pinned"]] as const

type CommunityConversationProps = {
  api: CommunityContextValue; community: CommunityRecord; channel: CommunityChannel
  onReport: (message: CommunityMessage) => void; onHide: (message: CommunityMessage) => void
}

/** Text drafts and read receipts never mount for live voice channels. */
export function CommunityConversation(props: CommunityConversationProps) {
  const { api, community, channel } = props
  if (channel.kind === "voice") {
    const address = api.identity?.publicKey || ""
    const membershipPending = community.members.length !== community.effectiveMembers.length
    const eligible = canJoinCommunityVoiceChannel(community, address, channel.id)
    const restriction = !community.joined || community.deleted || !community.effectiveMembers.includes(address)
      ? "You must be a current community member to join this voice channel."
      : membershipPending ? "Membership is updating. You can join when the owner confirms the change."
      : !eligible ? "Only community owners and moderators can join this voice channel."
      : !api.ready ? "Loading community membership…" : undefined
    return <VoiceChannelPanel community={community} channel={channel} disabled={!api.ready || membershipPending || !community.joined || !eligible} restriction={restriction} />
  }
  return <CommunityTextConversation {...props} />
}

/** The hub keys this component by identity and channel so pending UI never leaks across channels. */
function CommunityTextConversation({ api, community, channel, onReport, onHide }: CommunityConversationProps) {
  const plugins = useMessaging()
  const myPub = api.identity?.publicKey || ""
  const key = communityChannelKey(community.id, channel.id)
  const nickname = useLocalNickname(myPub)
  const names = useMemo(() => new Map(api.contacts.map(contact => [contact.pub, contact.alias])), [api.contacts])
  const displayName = useCallback((pub: string) => pub === myPub ? nickname || "You" : names.get(pub) || shortAddress(pub), [myPub, nickname, names])
  const displaySummary = (message: CommunityMessage) => formatMentionText(summary(message), message.mentions || [], displayName)
  const membershipPending = community.members.length !== community.effectiveMembers.length
  const usable = api.ready && !membershipPending && community.joined && !community.deleted
  const canPost = usable && canPostToCommunityChannel(community, myPub, channel.id)
  const moderator = isCommunityModerator(community, myPub)
  const messages = useMemo(() => api.model.messages.filter(message => message.conversationId === community.id && message.channelId === channel.id), [api.model.messages, community.id, channel.id])
  const byId = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages])
  const pinned = useMemo(() => messages.filter(message => message.pinned && !message.hidden), [messages])
  const files = useMemo(() => messages.filter(message => message.attachment && !message.hidden), [messages])
  const links = useMemo(() => messages.filter(message => !message.hidden).flatMap(message => [...new Set((message.content.match(/https?:\/\/[^\s<>"`]+/g) || []).map(url => url.replace(/[.,;!?)\]}]+$/, "")))].filter(url => {
    try { const parsed = new URL(url); return parsed.protocol === "https:" || parsed.protocol === "http:" } catch { return false }
  }).map(url => ({ message, url }))).reverse(), [messages])
  // The regular attachment budget accounts for recipient fan-out. These fields
  // are used only to calculate that budget; the community service signs events.
  const attachmentGroup = useMemo<GroupState>(() => ({ id: community.id, name: community.name, admin: community.owner, members: community.effectiveMembers, epoch: community.epoch, updatedAt: community.updatedAt, signature: community.signature }), [community])
  const { content, setContent, clearSubmittedDraft, retryDraftSave, draftReady, draftSaved, draftIssue } = useChatDraft(myPub, key)
  const { mentionSpans, saveMentionDraft } = useMentionDraft(myPub, key, content, draftReady)
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [error, setError] = useState("")
  const [announcement, setAnnouncement] = useState("")
  const [replyTo, setReplyTo] = useState<string>()
  const [editing, setEditing] = useState<CommunityMessage | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CommunityMessage | null>(null)
  const [deleteError, setDeleteError] = useState("")
  const [deleting, setDeleting] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [pollOpen, setPollOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [infoTab, setInfoTab] = useState<typeof detailTabs[number][0]>("settings")
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matchIndex, setMatchIndex] = useState(0)
  const [highlightedId, setHighlightedId] = useState("")
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [unseen, setUnseen] = useState(0)
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [retrying, setRetrying] = useState<string | null>(null)
  const [batchProgress, setBatchProgress] = useState("")
  const [attachmentState, setAttachmentState] = useState<AttachmentComposerState>({ count: 0, unavailable: false })
  const chatRoot = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const attachmentComposer = useRef<AttachmentComposerHandle>(null)
  const messageNodes = useRef(new Map<string, HTMLDivElement>())
  const nearBottom = useRef(true)
  const seenIds = useRef<Set<string> | null>(null)
  const attachmentAccess = useRef("")
  attachmentAccess.current = canPost && api.identity ? `${myPub}:${community.id}:${channel.id}` : ""
  const mounted = useRef(true)
  const sendLock = useRef(false)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const afterMenuClose = useRef<(() => void) | null>(null)
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const deleteMenu = useRef<HTMLButtonElement | null>(null)
  const pendingMentionEdit = useRef<{ before: string; start: number; end: number } | null>(null)
  const sending = busy || retrying !== null
  const summaryAllowed = usable && !!api.identity && community.effectiveMembers.includes(myPub)
    && plugins.getPluginAvailability(AI_SUMMARY_PLUGIN_ID, community.id).available
  const summaryAccess = useRef(false)
  summaryAccess.current = summaryAllowed
  const summaryMessages = useMemo(() => messages.filter(message => !message.hidden), [messages])
  const mentionMembers = community.effectiveMembers.filter(pub => pub !== myPub)
  const mentions = [...new Set(validMentionSpans(content, mentionSpans).map(span => span.publicKey))].filter(pub => mentionMembers.includes(pub))
  const mentionCandidates = mentionMembers.filter(pub => !mentions.includes(pub) && (!mentionQuery?.query || displayName(pub).toLocaleLowerCase().includes(mentionQuery.query.toLocaleLowerCase()) || pub.includes(mentionQuery.query.toLowerCase())))
  const selectedMentionIndex = Math.min(mentionIndex, Math.max(0, mentionCandidates.length - 1))
  const searchTerm = query.trim().toLocaleLowerCase()
  const matches = useMemo(() => searchTerm ? messages.filter(message => !message.hidden && [message.content, message.attachment?.name, message.poll?.question, ...(message.poll?.options || [])].filter(Boolean).join(" ").toLocaleLowerCase().includes(searchTerm)).map(message => message.id) : [], [messages, searchTerm])
  const selectedMatch = matches.length ? Math.min(matchIndex, matches.length - 1) : 0
  const activeMatch = matches[selectedMatch]
  const failed = messages.filter(message => message.senderPubKey === myPub && message.delivery === "failed")

  function updateMentionQuery(value: string, start: number, end = start) {
    const next = findMentionQuery(value, start, end)
    const inside = validMentionSpans(value, mentionSpans).some(span => start > span.start && start <= span.end)
    setMentionQuery(next); setMentionIndex(0); setMentionOpen(!!next && !inside)
  }
  function changeMessage(value: string, start: number, end = start) {
    const edit = pendingMentionEdit.current
    pendingMentionEdit.current = null
    const nextSpans = updateMentionSpans(content, value, mentionSpans, edit?.before === content ? edit : undefined)
    setContent(value); saveMentionDraft(value, nextSpans); updateMentionQuery(value, start, end)
  }
  function insertFormatting(result: FormattedInsertion) {
    if (!canPost || sending || !draftReady) return
    pendingMentionEdit.current = null
    setContent(result.content)
    saveMentionDraft(result.content, updateMentionSpans(content, result.content, mentionSpans, result))
    setMentionOpen(false); setMentionQuery(null)
  }
  function chooseMention(pub: string) {
    const node = input.current
    if (!node || !canPost || sending) return
    const range = mentionQuery || { start: node.selectionStart, end: node.selectionEnd }
    const result = insertMention(content, range, pub, displayName(pub))
    if (result.content.length > MAX_MESSAGE_LENGTH) { setError("Shorten the message before adding this mention."); return }
    setContent(result.content); saveMentionDraft(result.content, [...updateMentionSpans(content, result.content, mentionSpans, range), result.span])
    setMentionOpen(false); setMentionQuery(null)
    requestAnimationFrame(() => { node.focus(); node.setSelectionRange(result.caret, result.caret) })
  }
  function removeMention(pub: string) {
    let next = content, spans = mentionSpans
    for (const span of validMentionSpans(content, mentionSpans).filter(item => item.publicKey === pub).sort((a, b) => b.start - a.start)) {
      const changed = next.slice(0, span.start) + next.slice(span.end)
      spans = updateMentionSpans(next, changed, spans, { start: span.start, end: span.end }); next = changed
    }
    setContent(next); saveMentionDraft(next, spans); setMentionOpen(false); input.current?.focus()
  }
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; clearTimeout(highlightTimer.current) }
  }, [])
  useEffect(() => {
    const node = input.current
    if (!node) return
    const beforeInput = (event: Event) => {
      const kind = (event as InputEvent).inputType
      if (!["insertText", "insertFromPaste", "insertFromDrop", "deleteByCut", "deleteContentBackward", "deleteContentForward"].includes(kind)) { pendingMentionEdit.current = null; return }
      let start = node.selectionStart, end = node.selectionEnd
      if (start === end && kind.startsWith("delete")) {
        if (kind === "deleteContentBackward") start -= Array.from(node.value.slice(0, start)).at(-1)?.length || 0
        else if (kind === "deleteContentForward") end += Array.from(node.value.slice(end))[0]?.length || 0
        else { pendingMentionEdit.current = null; return }
      }
      pendingMentionEdit.current = { before: node.value, start, end }
    }
    node.addEventListener("beforeinput", beforeInput)
    return () => node.removeEventListener("beforeinput", beforeInput)
  }, [canPost])
  useEffect(() => { const node = input.current; if (node) { node.style.height = "auto"; node.style.height = Math.min(node.scrollHeight, 176) + "px" } }, [content])
  useEffect(() => {
    if (replyTo && (!byId.has(replyTo) || byId.get(replyTo)?.hidden)) setReplyTo(undefined)
    if (editing && (!byId.has(editing.id) || byId.get(editing.id)?.hidden)) setEditing(null)
    if (deleteTarget && !byId.has(deleteTarget.id)) setDeleteTarget(null)
  }, [byId, replyTo, editing, deleteTarget])
  useEffect(() => { if (!canPost) { setEditing(null); setPollOpen(false); setMentionOpen(false) } }, [canPost])
  const acknowledgeVisible = useCallback(() => {
    if (api.ready && document.visibilityState === "visible" && document.hasFocus() && nearBottom.current && !new URLSearchParams(window.location.hash.slice(1)).has("message")) {
      void api.markRead(community.id, channel.id).catch(cause => { if (mounted.current) setError(failure(cause)) })
    }
  }, [api.ready, api.markRead, community.id, channel.id])
  // Metadata may arrive before its file chunks. Revisit visible messages when
  // accepted events change so a completed file can finally receive a read receipt.
  useEffect(() => { acknowledgeVisible() }, [messages, api.model.acceptedKeys, acknowledgeVisible])
  useEffect(() => {
    window.addEventListener("focus", acknowledgeVisible); document.addEventListener("visibilitychange", acknowledgeVisible)
    return () => { window.removeEventListener("focus", acknowledgeVisible); document.removeEventListener("visibilitychange", acknowledgeVisible) }
  }, [acknowledgeVisible])
  useEffect(() => {
    if (seenIds.current) {
      const added = messages.filter(message => message.senderPubKey !== myPub && !seenIds.current!.has(message.id)).length
      if (added) { if (!nearBottom.current) setUnseen(count => count + added); setAnnouncement(`${added} new message${added === 1 ? "" : "s"} received.`) }
    }
    seenIds.current = new Set(messages.map(message => message.id))
    if (nearBottom.current && !searchTerm && !new URLSearchParams(window.location.hash.slice(1)).has("message") && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
  }, [messages, myPub, searchTerm])
  const jumpToMessage = useCallback((id: string) => {
    const container = viewport.current, node = messageNodes.current.get(id)
    if (!container || !node) return
    nearBottom.current = false; setAwayFromBottom(true)
    container.scrollTop += node.getBoundingClientRect().top - container.getBoundingClientRect().top - (container.clientHeight - node.clientHeight) / 2
    clearTimeout(highlightTimer.current); setHighlightedId(id)
    highlightTimer.current = setTimeout(() => setHighlightedId(""), 4000)
  }, [])
  useEffect(() => { if (activeMatch) jumpToMessage(activeMatch) }, [activeMatch, searchTerm, jumpToMessage])
  useEffect(() => {
    const consumeMessageLink = () => {
      const params = new URLSearchParams(window.location.hash.slice(1)), id = params.get("message")
      if (!id || !byId.has(id) || (params.has("id") && params.get("id") !== community.id) || (params.has("channel") && params.get("channel") !== channel.id)) return
      jumpToMessage(id); params.delete("message")
      const remaining = params.toString()
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ""}`)
    }
    consumeMessageLink(); window.addEventListener("hashchange", consumeMessageLink)
    return () => window.removeEventListener("hashchange", consumeMessageLink)
  }, [byId, community.id, channel.id, jumpToMessage])
  useEffect(() => { if (searchOpen) searchInput.current?.focus() }, [searchOpen])
  function jumpToLatest() {
    setQuery(""); nearBottom.current = true; setAwayFromBottom(false); setUnseen(0)
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight
    acknowledgeVisible()
  }
  const act = async (action: () => Promise<unknown>, success?: string) => {
    if (actionBusy) return
    setActionBusy(true); setError("")
    try { await action(); if (mounted.current && success) setAnnouncement(success) }
    catch (cause) { if (mounted.current) setError(failure(cause)) }
    finally { if (mounted.current) setActionBusy(false) }
  }
  const submit = async () => {
    // Local commands never become a channel message or attachment caption.
    if (resolvePluginCommand(content) === AI_SUMMARY_PLUGIN_ID) {
      if (summaryAllowed && !sendLock.current) { setError(""); setSummaryOpen(true) }
      else setError("Enable AI Summary in Inbox settings → Plugins to summarize this channel.")
      return
    }
    const attachments = attachmentComposer.current, pending = attachments?.getState()
    if ((!content.trim() && !pending?.count) || pending?.unavailable || sendLock.current || !canPost || !draftReady) return
    sendLock.current = true; setBusy(true); setError(""); jumpToLatest()
    try {
      const outgoing = serializeMentionDraft(content, mentionSpans)
      if (outgoing.content.trim().length > MAX_MESSAGE_LENGTH) throw new Error("This message is too long after including mention addresses. Shorten it and try again.")
      const caption = { content: outgoing.content.trim(), mentions: outgoing.mentions.filter(pub => mentionMembers.includes(pub)) }
      const clearSentText = () => { clearSubmittedDraft(); if (mounted.current) { setReplyTo(undefined); setMentionOpen(false) } }
      if (attachments && pending?.count) await attachments.sendAll(caption, clearSentText)
      else { await api.sendMessage(community.id, channel.id, outgoing.content, replyTo, caption.mentions); clearSentText() }
    } catch (cause) { if (mounted.current) setError(failure(cause)) }
    finally { sendLock.current = false; if (mounted.current) { setBusy(false); input.current?.focus() } }
  }
  const retryMessages = async (snapshot: CommunityMessage[]) => {
    if (sendLock.current || !api.ready) return
    sendLock.current = true; setError("")
    try {
      for (let i = 0; i < snapshot.length && mounted.current; i++) { setRetrying(snapshot[i].id); if (snapshot.length > 1) setBatchProgress(`Retrying ${i + 1} of ${snapshot.length}`); await api.retry(snapshot[i].id) }
    } catch (cause) { if (mounted.current) setError(failure(cause)) }
    finally { sendLock.current = false; if (mounted.current) { setRetrying(null); setBatchProgress("") } }
  }
  const attachmentView = (message: CommunityMessage) => !message.hidden && message.attachment && <AttachmentView identity={api.identity} metadata={message.attachment} chunks={api.getAttachmentChunks(community.id, channel.id, message.id)} />
  const openMessageFromInfo = (id: string) => { setInfoOpen(false); requestAnimationFrame(() => jumpToMessage(id)) }
  const moveMatch = (direction: number) => { if (matches.length) setMatchIndex((selectedMatch + direction + matches.length) % matches.length) }
  const messageInput = <div className="flex min-w-0 items-end gap-1"><Button type="button" variant="ghost" size="icon" className="size-9 shrink-0" aria-label="More message tools" title="Files, GIFs and message tools" aria-expanded={toolsOpen} aria-controls="community-message-tools" onClick={() => setToolsOpen(value => !value)}>{toolsOpen ? <X className="size-4" /> : <Plus className="size-4" />}</Button><Textarea ref={input} aria-label={`Message ${channel.name}`} placeholder={`Message #${channel.name}`} value={content} maxLength={MAX_MESSAGE_LENGTH} disabled={!canPost || !draftReady} readOnly={busy} rows={1} className="max-h-36 min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-2 text-base shadow-none focus-visible:ring-0 md:text-sm" onChange={event => changeMessage(event.target.value, event.target.selectionStart, event.target.selectionEnd)} onSelect={event => { const node = event.currentTarget; if (document.activeElement === node) updateMentionQuery(node.value, node.selectionStart, node.selectionEnd) }} onBlur={() => setMentionOpen(false)} aria-autocomplete="list" aria-controls={mentionOpen ? "community-mention-options" : undefined} aria-activedescendant={mentionOpen && mentionCandidates.length ? `community-mention-${selectedMentionIndex}` : undefined} onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (mentionOpen) {
      if (event.key === "Escape") { event.preventDefault(); setMentionOpen(false); return }
      if (mentionCandidates.length && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setMentionIndex((selectedMentionIndex + (event.key === "ArrowDown" ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length); return }
      if (mentionCandidates.length && ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab")) { event.preventDefault(); chooseMention(mentionCandidates[selectedMentionIndex]); return }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit() }
  }} /><Button type="submit" size="icon" className="size-9 shrink-0" aria-label="Send message" disabled={!canPost || !draftReady || (!content.trim() && !attachmentState.count) || sending || attachmentState.unavailable}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button></div>

  return <div ref={chatRoot} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <header className="flex min-h-12 min-w-0 shrink-0 items-center gap-2 border-b border-border px-3 py-1 sm:px-5">{channel.posting === "moderators" ? <Megaphone className="size-4 shrink-0 text-primary" /> : <Hash className="size-4 shrink-0 text-muted-foreground" />}<h2 className="min-w-0 flex-1 truncate text-sm font-medium">{channel.name}</h2><span className="hidden whitespace-nowrap text-[11px] tabular-nums text-muted-foreground sm:inline">{community.effectiveMembers.length}/20 MEMBERS</span>{summaryAllowed && <Button size="icon-sm" variant="ghost" aria-label="Summarize channel" title="Summarize channel" disabled={sending} onClick={() => { setError(""); setSummaryOpen(true) }}><Sparkles className="size-4" /></Button>}<Button size="icon-sm" variant="ghost" aria-label="Search channel" aria-expanded={searchOpen} onClick={() => { setSearchOpen(value => !value); setQuery(""); setMatchIndex(0) }}><Search className="size-4" /></Button><Button size="icon-sm" variant="ghost" aria-label="Channel details, files and settings" onClick={() => { setInfoTab("settings"); setInfoOpen(true) }}><Info className="size-4" /></Button></header>
    {searchOpen && <div role="search" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-2"><Input ref={searchInput} aria-label="Search messages" placeholder="Search this channel…" className="min-w-24 flex-1" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) } else if (event.key === "Escape") { setSearchOpen(false); setQuery(""); input.current?.focus() } }} /><span role="status" className="text-xs text-muted-foreground">{searchTerm ? matches.length ? `${selectedMatch + 1} of ${matches.length}` : "No matches" : ""}</span><Button size="icon-sm" variant="ghost" aria-label="Previous match" disabled={!matches.length} onClick={() => moveMatch(-1)}><ChevronUp className="size-4" /></Button><Button size="icon-sm" variant="ghost" aria-label="Next match" disabled={!matches.length} onClick={() => moveMatch(1)}><ChevronDown className="size-4" /></Button><Button size="icon-sm" variant="ghost" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery("") }}><X className="size-4" /></Button></div>}
    {error && <div className="flex shrink-0 items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2"><p role="alert" className="min-w-0 flex-1 break-words text-sm text-destructive">{error}</p><Button size="icon-sm" variant="ghost" aria-label="Dismiss channel error" onClick={() => setError("")}><X className="size-4" /></Button></div>}
    {pinned.length > 0 && <button type="button" className="flex shrink-0 items-center gap-2 border-b border-border bg-card/40 px-4 py-1.5 text-left text-xs text-primary" onClick={() => { setInfoTab("pins"); setInfoOpen(true) }}><Pin className="size-3.5 shrink-0" /><span className="shrink-0">{pinned.length} pinned</span><span className="truncate text-muted-foreground">{displaySummary(pinned.at(-1)!)}</span></button>}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div ref={viewport} role="region" aria-label="Channel messages" tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 py-3 sm:px-5" onScroll={event => { const node = event.currentTarget, wasNear = nearBottom.current; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; setAwayFromBottom(!nearBottom.current); if (nearBottom.current) { setUnseen(0); if (!wasNear) acknowledgeVisible() } }}>
      <p className="mb-3 border-b border-border pb-2 text-[11px] leading-5 text-muted-foreground">Messages are visible to community members. Your history starts when you join.</p>
      {!messages.length && <div className="space-y-3 py-8"><Hash className="size-7 text-primary" /><h3 className="text-2xl tracking-tight">No messages in #{channel.name} yet.</h3>{canPost && <p className="text-sm text-muted-foreground">Send messages, files, voice notes and polls below.</p>}</div>}
      {messages.map((message, index) => {
        const mine = message.senderPubKey === myPub, previous = messages[index - 1], next = messages[index + 1], date = new Date(message.timestamp)
        const inRun = (a?: CommunityMessage, b?: CommunityMessage) => !!a && !!b && !a.hidden && !b.hidden && a.senderPubKey === b.senderPubKey && !b.replyTo && a.delivery !== "failed" && b.delivery !== "failed" && b.timestamp >= a.timestamp && b.timestamp - a.timestamp < 300_000 && new Date(a.timestamp).toDateString() === new Date(b.timestamp).toDateString()
        const continuation = inRun(previous, message), showMetadata = !inRun(message, next) || message.editedAt || message.pinned || message.delivery === "pending" || message.delivery !== next?.delivery || message.readBy.length !== next?.readBy.length || message.deliveredTo.length !== next?.deliveredTo.length
        const quoted = message.replyTo ? byId.get(message.replyTo) : undefined
        const role = community.owner === message.senderPubKey ? "primary owner" : community.coOwners?.includes(message.senderPubKey) ? "co-owner" : community.moderators.includes(message.senderPubKey) ? "moderator" : ""
        return <div key={message.id} id={`community-message-${message.id}`} ref={node => { if (node) messageNodes.current.set(message.id, node); else messageNodes.current.delete(message.id) }} data-message-run={continuation ? "continuation" : "start"} className={`${continuation ? "mt-0.5" : "mt-2"} ${activeMatch === message.id || highlightedId === message.id ? "rounded-sm ring-2 ring-primary/60 ring-offset-2 ring-offset-background" : ""}`}>
          {(!previous || new Date(previous.timestamp).toDateString() !== date.toDateString()) && <p className="mb-3 flex items-center gap-3 pt-2 text-[11px] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">{date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</p>}
          <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
            {!continuation && <p className={`mb-0.5 flex max-w-full items-baseline gap-2 text-xs ${mine ? "mr-1" : "ml-1"}`}><span className="truncate font-medium text-primary">{displayName(message.senderPubKey)}</span>{role && <span className="shrink-0 text-[10px] text-muted-foreground">{role}</span>}</p>}
            <div className={`flex w-full min-w-0 items-start gap-1 ${mine ? "flex-row-reverse" : ""}`}>
              <div className={`min-w-0 max-w-[calc(100%-2rem)] break-words rounded-sm border px-2.5 py-1 text-[15px] leading-[1.4] [overflow-wrap:anywhere] sm:max-w-[min(85%,75ch)] ${mine ? "border-primary/15 bg-message-outgoing text-message-outgoing-foreground" : "border-border bg-message-incoming text-message-incoming-foreground"}`}>
                {message.hidden ? <p className="text-sm italic text-muted-foreground">Message hidden by a moderator.</p> : <>
                  {message.replyTo && <button type="button" disabled={!quoted || quoted.hidden} aria-label={quoted && !quoted.hidden ? "Jump to replied message" : "Original message is unavailable"} className="mb-1.5 block w-full rounded-r border-l-2 border-current/40 bg-current/5 px-2 py-1 text-left text-xs" onClick={() => quoted && jumpToMessage(quoted.id)}><span className="block font-medium">{quoted ? displayName(quoted.senderPubKey) : "Reply"}</span><span className="line-clamp-2 opacity-70">{quoted ? displaySummary(quoted) : "Original message is not saved on this device."}</span></button>}
                  {!!message.content && !message.poll && <RichMessage text={message.content} highlight={query.trim()} mentions={message.mentions} displayName={displayName} />}
                  {attachmentView(message)}
                  {message.poll && <PollCard question={message.poll.question} options={message.poll.options.map((text, i) => ({ id: String(i), text }))} votes={Object.fromEntries(Object.entries(message.poll.votes).map(([pub, option]) => [pub, String(option)]))} myPub={myPub} disabled={!usable} onVote={option => api.vote(community.id, channel.id, message.id, Number(option))} />}
                  {!!message.mentions?.length && <p className="mt-1 text-xs opacity-65">Mentioned: {message.mentions.map(displayName).join(", ")}</p>}
                </>}
              </div>
              <DropdownMenu><DropdownMenuTrigger asChild><button type="button" aria-label="Message actions" className="flex size-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted data-[state=open]:bg-muted"><MoreHorizontal className="size-4" /></button></DropdownMenuTrigger><DropdownMenuContent align={mine ? "end" : "start"} onCloseAutoFocus={event => { const action = afterMenuClose.current; if (action) { event.preventDefault(); afterMenuClose.current = null; action() } }}>
                <div className="px-2 py-1.5 text-xs text-muted-foreground"><time dateTime={date.toISOString()}>{date.toLocaleString()}</time></div>
                {!message.hidden && <><DropdownMenuItem onSelect={() => void act(() => navigator.clipboard.writeText(summary(message)), "Message copied.")}><Copy />Copy</DropdownMenuItem><DropdownMenuItem disabled={!canPost} onSelect={() => { afterMenuClose.current = () => { setReplyTo(message.id); input.current?.focus() } }}><Reply />Reply</DropdownMenuItem>{mine && !!message.content && !message.attachment && !message.poll && <DropdownMenuItem disabled={!canPost || actionBusy} onSelect={() => { afterMenuClose.current = () => setEditing(message) }}><Pencil />Edit</DropdownMenuItem>}<DropdownMenuItem disabled={!canPost || actionBusy} onSelect={() => void act(() => api.pinMessage(community.id, channel.id, message.id, !message.pinned), message.pinned ? "Message unpinned." : "Message pinned.")}>{message.pinned ? <PinOff /> : <Pin />}{message.pinned ? "Unpin" : "Pin"}</DropdownMenuItem>{mine && message.delivery === "failed" && <DropdownMenuItem disabled={sending} onSelect={() => void retryMessages([message])}><RotateCw />Retry message</DropdownMenuItem>}<DropdownMenuSeparator /><DropdownMenuItem onSelect={() => { afterMenuClose.current = () => onReport(message) }}><Flag />Report message</DropdownMenuItem>{moderator && <DropdownMenuItem disabled={actionBusy} onSelect={() => onHide(message)}><Shield />Hide message</DropdownMenuItem>}</>}
                <DropdownMenuSeparator /><DropdownMenuItem variant="destructive" disabled={sending || deleting} onSelect={() => { afterMenuClose.current = () => { deleteMenu.current = messageNodes.current.get(message.id)?.querySelector<HTMLButtonElement>('button[aria-label="Message actions"]') || null; setDeleteError(""); setDeleteTarget(message) } }}><Trash2 />Delete for me…</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu>
            </div>
            <div className={showMetadata ? "mt-0.5 flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-4 tabular-nums text-muted-foreground" : "sr-only"}><time title={date.toLocaleString()} dateTime={date.toISOString()}>{date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time>{message.editedAt && !message.hidden && <span title={`Edited ${new Date(message.editedAt).toLocaleString()}`}>edited</span>}{message.pinned && !message.hidden && <Pin className="size-3 text-primary" aria-label="Pinned message" />}{mine && (message.delivery === "failed" ? <button type="button" disabled={sending} onClick={() => void retryMessages([message])} className="flex min-h-7 items-center gap-1 text-destructive"><RotateCw className={`size-3 ${retrying === message.id ? "animate-spin" : ""}`} />{retrying === message.id ? "Retrying" : "Failed · Retry"}</button> : <span className="flex items-center gap-1">{message.delivery === "pending" ? <Loader2 className="size-3 animate-spin" /> : ["read", "delivered"].includes(message.delivery) ? <CheckCheck className={`size-3 ${message.delivery === "read" ? "text-primary" : ""}`} /> : <Check className="size-3" />}{({ pending: "Queued", sent: "Sent", delivered: "Delivered", read: "Read", received: "Received", failed: "Failed" })[message.delivery]}{message.delivery === "read" ? ` · ${message.readBy.length}` : message.delivery === "delivered" ? ` · ${message.deliveredTo.length}` : ""}</span>)}</div>
            {message.error && <p className="max-w-full break-words text-xs text-destructive">{message.error}</p>}
          </div>
        </div>
      })}
    </div>
    {awayFromBottom && <div className="flex shrink-0 justify-center border-t border-border py-1"><Button size="sm" variant="secondary" onClick={jumpToLatest}><ArrowDown className="size-3.5" />{unseen ? `${unseen} new message${unseen === 1 ? "" : "s"}` : "Jump to latest"}</Button></div>}
    {failed.length > 1 && <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-3 py-1 text-xs"><span className="text-destructive">{batchProgress || `${failed.length} messages need another delivery attempt`}</span><Button size="sm" variant="ghost" disabled={sending} onClick={() => void retryMessages([...failed])}>Retry all</Button></div>}
    {canPost ? <footer className="shrink-0 border-t border-border bg-background px-2 py-2 sm:px-4">
      {replyTo && byId.get(replyTo) && <div className="mb-1 flex items-center gap-2 border-l-2 border-primary bg-primary/5 px-2 py-1 text-xs"><Reply className="size-3 shrink-0" /><div className="min-w-0 flex-1"><span className="text-primary">Replying to {displayName(byId.get(replyTo)!.senderPubKey)}</span><p className="truncate text-muted-foreground">{displaySummary(byId.get(replyTo)!)}</p></div><Button size="icon-sm" variant="ghost" aria-label="Cancel reply" onClick={() => setReplyTo(undefined)}><X className="size-3" /></Button></div>}
      <form onSubmit={event => { event.preventDefault(); void submit() }}><div className="rounded-sm border border-border bg-card p-1 focus-within:border-ring"><AttachmentComposer scopeKey={`${myPub}:${community.id}:${channel.id}`} owner={myPub} captureRef={chatRoot} pasteRef={input} composerRef={attachmentComposer} onStateChange={setAttachmentState} maxFileBytes={attachmentFileLimit(attachmentGroup)} toolbarId="community-message-tools" toolbarVisible={toolsOpen} disabled={!canPost || !draftReady} extraActions={<><MessageFormattingTools content={content} inputRef={input} disabled={!canPost || sending || !draftReady} onInsert={insertFormatting} /><Button type="button" size="sm" variant="ghost" disabled={!canPost || sending} onClick={() => setPollOpen(true)}><BarChart3 className="size-4" />Poll</Button><Button type="button" size="sm" variant="ghost" disabled={!canPost || sending} aria-expanded={mentionOpen} onClick={() => { setMentionQuery(findMentionQuery(content, input.current?.selectionStart ?? content.length, input.current?.selectionEnd ?? content.length)); setMentionIndex(0); setMentionOpen(!mentionOpen); if (!mentionOpen) requestAnimationFrame(() => document.getElementById("community-mention-0")?.focus()); else input.current?.focus() }}><AtSign className="size-4" />Mention</Button></>} onSelectGif={url => {
        if (!canPost || sending || !draftReady) return
        const next = content.trim() ? `${content}\n${url}` : url
        if (next.length > MAX_MESSAGE_LENGTH) { setError("Send or shorten your draft before adding this GIF."); return }
        changeMessage(next, next.length); requestAnimationFrame(() => input.current?.focus())
      }} onStage={async (file, kind, onProgress, signal) => {
        if (!api.identity || !canPost) throw new Error("This channel is not available for attachments.")
        return stageAttachment((_id, eventKind, payload) => api.sendEvent(community.id, channel.id, eventKind, payload), community.id, file, api.identity, kind, onProgress, signal, attachmentGroup)
      }} onPublish={async (prepared, caption) => {
        if (!api.identity || !canPost) throw new Error("This channel is not available for attachments.")
        const scope = `${myPub}:${community.id}:${channel.id}`
        const id = await publishAttachment((_id, eventKind, payload) => {
          if (!mounted.current || attachmentAccess.current !== scope) throw new Error("This channel is no longer available for attachments.")
          return api.sendEvent(community.id, channel.id, eventKind, payload)
        }, community.id, prepared, caption ? replyTo : undefined, caption)
        if (mounted.current) jumpToLatest()
        return id
      }} onDiscard={prepared => prepared.discard()} onSend={async (file, kind, onProgress, caption) => {
        const id = await sendAttachment((_id, eventKind, payload) => api.sendEvent(community.id, channel.id, eventKind, payload), community.id, file, kind, onProgress, caption ? replyTo : undefined, attachmentGroup, caption)
        if (mounted.current) jumpToLatest()
        return id
      }}>{messageInput}</AttachmentComposer></div></form>
      <MessageFormattingPreview content={content} />
      {mentionOpen && <div id="community-mention-options" role="listbox" aria-label="Mention suggestions" className="mt-1 max-h-40 overflow-y-auto rounded-sm border border-border bg-card p-1" onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); setMentionOpen(false); input.current?.focus() }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && mentionCandidates.length) { event.preventDefault(); const current = mentionCandidates.findIndex((_, i) => document.activeElement?.id === `community-mention-${i}`), next = event.key === "Home" ? 0 : event.key === "End" ? mentionCandidates.length - 1 : (current + (event.key === "ArrowDown" ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length; setMentionIndex(next); document.getElementById(`community-mention-${next}`)?.focus() }
      }}>{mentionCandidates.map((pub, i) => <button key={pub} id={`community-mention-${i}`} type="button" role="option" aria-selected={i === selectedMentionIndex} onPointerDown={event => event.preventDefault()} onClick={() => chooseMention(pub)} className={`flex min-w-0 w-full items-center justify-between gap-2 rounded-sm px-3 py-2 text-left text-sm ${i === selectedMentionIndex ? "bg-primary/15 text-primary" : "hover:bg-muted"}`}><span className="truncate">@{displayName(pub)}</span><span className="shrink-0 font-mono text-xs text-muted-foreground">{shortAddress(pub)}</span></button>)}{!mentionCandidates.length && <p className="px-3 py-2 text-xs text-muted-foreground">No matching members.</p>}</div>}
      {mentions.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{mentions.map(pub => <button key={pub} type="button" disabled={sending} aria-label={`Remove mention of ${displayName(pub)}`} className="inline-flex items-center gap-1 rounded-sm bg-primary/10 px-2 py-1 text-xs text-primary" onClick={() => removeMention(pub)}>@{displayName(pub)}<X className="size-3" /></button>)}</div>}
      <div className={toolsOpen || !draftSaved ? "mt-1 flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground" : "sr-only"}><span>Enter to send · Shift + Enter for a new line · Math and Code in message tools</span><span className={!draftSaved ? "text-destructive" : ""}>{!draftSaved ? draftIssue === "read" ? "Saved draft could not be loaded" : draftIssue === "clear" ? "Sent draft cleanup is pending" : "Draft is only in this tab · Do not close it" : content ? "Draft saved on this browser" : "History saved on this browser"}</span></div>{!draftSaved && <Button type="button" size="sm" variant="ghost" onClick={retryDraftSave}>{draftIssue === "read" ? "Try loading draft again" : draftIssue === "clear" ? "Retry draft cleanup" : "Try saving draft again"}</Button>}
    </footer> : <p className="shrink-0 border-t border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">{membershipPending ? "A member left. Messaging resumes when the owner opens Serotine and updates membership." : "Only owners and moderators can post in this announcement channel."}</p>}
    {summaryOpen && summaryAllowed && api.identity && <AiSummaryDialog key={`summary:${myPub}:${key}`} identity={api.identity} conversationId={community.id} messages={summaryMessages}
      isAllowed={() => mounted.current && summaryAccess.current && plugins.getPluginAvailability(AI_SUMMARY_PLUGIN_ID, community.id).available}
      onClose={() => setSummaryOpen(false)} canSend={canPost}
      onSend={async text => {
        if (!mounted.current || !summaryAccess.current || !canPost || sendLock.current || !plugins.getPluginAvailability(AI_SUMMARY_PLUGIN_ID, community.id).available) throw new Error("This channel is no longer available for sharing the summary.")
        sendLock.current = true
        try { await api.sendMessage(community.id, channel.id, text); if (mounted.current) jumpToLatest() }
        finally { sendLock.current = false }
      }} />}
    <PollCreator open={pollOpen && canPost} onOpenChange={setPollOpen} onCreate={async (question, options) => { if (!canPost) throw new Error("You cannot post in this channel."); await api.createPoll(community.id, channel.id, question, options); if (mounted.current) jumpToLatest() }} />
    <EditMessageDialog message={canPost ? editing : null} onClose={() => setEditing(null)} onSave={(id, value) => api.editMessage(community.id, channel.id, id, value)} />
    <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null) }}><DialogContent onOpenAutoFocus={event => { event.preventDefault(); cancelDelete.current?.focus() }} onCloseAutoFocus={event => { event.preventDefault(); if (deleteMenu.current?.isConnected) deleteMenu.current.focus(); else if (input.current && !input.current.disabled) input.current.focus(); else viewport.current?.focus() }}><DialogHeader><DialogTitle>Delete this message for you?</DialogTitle><DialogDescription>This removes the message and its attachment from saved history on this device. Other participants and linked devices keep their copies. This cannot be undone here.</DialogDescription></DialogHeader>{deleteTarget && <p className="line-clamp-3 break-words rounded-sm bg-muted p-3 text-sm text-muted-foreground">{displaySummary(deleteTarget)}</p>}{deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}<DialogFooter><Button ref={cancelDelete} variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={deleting} onClick={async () => {
      if (!deleteTarget || deleting) return
      setDeleting(true); setDeleteError("")
      try { await api.deleteMessage(community.id, channel.id, deleteTarget.id); if (mounted.current) { setDeleteTarget(null); setAnnouncement("Message deleted for you on this device.") } }
      catch (cause) { if (mounted.current) setDeleteError(failure(cause)) }
      finally { if (mounted.current) setDeleting(false) }
    }}>{deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}Delete for me</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={infoOpen} onOpenChange={setInfoOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>#{channel.name}</DialogTitle><DialogDescription>Channel settings and everything shared here.</DialogDescription></DialogHeader><div role="tablist" aria-label="Channel details" className="grid grid-cols-4 gap-1 border-b border-border pb-2">{detailTabs.map(([tab, label], i) => <button type="button" key={tab} id={`channel-details-${tab}`} role="tab" aria-selected={infoTab === tab} tabIndex={infoTab === tab ? 0 : -1} aria-controls={`channel-panel-${tab}`} className={`rounded-sm px-2 py-2 text-sm ${infoTab === tab ? "bg-primary/10 text-primary" : "text-muted-foreground"}`} onClick={() => setInfoTab(tab)} onKeyDown={event => { const next = event.key === "ArrowRight" ? detailTabs[(i + 1) % 4][0] : event.key === "ArrowLeft" ? detailTabs[(i + 3) % 4][0] : event.key === "Home" ? "settings" : event.key === "End" ? "pins" : null; if (next) { event.preventDefault(); setInfoTab(next); document.getElementById(`channel-details-${next}`)?.focus() } }}>{label}</button>)}</div><div role="tabpanel" id={`channel-panel-${infoTab}`} aria-labelledby={`channel-details-${infoTab}`} className="min-h-32 space-y-3">
      {infoTab === "settings" && <div className="space-y-4"><div className="space-y-2"><Label htmlFor="channel-notifications" className="flex items-center gap-2"><Bell className="size-4" />Channel notifications</Label><select id="channel-notifications" value={api.preferences.notifications[key] ?? community.notificationMode} disabled={actionBusy} onChange={event => void act(() => api.setNotificationMode(key, event.target.value as NotificationMode))} className="h-10 w-full rounded-sm border border-border bg-card px-3 text-sm"><option value="all">All messages</option><option value="mentions">Mentions only</option><option value="muted">Muted</option></select><p className="text-xs text-muted-foreground">Browser notifications work while Serotine is open. Enable them in the inbox settings.</p></div><div className="space-y-2"><Label htmlFor="community-all-notifications">Community notifications</Label><select id="community-all-notifications" value={community.notificationMode} disabled={actionBusy} onChange={event => void act(() => api.setNotificationMode(community.id, event.target.value as NotificationMode))} className="h-10 w-full rounded-sm border border-border bg-card px-3 text-sm"><option value="all">All messages</option><option value="mentions">Mentions only</option><option value="muted">Muted</option></select></div><p className="text-xs leading-relaxed text-muted-foreground">New members see messages sent after they join. Channel history stays on this browser.</p></div>}
      {infoTab === "files" && (files.length ? [...files].reverse().map(message => <div key={message.id} className="space-y-2 rounded-sm border border-border p-3">{attachmentView(message)}<button type="button" className="text-xs text-primary hover:underline" onClick={() => openMessageFromInfo(message.id)}>View message · {new Date(message.timestamp).toLocaleDateString()}</button></div>) : <p className="py-6 text-sm text-muted-foreground">Files and voice messages will appear here.</p>)}
      {infoTab === "links" && (links.length ? links.map(({ message, url }, i) => <div key={`${message.id}:${i}`} className="space-y-2 rounded-sm border border-border p-3"><a href={url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 break-all text-sm text-primary underline"><ExternalLink className="mt-0.5 size-4 shrink-0" />{url}</a><button type="button" className="text-xs text-muted-foreground" onClick={() => openMessageFromInfo(message.id)}>View message · {displayName(message.senderPubKey)}</button></div>) : <p className="py-6 text-sm text-muted-foreground">Links from this channel will appear here.</p>)}
      {infoTab === "pins" && (pinned.length ? [...pinned].reverse().map(message => <div key={message.id} className="rounded-sm border border-border p-3"><button type="button" className="w-full text-left" onClick={() => openMessageFromInfo(message.id)}><span className="text-xs text-primary">{displayName(message.senderPubKey)}</span><p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-sm">{displaySummary(message)}</p><span className="mt-2 block text-xs text-muted-foreground">Jump to message</span></button><Button size="sm" variant="ghost" disabled={!canPost || actionBusy} onClick={() => void act(() => api.pinMessage(community.id, channel.id, message.id, false))}><PinOff className="size-3" />Unpin</Button></div>) : <p className="py-6 text-sm text-muted-foreground">Pin a message to find it quickly here.</p>)}
    </div>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</DialogContent></Dialog>
  </div>
}
