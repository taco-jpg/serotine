"use client"

import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ListChecks, ArrowLeft, Check, CheckCheck, Loader2, Lock, Send, Shield, RotateCw, ArrowDown, Search, X, ChevronUp, ChevronDown, Copy, Reply, Pencil, Pin, PinOff, Info, Users, BarChart3, AtSign, Bell, Ban, ExternalLink, MessageSquare, MoreHorizontal, Trash2, Timer, KeyRound, Plus, Puzzle, Sparkles } from "lucide-react"
import { useMessaging } from "@/components/messaging-provider"
import { ConversationActions } from "@/components/conversation-actions"
import { IdentityIcon } from "@/components/ui/identity-icon"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { QrCodeCard } from "@/components/qr-code"
import { shortAddress } from "@/lib/identity"
import { parseContactCode } from "@/lib/contact-code"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"
import { useChatDraft } from "@/hooks/use-chat-draft"
import { useLocalNickname } from "@/hooks/use-local-nickname"
import { formatMentionText } from "@/lib/mention-display"
import { useMentionDraft } from "@/hooks/use-mention-draft"
import { literalSearch } from "@/components/message-text"
import { type MessageRecord, type NotificationMode } from "@/lib/messaging-types"
import { AttachmentComposer, type AttachmentComposerHandle, type AttachmentComposerState } from "@/components/chat/attachment-composer"
import { AttachmentView } from "@/components/chat/attachment-view"
import { RichMessage } from "@/components/chat/rich-message"
import { MessageFormattingPreview, MessageFormattingTools } from "@/components/chat/message-formatting"
import type { FormattedInsertion } from "@/lib/composer-formatting"
import { attachmentFileLimit, sendAttachment, stageAttachment, publishAttachment } from "@/lib/attachments"
import { findMentionQuery, insertMention, serializeMentionDraft, updateMentionSpans, validMentionSpans, type MentionQuery } from "@/lib/composer-mentions"
import { EditMessageDialog, GroupSettings, PollCard, PollCreator } from "@/components/chat/conversation-controls"
import { PrivateChatControls, ShareSecretDialog, privateDurationLabel } from "@/components/chat/private-chat-controls"
import { ProfileSharingFields } from "@/components/profile/profile-settings"
import type { ProfileField } from "@/lib/profiles"
import { SecretMessage } from "@/components/chat/secret-message"
import { PluginSettings } from "@/components/chat/plugin-settings"
import { DirectDelivery } from "@/components/chat/direct-delivery"
import { AiSummaryDialog } from "@/components/chat/ai-summary-dialog"
import { canShareMessage, MAX_SHARED_MESSAGES } from "@/lib/shared-messages"
import { SharedMessageBundle } from "@/components/chat/shared-message-bundle"
import { MessageSelectionToolbar, toggleSharedSelection } from "@/components/chat/share-messages-dialog"
import { AI_SUMMARY_PLUGIN_ID, PRIVATE_CHAT_PLUGIN_ID, resolvePluginCommand } from "@/lib/plugins"
import { CallActions } from "@/components/calling/call-actions"
import { RoomCallActions } from "@/components/calling/room-call-actions"
import { CallHistory } from "@/components/calling/call-history"

const messageSummary = (message: MessageRecord) => message.private ? message.secret ? "Private access key" : "Private message" : message.content || message.poll?.question || message.attachment?.name || "Message"
const searchableText = (message: MessageRecord) => message.private ? "" : [message.content, message.attachment?.name, message.poll?.question, ...(message.poll?.options || [])].filter(Boolean).join(" ")
const errorText = (error: unknown) => error instanceof Error ? error.message : "That action could not be completed. Try again."
function extractLinks(content: string) {
  return [...new Set((content.match(/https?:\/\/[^\s<>"`]+/g) || []).map(value => value.replace(/[.,;!?)\]}]+$/, "")))].filter(value => {
    try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" } catch { return false }
  })
}

export default function ChatWindow({ params }: { params: { pubkey: string } }) {
  const messaging = useMessaging()
  const { identity, ready, error, status, contacts, preferences, markRead } = messaging
  const myPub = identity?.publicKey || ""
  const nickname = useLocalNickname(myPub)
  const conversationId = params.pubkey
  const conversation = messaging.conversations.find(item => item.id === conversationId)
  const deliveryError = conversation?.sendError
  const group = messaging.groups.find(item => item.id === conversationId)
  const isSelf = conversationId === myPub
  const isGroup = conversationId.startsWith("group:")
  const canUsePrivate = !isGroup && !isSelf
  const privateTtlSeconds = messaging.getPrivateMode(conversationId)
  const privateMode = canUsePrivate && privateTtlSeconds > 0
  const directOnly = messaging.getDeliveryMode(conversationId) === "direct-only"
  const directUnavailable = directOnly && messaging.getDirectStatus(conversationId).state !== "connected"
  const privatePlugin = messaging.plugins.find(plugin => plugin.manifest.id === PRIVATE_CHAT_PLUGIN_ID)
  const privateAvailability = messaging.getPluginAvailability(PRIVATE_CHAT_PLUGIN_ID, conversationId)
  const summaryAvailability = messaging.getPluginAvailability(AI_SUMMARY_PLUGIN_ID, conversationId)
  const privateSendingPaused = privateMode && !privateAvailability.available
  const activeMembers = conversation?.members || []
  const unavailableGroup = isGroup && !conversation
  const blocked = conversation?.blocked || preferences.blocked.includes(conversationId)
  const request = conversation?.request || false
  const leftGroup = isGroup && !!conversation && !!group && !activeMembers.includes(myPub)
  const closedGroup = isGroup && !!conversation && !!group && activeMembers.length === 0
  const membershipUpdating = isGroup && !!conversation && !!group && !leftGroup && group.members.length !== activeMembers.length
  const usable = ready && !blocked && !request && !membershipUpdating && (!isGroup || (!!conversation && !!group && !leftGroup))
  const canCall = !isSelf && !isGroup && !blocked && !request && (contacts.some(contact => contact.pub === conversationId) || preferences.accepted.includes(conversationId))
  const title = isSelf ? nickname || "You" : group?.name || conversation?.name || contacts.find(contact => contact.pub === conversationId)?.alias || (isGroup ? "Group conversation" : shortAddress(conversationId))
  const contactNames = useMemo(() => new Map(contacts.map(contact => [contact.pub, contact.alias])), [contacts])
  const displayName = useCallback((pub: string) => pub === myPub ? nickname || "You" : contactNames.get(pub) || messaging.getProfile(pub).displayName || shortAddress(pub), [myPub, nickname, contactNames, messaging])
  const displaySummary = (message: MessageRecord) => formatMentionText(messageSummary(message), message.private ? [] : message.mentions || [], displayName)
  const messages = useMemo(() => messaging.messages.filter(message => message.conversationId === conversationId), [messaging.messages, conversationId])
  const byId = useMemo(() => new Map(messages.map(message => [message.id, message])), [messages])
  const messageTimes = useMemo(() => {
    const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
    const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })
    return new Map(messages.map(message => {
      const date = new Date(message.timestamp)
      return [message.id, { day: dayFormat.format(date), dayKey: date.toDateString(), time: timeFormat.format(date), full: date.toLocaleString(), iso: date.toISOString() }]
    }))
  }, [messages])
  const pinned = useMemo(() => messages.filter(message => message.pinned && !message.private), [messages])
  const files = useMemo(() => messages.filter(message => message.attachment && !message.private), [messages])
  const sharedLinks = useMemo(() => messages.filter(message => !message.private).flatMap(message => extractLinks(message.content).map(url => ({ url, message }))).reverse(), [messages])
  const { content, setContent, clearSubmittedDraft, retryDraftSave, draftReady, draftSaved, draftIssue } = useChatDraft(myPub, conversationId, !privateMode)
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [sendError, setSendError] = useState("")
  const [retrying, setRetrying] = useState<string | null>(null)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const [unseen, setUnseen] = useState(0)
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [matchIndex, setMatchIndex] = useState(0)
  const [copiedMessage, setCopiedMessage] = useState("")
  const [announcement, setAnnouncement] = useState("")
  const [replyTo, setReplyTo] = useState<string | undefined>()
  const [editing, setEditing] = useState<MessageRecord | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MessageRecord | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState("")
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const deleteMessageMenu = useRef<HTMLButtonElement | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [pollOpen, setPollOpen] = useState(false)
  const [requestSharing, setRequestSharing] = useState<ProfileField[]>([])
  const [privateOpen, setPrivateOpen] = useState(false)
  const [pluginsOpen, setPluginsOpen] = useState(false)
  const [summaryOpen, setSummaryOpen] = useState(false)
  const [selectedMessages, setSelectedMessages] = useState<string[] | null>(null)
  const [secretOpen, setSecretOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [infoTab, setInfoTab] = useState<"settings" | "files" | "links" | "pins">("settings")
  const [mentionOpen, setMentionOpen] = useState(false)
  const { mentionSpans, saveMentionDraft } = useMentionDraft(myPub, conversationId, content, draftReady, !privateMode)
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const chatRoot = useRef<HTMLDivElement>(null)
  const pendingMentionEdit = useRef<{ before: string; start: number; end: number } | null>(null)
  const [highlightedId, setHighlightedId] = useState("")
  const afterMessageMenuClose = useRef<(() => void) | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seenIds = useRef<Set<string> | null>(null)
  const messageNodes = useRef(new Map<string, HTMLDivElement>())
  const searchInput = useRef<HTMLInputElement>(null)
  const messagesViewport = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)
  const input = useRef<HTMLTextAreaElement>(null)
  const sendLock = useRef(false)
  const attachmentComposer = useRef<AttachmentComposerHandle | null>(null)
  const [attachmentState, setAttachmentState] = useState<AttachmentComposerState>({ count: 0, unavailable: false })
  const attachmentsUnavailable = !privateMode && attachmentState.unavailable
  const hasAttachments = !privateMode && attachmentState.count > 0
  const attachmentAccess = useRef(false)
  attachmentAccess.current = !!identity && usable && !privateMode && !directOnly
  const actionScope = useRef<object | null>(null)
  const summaryAllowed = usable && !privateMode && !directOnly && summaryAvailability.available
  const currentSummaryScope = useRef({ owner: myPub, conversationId, allowed: summaryAllowed })
  currentSummaryScope.current = { owner: myPub, conversationId, allowed: summaryAllowed }
  const isSummaryAllowed = () => {
    const scope = currentSummaryScope.current
    return scope.owner === myPub && scope.conversationId === conversationId && scope.allowed && messaging.getPluginAvailability(AI_SUMMARY_PLUGIN_ID, conversationId).available && messaging.getPrivateMode(conversationId) === 0 && messaging.getDeliveryMode(conversationId) !== "direct-only"
  }
  const searchTerm = query.trim()
  const matches = useMemo(() => {
    const pattern = literalSearch(searchTerm)
    return pattern ? messages.filter(message => !message.private && pattern.test(searchableText(message))).map(message => message.id) : []
  }, [messages, searchTerm])
  const selectedIndex = matches.length ? Math.min(matchIndex, matches.length - 1) : 0
  const activeMatch = matches[selectedIndex]
  const unconfirmed = useMemo(() => messages.filter(message => message.senderPubKey === myPub && message.delivery === "failed"), [messages, myPub])
  const sending = busy || retrying !== null || batchProgress !== null
  const notificationMode = preferences.notifications[conversationId] || "all"
  const mentionMembers = privateMode ? [] : (isGroup ? activeMembers : (isSelf ? [] : [conversationId])).filter(pub => pub !== myPub)
  const mentions = [...new Set(validMentionSpans(content, mentionSpans).map(span => span.publicKey))].filter(pub => mentionMembers.includes(pub))
  const mentionCandidates = mentionMembers.filter(pub => !mentions.includes(pub)
    && (!mentionQuery?.query || displayName(pub).toLocaleLowerCase().includes(mentionQuery.query.toLocaleLowerCase()) || pub.includes(mentionQuery.query.toLowerCase())))
  const selectedMentionIndex = Math.min(mentionIndex, Math.max(0, mentionCandidates.length - 1))

  function updateMentionQuery(value: string, start: number, end = start) {
    if (privateMode) { setMentionOpen(false); setMentionQuery(null); return }
    const query = findMentionQuery(value, start, end)
    const withinMention = validMentionSpans(value, mentionSpans).some(span => start > span.start && start <= span.end)
    setMentionQuery(query); setMentionIndex(0); setMentionOpen(!isSelf && !!query && !withinMention)
  }
  function changeMessage(value: string, start: number, end = start) {
    const edit = pendingMentionEdit.current
    pendingMentionEdit.current = null
    const nextSpans = updateMentionSpans(content, value, mentionSpans, edit?.before === content ? edit : undefined)
    setContent(value)
    saveMentionDraft(value, nextSpans)
    updateMentionQuery(value, start, end)
  }
  function insertFormatting(result: FormattedInsertion) {
    if (!usable || sending || !draftReady || privateMode) return
    pendingMentionEdit.current = null
    setContent(result.content)
    saveMentionDraft(result.content, updateMentionSpans(content, result.content, mentionSpans, result))
    setMentionOpen(false); setMentionQuery(null)
  }
  function chooseMention(pub: string) {
    const node = input.current
    if (!node || !usable || busy) return
    const range = mentionQuery || { start: node.selectionStart, end: node.selectionEnd }
    const result = insertMention(content, range, pub, displayName(pub))
    if (result.content.length > MAX_MESSAGE_LENGTH) { setSendError("There is not enough room for this mention. Shorten the message first."); return }
    const nextSpans = [...updateMentionSpans(content, result.content, mentionSpans, range), result.span]
    setContent(result.content); saveMentionDraft(result.content, nextSpans); setMentionOpen(false); setMentionQuery(null)
    requestAnimationFrame(() => { node.focus(); node.setSelectionRange(result.caret, result.caret) })
  }
  function removeMention(pub: string) {
    if (busy) return
    let next = content, spans = mentionSpans
    for (const span of validMentionSpans(content, mentionSpans).filter(item => item.publicKey === pub).sort((a, b) => b.start - a.start)) {
      const changed = next.slice(0, span.start) + next.slice(span.end)
      spans = updateMentionSpans(next, changed, spans, { start: span.start, end: span.end })
      next = changed
    }
    setContent(next); saveMentionDraft(next, spans); setMentionOpen(false)
    input.current?.focus()
  }

  const incomingLatest = useMemo(() => messages.findLast(message => message.senderPubKey !== myPub)?.timestamp || 0, [messages, myPub])

  useEffect(() => {
    const node = input.current
    if (!node) return
    const beforeInput = (event: Event) => {
      const kind = (event as InputEvent).inputType
      // Undo, autocorrect and composition can edit somewhere other than the caret.
      // Let the conservative text diff handle them rather than guessing a recipient.
      if (!["insertText", "insertFromPaste", "insertFromDrop", "deleteByCut", "deleteContentBackward", "deleteContentForward"].includes(kind)) {
        pendingMentionEdit.current = null; return
      }
      let start = node.selectionStart, end = node.selectionEnd
      if (start === end && kind?.startsWith("delete")) {
        if (kind === "deleteContentBackward") start -= Array.from(node.value.slice(0, start)).at(-1)?.length || 0
        else if (kind === "deleteContentForward") end += Array.from(node.value.slice(end))[0]?.length || 0
        else { pendingMentionEdit.current = null; return }
      }
      pendingMentionEdit.current = { before: node.value, start, end }
    }
    node.addEventListener("beforeinput", beforeInput)
    return () => node.removeEventListener("beforeinput", beforeInput)
  }, [myPub, conversationId, privateMode])
  useEffect(() => () => { clearTimeout(copyTimer.current); clearTimeout(highlightTimer.current) }, [])
  useEffect(() => {
    setToolsOpen(false)
    const scope = {}
    actionScope.current = scope; sendLock.current = false; seenIds.current = null; nearBottom.current = true
    setBusy(false); setRetrying(null); setBatchProgress(null); setSendError(""); setReplyTo(undefined); setDeleteTarget(null); setDeleteError(""); setEditing(null); setPrivateOpen(false); setSecretOpen(false); setSummaryOpen(false); setPluginsOpen(false); setSelectedMessages(null); setRequestSharing([])
    return () => { if (actionScope.current === scope) actionScope.current = null }
  }, [myPub, conversationId])
  useEffect(() => {
    if (!summaryAllowed) setSummaryOpen(false)
    if (!privateAvailability.available) setSecretOpen(false)
  }, [summaryAllowed, privateAvailability.available])
  useEffect(() => {
    if (privateMode) { setSelectedMessages(null); setReplyTo(undefined); setEditing(null); setPollOpen(false); setMentionOpen(false); setMentionQuery(null) }
  }, [privateMode])
  useEffect(() => {
    if (replyTo && (!byId.has(replyTo) || byId.get(replyTo)?.private)) setReplyTo(undefined)
    if (editing && (!byId.has(editing.id) || byId.get(editing.id)?.private)) setEditing(null)
    if (deleteTarget && !byId.has(deleteTarget.id)) setDeleteTarget(null)
  }, [byId, replyTo, editing, deleteTarget])
  useEffect(() => {
    const node = input.current
    if (node) { node.style.height = "auto"; node.style.height = Math.min(node.scrollHeight, 176) + "px" }
  }, [content, ready])
  const acknowledgeVisible = useCallback(() => {
    if (ready && !request && document.visibilityState === "visible" && document.hasFocus() && nearBottom.current && !window.location.hash) {
      void markRead(conversationId).catch(cause => setSendError(errorText(cause)))
    }
  }, [ready, request, markRead, conversationId])
  useEffect(() => {
    if (incomingLatest > (preferences.readAt[conversationId] || 0)) acknowledgeVisible()
    window.addEventListener("focus", acknowledgeVisible)
    document.addEventListener("visibilitychange", acknowledgeVisible)
    return () => { window.removeEventListener("focus", acknowledgeVisible); document.removeEventListener("visibilitychange", acknowledgeVisible) }
  }, [acknowledgeVisible, incomingLatest, preferences.readAt, conversationId])
  useEffect(() => {
    if (!ready) return
    const ids = new Set(messages.map(message => message.id))
    if (seenIds.current) {
      const added = messages.filter(message => message.senderPubKey !== myPub && !seenIds.current!.has(message.id)).length
      if (added) {
        if (!nearBottom.current) setUnseen(previous => previous + added)
        setAnnouncement(`${added} new message${added === 1 ? "" : "s"} received.`)
      }
    }
    seenIds.current = ids
    if (nearBottom.current && !searchTerm && !window.location.hash && messagesViewport.current) messagesViewport.current.scrollTop = messagesViewport.current.scrollHeight
  }, [messages, ready, myPub, searchTerm])
  const jumpToMessage = useCallback((id: string) => {
    const viewport = messagesViewport.current
    const message = messageNodes.current.get(id)
    if (!viewport || !message) return
    nearBottom.current = false; setAwayFromBottom(true)
    const viewportRect = viewport.getBoundingClientRect(), messageRect = message.getBoundingClientRect()
    viewport.scrollTop += messageRect.top - viewportRect.top - (viewport.clientHeight - messageRect.height) / 2
    clearTimeout(highlightTimer.current); setHighlightedId(id)
    highlightTimer.current = setTimeout(() => setHighlightedId(""), 4000)
  }, [])
  useEffect(() => { if (activeMatch) jumpToMessage(activeMatch) }, [activeMatch, searchTerm, jumpToMessage])
  useEffect(() => {
    const visitHash = () => {
      const hash = window.location.hash
      if (hash.startsWith("#message-")) jumpToMessage(hash.slice(9))
    }
    visitHash(); window.addEventListener("hashchange", visitHash)
    return () => window.removeEventListener("hashchange", visitHash)
  }, [conversationId, ready, messages.length, jumpToMessage])
  useEffect(() => { if (searchOpen) searchInput.current?.focus() }, [searchOpen])
  const jumpToLatest = () => {
    setQuery(""); nearBottom.current = true; setAwayFromBottom(false); setUnseen(0)
    if (window.location.hash) window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search)
    if (messagesViewport.current) messagesViewport.current.scrollTop = messagesViewport.current.scrollHeight
    acknowledgeVisible()
  }
  const moveMatch = (direction: number) => { if (matches.length) setMatchIndex((selectedIndex + direction + matches.length) % matches.length) }
  const act = async (action: () => Promise<unknown>, success?: string) => {
    if (actionBusy) return
    setActionBusy(true); setSendError("")
    try { await action(); if (success) setAnnouncement(success) } catch (cause) { setSendError(errorText(cause)) }
    finally { setActionBusy(false) }
  }
  const openSummary = () => {
    if (messaging.getDeliveryMode(conversationId) === "direct-only") { setSendError("AI Summary is unavailable in Force P2P. No conversation content was sent."); return }
    if (!summaryAvailability.available) { setSendError("Enable AI Summary in Manage plugins to use /summarize. This command was not sent."); return }
    if (privateMode) { setSendError("Turn off private mode before summarizing ordinary messages. This command was not sent."); return }
    if (!usable) { setSendError("This conversation is not available for a summary. This command was not sent."); return }
    setSendError(""); setSummaryOpen(true)
  }
  const submit = async () => {
    // Reserved local command even when unavailable: never fall through to message sending.
    if (resolvePluginCommand(content) === AI_SUMMARY_PLUGIN_ID) { openSummary(); return }
    if (directUnavailable) { setSendError("Connect directly while both people have Force P2P enabled. Your draft stays here."); return }
    if (privateSendingPaused) { setSendError(privateAvailability.reason); return }
    const scope = actionScope.current
    const attachments = privateMode || directOnly ? null : attachmentComposer.current
    const pending = attachments?.getState()
    if (!scope || (!content.trim() && !pending?.count) || pending?.unavailable || sendLock.current || !usable || !draftReady) return
    sendLock.current = true; setBusy(true); setSendError(""); jumpToLatest()
    try {
      const outgoing = privateMode ? { content, mentions: [] } : serializeMentionDraft(content, mentionSpans)
      if (outgoing.content.trim().length > MAX_MESSAGE_LENGTH) throw new Error("This message is too long after including mention addresses. Shorten it and try again.")
      const caption = { content: outgoing.content.trim(), mentions: outgoing.mentions.filter(pub => mentionMembers.includes(pub)) }
      const clearSentText = () => {
        clearSubmittedDraft()
        if (actionScope.current === scope) { setReplyTo(undefined); setMentionOpen(false) }
      }
      if (attachments && pending?.count) {
        await attachments.sendAll(caption, clearSentText)
      } else {
        await messaging.sendText(conversationId, outgoing.content, privateMode ? undefined : replyTo, caption.mentions, privateTtlSeconds)
        clearSentText()
      }
    } catch (cause) { if (actionScope.current === scope) setSendError(errorText(cause)) }
    finally { if (actionScope.current === scope) { sendLock.current = false; setBusy(false); input.current?.focus() } }
  }
  const retryFailed = async (snapshot: MessageRecord[], batch = false) => {
    const scope = actionScope.current
    if (!scope || sendLock.current || !ready || !snapshot.length) return
    sendLock.current = true; setSendError("")
    try {
      for (let index = 0; index < snapshot.length; index++) {
        if (actionScope.current !== scope) return
        setRetrying(snapshot[index].id)
        if (batch) setBatchProgress({ current: index + 1, total: snapshot.length })
        await messaging.retry(snapshot[index].id)
      }
      if (actionScope.current === scope && batch) setAnnouncement(`Retried ${snapshot.length} messages.`)
    } catch (cause) { if (actionScope.current === scope) setSendError(errorText(cause)) }
    finally { if (actionScope.current === scope) { sendLock.current = false; setRetrying(null); setBatchProgress(null) } }
  }
  const deleteSelectedMessage = async () => {
    if (!deleteTarget || deleting) return
    const scope = actionScope.current
    const target = deleteTarget
    setDeleting(true); setDeleteError("")
    try {
      await messaging.deleteMessage(target.conversationId, target.id)
      if (scope !== actionScope.current) return
      if (replyTo === target.id) setReplyTo(undefined)
      setDeleteTarget(null)
      setAnnouncement("Message deleted for you on this device.")
    } catch (cause) {
      if (scope === actionScope.current) setDeleteError(errorText(cause))
    } finally { setDeleting(false) }
  }
  const attachmentView = (message: MessageRecord) => !message.private && message.attachment && (directOnly && message.attachment.remote ? <p className="text-xs">Earlier relay attachment. Change delivery mode to retrieve it from server storage.</p> : <AttachmentView identity={identity} metadata={message.attachment} chunks={messaging.getAttachmentChunks(conversationId, message.id)} />)
  const openMessageFromInfo = (id: string) => { setInfoOpen(false); requestAnimationFrame(() => jumpToMessage(id)) }
  const statusLabel = { connecting: "Connecting inbox…", online: "Inbox connected", offline: "Inbox sync unavailable" }[status]
  const messageInput = <div className="flex min-w-0 items-end gap-1"><Button type="button" variant="ghost" size="icon" className="size-9 shrink-0 rounded-[4px]" aria-label="More message tools" title="Files, GIFs and message tools" aria-expanded={toolsOpen} aria-controls="message-tools" onClick={() => setToolsOpen(value => !value)}>{toolsOpen ? <X className="size-4" /> : <Plus className="size-4" />}</Button><Textarea ref={input} aria-label="Message" aria-busy={busy} autoComplete={privateMode ? "off" : undefined} autoCorrect={privateMode ? "off" : undefined} spellCheck={!privateMode} placeholder={blocked ? "Unblock this person to send messages" : request ? "Accept this conversation to reply" : unavailableGroup ? "This group is unavailable on this device" : closedGroup ? "This group is closed" : leftGroup ? "You left this group" : membershipUpdating ? "Updating group membership…" : ready ? privateMode ? "Write a private message…" : isSelf ? "Message yourself…" : "Write a message…" : "Opening conversation…"} value={content} onChange={event => changeMessage(event.target.value, event.target.selectionStart, event.target.selectionEnd)} onSelect={event => { const node = event.currentTarget; if (document.activeElement === node) updateMentionQuery(node.value, node.selectionStart, node.selectionEnd) }} onBlur={() => setMentionOpen(false)} aria-autocomplete="list" aria-controls={mentionOpen ? "message-mention-options" : undefined} aria-activedescendant={mentionOpen && mentionCandidates.length ? `message-mention-${selectedMentionIndex}` : undefined} maxLength={MAX_MESSAGE_LENGTH} disabled={!usable || !draftReady} readOnly={busy} rows={1} className="max-h-36 min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-2 text-base md:text-sm shadow-none focus-visible:ring-0" onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (mentionOpen) {
            if (event.key === "Escape") { event.preventDefault(); setMentionOpen(false); return }
            if (mentionCandidates.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) { event.preventDefault(); setMentionIndex((selectedMentionIndex + (event.key === "ArrowDown" ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length); return }
            if (mentionCandidates.length && ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab")) { event.preventDefault(); chooseMention(mentionCandidates[selectedMentionIndex]); return }
          }
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit() }
        }} /><Button type="submit" aria-label="Send message" disabled={!usable || !draftReady || (!content.trim() && !hasAttachments) || sending || attachmentsUnavailable || (privateSendingPaused && resolvePluginCommand(content) !== AI_SUMMARY_PLUGIN_ID)} size="icon" className="size-9 shrink-0 rounded-[4px]">{busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}</Button></div>
  return <div ref={chatRoot} className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <header className="flex min-h-15 shrink-0 items-center justify-between gap-1 border-b border-border bg-background px-2 py-1 sm:px-5">
      <div className="flex min-w-0 items-center gap-2.5"><Link href="/chat" aria-label="Back to conversations" className="flex size-11 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-card md:hidden"><ArrowLeft className="size-5" /></Link>{isGroup ? <span className="flex size-8 shrink-0 items-center justify-center rounded-[4px] border border-border bg-card text-primary"><Users className="size-5" /></span> : <span className="hidden shrink-0 sm:block"><IdentityIcon pubKey={conversationId} size={30} /></span>}<div className="min-w-0"><h1 className="truncate font-sans text-base font-medium tracking-tight">{title}{isSelf && <span className="ml-2 text-xs font-normal text-muted-foreground">yourself</span>}</h1><span className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><Lock className="size-3 shrink-0" /><span className="truncate">{conversation?.archived ? "Archived · History saved" : isGroup ? conversation?.invitation ? "Invitation pending · Encrypted" : unavailableGroup ? "Group history unavailable" : closedGroup ? "Closed group · Encrypted" : leftGroup ? "Left group · Encrypted" : `${activeMembers.length} members · Encrypted` : privateMode ? `Private · ${privateDurationLabel(privateTtlSeconds)} timer` : "End-to-end encrypted"}</span></span></div></div>
      <div className="flex shrink-0 items-center gap-1">{!privateMode && <Button variant="ghost" size="icon" aria-label="Select messages" title="Select messages" disabled={!usable || sending} aria-pressed={selectedMessages !== null} onClick={() => setSelectedMessages(current => current === null ? [] : null)}><ListChecks className="size-4" /></Button>}{canCall && <CallActions conversationId={conversationId} disabled={!usable} />}{isGroup && group && !group.deleted && !preferences.terminatedGroups?.includes(conversationId) && conversation?.members.includes(myPub) && <RoomCallActions group={group} disabled={!usable || closedGroup} />}<span role="status" title={statusLabel} className="mr-1 shrink-0"><span aria-hidden="true" className={`block size-1.5 rounded-full ${status === "online" ? "bg-primary" : status === "connecting" ? "animate-pulse bg-muted-foreground motion-reduce:animate-none" : "bg-muted-foreground"}`} /><span className="sr-only">{statusLabel}</span></span>{canUsePrivate && <Button variant="ghost" size="icon" aria-label="Private chat settings" title="Private chat" className={`${conversation ? "hidden sm:inline-flex" : ""} ${privateMode ? "text-primary" : ""}`} disabled={!usable || sending} onClick={() => setPrivateOpen(true)}><Timer className="size-4" /></Button>}<Button variant="ghost" size="icon" className={conversation && !isSelf ? "hidden sm:inline-flex" : ""} aria-label="Search conversation" aria-expanded={searchOpen} onClick={() => { setSearchOpen(!searchOpen); setQuery(""); setMatchIndex(0) }}><Search className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Conversation details, files and settings" onClick={() => { setInfoTab("settings"); setInfoOpen(true) }}><Info className="size-4" /></Button>{conversation && !isSelf && <ConversationActions conversation={conversation} disabled={sending || actionBusy} onError={setSendError} onNotice={setAnnouncement}>
        <DropdownMenuItem className="sm:hidden" onSelect={() => requestAnimationFrame(() => { setSearchOpen(true); setQuery(""); setMatchIndex(0) })}><Search />Search conversation</DropdownMenuItem>
        {canUsePrivate && <DropdownMenuItem className="sm:hidden" disabled={!usable || sending} onSelect={() => requestAnimationFrame(() => setPrivateOpen(true))}><Timer />Private chat settings</DropdownMenuItem>}
      </ConversationActions>}</div>
    </header>
    {status !== "online" && !error && <div role="status" className="shrink-0 border-b border-border/70 px-3 py-1 text-[11px] text-destructive">{statusLabel}</div>}
    {canCall && <DirectDelivery messaging={messaging} conversationId={conversationId} privateMode={privateMode} />}
    {privateMode && <div className="flex shrink-0 items-center gap-2 border-b border-primary/15 bg-primary/5 px-4 py-2 text-xs text-muted-foreground"><Timer className="size-3.5 shrink-0 text-primary" /><span className="min-w-0 flex-1">{privateSendingPaused ? "Private sending is paused until both people have compatible Private Chat enabled. Existing timers continue." : `New text messages disappear ${privateDurationLabel(privateTtlSeconds)} after sending. Copies may remain with the recipient.`}</span><Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={!usable || sending} onClick={() => setPrivateOpen(true)}>Change</Button></div>}
    {selectedMessages !== null && <MessageSelectionToolbar source={{ conversationId }} messages={messages} selected={selectedMessages} onCancel={() => setSelectedMessages(null)} />}
    {searchOpen && <div role="search" aria-label="Search saved messages" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 sm:px-7"><Input ref={searchInput} aria-label="Search messages" placeholder="Search ordinary messages…" className="min-w-32 flex-1" value={query} onChange={event => { setQuery(event.target.value); setMatchIndex(0) }} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { setSearchOpen(false); setQuery(""); input.current?.focus() } else if (event.key === "Enter") { event.preventDefault(); moveMatch(event.shiftKey ? -1 : 1) } }} /><span role="status" className="text-xs text-muted-foreground">{searchTerm ? matches.length ? `${selectedIndex + 1} of ${matches.length}` : "No matches" : "Private messages excluded"}</span><Button variant="ghost" size="icon" aria-label="Previous match" disabled={!matches.length} onClick={() => moveMatch(-1)}><ChevronUp className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Next match" disabled={!matches.length} onClick={() => moveMatch(1)}><ChevronDown className="size-4" /></Button><Button variant="ghost" size="icon" aria-label="Close search" onClick={() => { setSearchOpen(false); setQuery(""); input.current?.focus() }}><X className="size-4" /></Button></div>}
    {error && <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-5 py-3 text-sm text-destructive"><p role="alert" className="min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</p><Button type="button" size="sm" variant="outline" disabled={sending || actionBusy} onClick={() => void act(() => messaging.sync())}><RotateCw className="size-4" />Reconnect inbox</Button></div>}
    {deliveryError && <div role="alert" className="shrink-0 space-y-1 border-b border-destructive/20 bg-destructive/5 px-5 py-3 text-sm text-destructive [overflow-wrap:anywhere]"><p className="font-medium">Delivery issue in this conversation</p><p>{deliveryError}</p></div>}
    {sendError && sendError !== deliveryError && sendError !== error && <div className="flex shrink-0 items-start gap-3 border-b border-destructive/20 bg-destructive/5 px-5 py-3 text-sm text-destructive"><p role="alert" className="min-w-0 flex-1 [overflow-wrap:anywhere]">{sendError}</p><Button size="icon" variant="ghost" className="shrink-0" aria-label="Dismiss conversation error" onClick={() => setSendError("")}><X className="size-4" /></Button></div>}
    {request && !blocked && <div className="flex flex-wrap items-center gap-3 border-b border-primary/20 bg-primary/5 p-4 text-sm"><p className="min-w-40 flex-1">{isGroup ? conversation?.invitation ? `Invitation from ${displayName(conversation.invitation.invitation.admin)} · ${conversation.invitation.memberCount} current members. You receive no group messages until you accept.` : "Ask the administrator for a fresh invitation to join this group." : "This person is not in your accepted conversations."} Accept to reply.</p><Button size="sm" disabled={actionBusy || (isGroup && !conversation?.invitation) || conversation?.invitationStatus === "joining"} onClick={() => void act(async () => { await messaging.acceptRequest(conversationId); if (!isGroup) await messaging.setProfileSharing(conversationId, requestSharing) })}>{conversation?.invitationStatus === "joining" ? "Waiting for administrator…" : "Accept"}</Button>{conversation?.invitation && conversation.invitationStatus !== "joining" && <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => void act(() => messaging.declineGroupInvitation(conversationId))}>Decline</Button>}{!isGroup && <Button size="sm" variant="outline" disabled={actionBusy} onClick={() => void act(() => messaging.blockContact(conversationId))}>Block</Button>}{!isGroup && <div className="w-full"><ProfileSharingFields owner={myPub} values={messaging.profile.values} selected={requestSharing} onChange={setRequestSharing} disabled={actionBusy} /></div>}</div>}
    {blocked && <div className="flex items-center justify-between gap-3 border-b border-border p-4 text-sm text-muted-foreground"><span>{isGroup ? "This group’s administrator is blocked." : "This person is blocked."}</span><Button size="sm" variant="outline" disabled={actionBusy || (isGroup && !group)} onClick={() => void act(() => messaging.blockContact(isGroup ? group!.admin : conversationId, false))}>Unblock</Button></div>}
    {pinned.length > 0 && <button type="button" className="flex items-center gap-2 border-b border-border shrink-0 bg-card/40 px-5 py-1.5 text-left text-xs text-primary hover:bg-card" onClick={() => { setInfoTab("pins"); setInfoOpen(true) }}><Pin className="size-3.5 shrink-0" /><span className="shrink-0">{pinned.length} pinned</span><span className="truncate text-muted-foreground">{displaySummary(pinned.at(-1)!)}</span></button>}
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div ref={messagesViewport} role="region" aria-label="Conversation messages" tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-2 py-3 sm:px-5" onScroll={event => { const node = event.currentTarget; const wasNearBottom = nearBottom.current; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; setAwayFromBottom(!nearBottom.current); if (nearBottom.current) { setUnseen(0); if (!wasNearBottom) acknowledgeVisible() } }}>
      <div className="mx-auto max-w-7xl">{messages.length > 0 ? null : <div className="max-w-lg py-8 text-left sm:py-10">{isSelf ? <MessageSquare className="mb-5 size-7 text-primary" /> : <Shield className="mb-5 size-7 text-primary" />}<p className="app-eyebrow mb-3">Your conversation</p><h2 className="mb-3 text-3xl font-medium tracking-[-0.045em] text-foreground">{isSelf ? "Send things to yourself." : isGroup ? title : "Start with a hello."}</h2><p className="max-w-sm text-sm leading-7 text-muted-foreground">{isSelf ? "Send yourself messages, files, voice notes and links, just like any other conversation." : isGroup ? "A shared conversation with your group. Messages are encrypted before leaving your device." : "Verify this contact’s address through another trusted channel. Messages are encrypted before leaving your device."}</p>{!isGroup && <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">{isSelf ? "Your address" : "Contact address"}</summary><p className="mt-2 select-all break-all font-mono leading-relaxed">{conversationId}</p></details>}</div>}
        {!ready && <p role="status" className="flex justify-center gap-2 py-5 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Opening conversation…</p>}
        {ready && isGroup && !group && !conversation?.invitation && <p role="status" className="rounded-[4px] border border-border p-5 text-center text-sm text-muted-foreground">This group is not saved on this device. Ask a group member for an invitation, or restore your chat backup.</p>}
        {!isSelf && !isGroup && <CallHistory conversationId={conversationId} />}
        {messages.map((message, index) => {
          const mine = message.senderPubKey === myPub
          const time = messageTimes.get(message.id)!
          const previousDay = index ? messageTimes.get(messages[index - 1].id)!.dayKey : ""
          const quoted = !message.private && message.replyTo ? byId.get(message.replyTo) : undefined
          const inRun = (first: MessageRecord | undefined, second: MessageRecord | undefined) => !!first && !!second
            && first.senderPubKey === second.senderPubKey && !first.private && !second.private
            && !second.replyTo && first.delivery !== "failed" && second.delivery !== "failed"
            && second.timestamp >= first.timestamp && second.timestamp - first.timestamp < 5 * 60_000
            && messageTimes.get(first.id)!.dayKey === messageTimes.get(second.id)!.dayKey
          const continuesRun = inRun(messages[index - 1], message)
          const next = messages[index + 1]
          const showMetadata = !inRun(message, next) || message.editedAt || message.pinned
            || message.delivery === "pending" || message.delivery !== next?.delivery
          return <div key={message.id} id={`message-${message.id}`} ref={node => { if (node) messageNodes.current.set(message.id, node); else messageNodes.current.delete(message.id) }} data-message-run={continuesRun ? "continuation" : "start"} className={`${continuesRun ? "mt-0.5" : "mt-2"} ${activeMatch === message.id || highlightedId === message.id ? "rounded-[4px] ring-2 ring-primary/60 ring-offset-4 ring-offset-background" : ""}`}>{selectedMessages !== null && canShareMessage(message) && <label className="mb-1 flex min-h-10 cursor-pointer items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" className="size-4 accent-primary" aria-label={`Select message ${message.id}`} checked={selectedMessages.includes(message.id)} disabled={!selectedMessages.includes(message.id) && selectedMessages.length >= MAX_SHARED_MESSAGES} onChange={() => setSelectedMessages(current => toggleSharedSelection(current || [], message.id))} />Select message</label>}{previousDay !== time.dayKey && <p className="mb-3 flex items-center gap-4 pt-2 text-[11px] font-medium text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">{time.day}</p>}<div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
            {isGroup && !mine && !continuesRun && <p className="mb-1 ml-1 text-xs font-medium text-primary">{displayName(message.senderPubKey)}</p>}<span className="sr-only">{displayName(message.senderPubKey)}:</span>
            <div className={`flex w-full min-w-0 items-start gap-1 ${mine ? "flex-row-reverse" : ""}`}>
              <div className={`min-w-0 max-w-[calc(100%-3rem)] break-words rounded-[4px] px-2.5 py-1 text-[15px] leading-[1.4] [overflow-wrap:anywhere] sm:max-w-[min(85%,75ch)] ${mine ? "border border-primary/15 bg-message-outgoing text-message-outgoing-foreground" : "border border-border bg-message-incoming text-message-incoming-foreground"}`}>
                {!message.private && message.replyTo && <button type="button" disabled={!quoted} aria-label={quoted ? "Jump to replied message" : "Original message is unavailable"} className="mb-1.5 block w-full rounded-r border-l-2 border-current/40 bg-current/5 px-2 py-1 text-left text-xs" onClick={() => { if (quoted) jumpToMessage(quoted.id) }}><span className="block font-medium">{quoted ? displayName(quoted.senderPubKey) : "Reply"}</span><span className="line-clamp-2 opacity-70">{quoted ? displaySummary(quoted) : "Original message is not saved on this device."}</span></button>}
                {message.private ? <SecretMessage content={message.content} expiresAt={message.expiresAt || 0} secret={message.secret} /> : message.shared ? <SharedMessageBundle bundle={message.shared} /> : message.content && !message.poll && <RichMessage text={message.content} highlight={searchTerm} mentions={message.mentions} displayName={displayName} />}
                {!message.private && message.attachment && attachmentView(message)}
                {!message.private && message.poll && <PollCard question={message.poll.question} options={message.poll.options.map((text, i) => ({ id: String(i), text }))} votes={Object.fromEntries(Object.entries(message.poll.votes).map(([pub, option]) => [pub, String(option)]))} myPub={myPub} disabled={!usable} onVote={option => messaging.vote(conversationId, message.id, Number(option))} />}
                {!message.private && !!message.mentions?.length && <p className="mt-1 text-xs opacity-65">Mentioned: {message.mentions.map(displayName).join(", ")}</p>}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild><button type="button" aria-label="Message actions" title="Message actions" className="flex size-7 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-muted hover:text-foreground data-[state=open]:bg-muted"><MoreHorizontal className="size-4" /></button></DropdownMenuTrigger>
                <DropdownMenuContent align={mine ? "end" : "start"} onCloseAutoFocus={event => {
                  const action = afterMessageMenuClose.current
                  if (action) { event.preventDefault(); afterMessageMenuClose.current = null; action() }
                }}>
                  <div className="px-2 py-1.5 text-xs text-muted-foreground"><time dateTime={time.iso}>{time.full}</time></div>
                  {!message.secret && <DropdownMenuItem className="min-h-11" onSelect={async () => { if (message.private && (!message.expiresAt || Date.now() >= message.expiresAt)) return; try { await navigator.clipboard.writeText(message.private ? message.content : messageSummary(message)); clearTimeout(copyTimer.current); setCopiedMessage(message.id); setAnnouncement("Message copied."); copyTimer.current = setTimeout(() => setCopiedMessage(""), 2500) } catch { setSendError("Clipboard access was blocked. Select the message text to copy it.") } }}>{copiedMessage === message.id ? <Check /> : <Copy />}{copiedMessage === message.id ? "Copied" : "Copy"}</DropdownMenuItem>}
                  {!message.private && !privateMode && !directOnly && message.route !== "direct-only" && <DropdownMenuItem className="min-h-11" disabled={!usable} onSelect={() => { afterMessageMenuClose.current = () => { setReplyTo(message.id); input.current?.focus() } }}><Reply />Reply</DropdownMenuItem>}
                  {!message.private && !privateMode && !directOnly && message.route !== "direct-only" && mine && !!message.content && !message.attachment && !message.poll && !message.shared && <DropdownMenuItem className="min-h-11" disabled={!usable || actionBusy} onSelect={() => { afterMessageMenuClose.current = () => setEditing(message) }}><Pencil />Edit</DropdownMenuItem>}
                  {!message.private && <DropdownMenuItem className="min-h-11" disabled={!usable || actionBusy} onSelect={() => void act(() => messaging.pinMessage(conversationId, message.id, !message.pinned), message.pinned ? "Message unpinned." : "Message pinned.")}>{message.pinned ? <PinOff /> : <Pin />}{message.pinned ? "Unpin" : "Pin"}</DropdownMenuItem>}
                  {!message.secret && <DropdownMenuSeparator />}
                  <DropdownMenuItem className="min-h-11" variant="destructive" disabled={!ready || sending || deleting} onSelect={() => { afterMessageMenuClose.current = () => { deleteMessageMenu.current = messageNodes.current.get(message.id)?.querySelector<HTMLButtonElement>('button[aria-label="Message actions"]') ?? null; setDeleteError(""); setDeleteTarget(message) } }}><Trash2 />Delete for me…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className={showMetadata ? "mt-0.5 flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 tabular-nums text-[11px] leading-4 text-muted-foreground" : "sr-only"}><time title={time.full} dateTime={time.iso}>{time.time}</time>{!message.private && message.editedAt && <span title={`Edited ${new Date(message.editedAt).toLocaleString()}`}>edited</span>}{!message.private && message.pinned && <Pin aria-label="Pinned message" className="size-3 text-primary" />}
              {mine && (isSelf ? <span className="flex items-center gap-1"><Check className="size-3" />Saved</span> : message.delivery === "failed" ? <button type="button" disabled={sending || !ready} title={message.error} className="flex min-h-7 items-center gap-1 rounded px-1 text-destructive hover:text-destructive disabled:opacity-50" onClick={() => void retryFailed([message])}><RotateCw className={`size-3 ${retrying === message.id ? "animate-spin" : ""}`} />{retrying === message.id ? "Retrying" : "Failed · Retry"}</button> : <span className="flex items-center gap-1" title={isGroup ? "Sender submission state. Group reads are not shared." : message.delivery === "sent" ? "Accepted by the encrypted relay; no recipient receipt yet." : message.delivery === "delivered" ? `Received by ${message.deliveredTo.length || 1} recipient(s).` : message.delivery === "read" ? `Read by ${message.readBy.length || 1} recipient(s).` : "Waiting to reach the relay."}>{message.delivery === "pending" ? <Loader2 className="size-3 animate-spin" /> : message.delivery === "read" || message.delivery === "delivered" ? <CheckCheck className={`size-3 ${message.delivery === "read" ? "text-primary" : ""}`} /> : <Check className="size-3" />}{({ pending: "Queued", sent: "Sent", delivered: "Delivered", read: "Read", received: "Received", failed: "Failed" })[message.delivery]}</span>)}
            </div>
            {mine && message.delivery === "failed" && message.error && message.error !== deliveryError && message.error !== sendError && <p className="mt-1 max-w-[94%] text-xs text-destructive [overflow-wrap:anywhere] sm:max-w-[min(85%,75ch)]">{message.error}</p>}
          </div></div>
        })}
      </div>
    </div>
    {(awayFromBottom || unseen > 0) && <div className="flex justify-center border-t border-border/60 py-2"><Button variant="secondary" size="sm" className="rounded-[4px]" onClick={jumpToLatest}><ArrowDown className="size-4" /><span aria-live="polite">{unseen ? `${unseen} new message${unseen === 1 ? "" : "s"}` : "Jump to latest"}</span></Button></div>}
    <footer className="chat-composer chat-bottom min-w-0 shrink-0 overflow-y-auto border-t border-border bg-background px-2 pt-2 sm:px-5">
      {ready && unavailableGroup && <p className="mx-auto mb-3 max-w-7xl text-sm text-muted-foreground">This group has no saved conversation on this device. A new group message may make it available again.</p>}
      {leftGroup && <p className="mx-auto mb-3 max-w-7xl text-sm text-muted-foreground">{closedGroup ? "This group is closed. Saved messages are still available." : "You are no longer a member of this group. Your saved conversation is still available."}</p>}
      {membershipUpdating && <p className="mx-auto mb-3 max-w-7xl text-sm text-muted-foreground">Updating group membership before sending more messages…</p>}
      {(unconfirmed.length > 1 || batchProgress) && <div className="mx-auto mb-3 flex max-w-7xl flex-wrap items-center justify-between gap-2 text-xs text-destructive"><span role="status">{batchProgress ? `Retrying ${batchProgress.current} of ${batchProgress.total}…` : `${unconfirmed.length} messages need another attempt.`}</span><Button type="button" size="sm" variant="outline" disabled={!ready || sending} onClick={() => void retryFailed(unconfirmed, true)}><RotateCw className={`size-3 ${batchProgress ? "animate-spin" : ""}`} />{batchProgress ? "Retrying…" : "Retry failed messages"}</Button></div>}
      <div className="mx-auto max-w-7xl">
        {!privateMode && replyTo && <div className="mb-2 flex items-center gap-2 rounded-[4px] border-l-2 border-primary bg-card p-2 text-xs"><Reply className="size-4 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block text-primary">Replying to {byId.get(replyTo) ? displayName(byId.get(replyTo)!.senderPubKey) : "message"}</span><span className="block truncate text-muted-foreground">{byId.get(replyTo) ? displaySummary(byId.get(replyTo)!) : "Original message"}</span></span><Button variant="ghost" size="icon" aria-label="Cancel reply" onClick={() => setReplyTo(undefined)}><X className="size-4" /></Button></div>}
        <form aria-label="Message composer" onSubmit={event => { event.preventDefault(); if (event.target === event.currentTarget) void submit() }}>
          <div className="rounded-[4px] border border-border bg-card p-1 transition-colors focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/20">
            {directOnly ? <>{messageInput}<p className="py-1 text-[11px] text-muted-foreground">Direct text only here · Use Send direct file above for files up to 2 MiB</p></> : privateMode ? <>{messageInput}<div id="message-tools" className={`${toolsOpen ? "flex" : "hidden"} flex-wrap items-center justify-between gap-2 py-1`}><Button type="button" variant="ghost" size="sm" disabled={!usable || sending || !privateAvailability.available} onClick={() => setSecretOpen(true)}><KeyRound className="size-4" />Share access key</Button><span className="text-[11px] text-muted-foreground">Plain text only · No files or polls</span></div></> : <AttachmentComposer key={`${myPub}:${conversationId}`} scopeKey={`${myPub}:${conversationId}`} composerRef={attachmentComposer} onStateChange={setAttachmentState} owner={myPub} maxFileBytes={attachmentFileLimit(group)} toolbarVisible={toolsOpen} toolbarId="message-tools" extraActions={<>
          {summaryAvailability.available && <Button type="button" variant="ghost" size="sm" disabled={!usable || sending} onClick={openSummary}><Sparkles className="size-4" />Summarize</Button>}
          <MessageFormattingTools key={`format:${myPub}:${conversationId}`} content={content} inputRef={input} disabled={!usable || sending || !draftReady} onInsert={insertFormatting} />
          {canUsePrivate && <Button type="button" variant="ghost" size="sm" disabled={!usable || sending || !privateAvailability.available} onClick={() => setSecretOpen(true)}><KeyRound className="size-4" /><span className="hidden sm:inline">Access key</span><span className="sr-only sm:hidden">Share access key</span></Button>}
          <Button type="button" variant="ghost" size="sm" disabled={!usable} onClick={() => setPollOpen(true)}><BarChart3 className="size-4" />Poll</Button>
          {!isSelf && <Button type="button" variant="ghost" size="sm" disabled={!usable} aria-expanded={mentionOpen} onClick={() => { setMentionQuery(findMentionQuery(content, input.current?.selectionStart ?? content.length, input.current?.selectionEnd ?? content.length)); setMentionIndex(0); setMentionOpen(!mentionOpen); if (!mentionOpen) requestAnimationFrame(() => document.getElementById("message-mention-0")?.focus()); else input.current?.focus() }}><AtSign className="size-4" />Mention</Button>}
        </>} captureRef={chatRoot} pasteRef={input} disabled={!usable || !draftReady} onSelectGif={url => {
          if (!usable || sending || !draftReady) return
          const next = content.trim() ? `${content}\n${url}` : url
          if (next.length > MAX_MESSAGE_LENGTH) { setSendError("There is not enough room for this GIF. Send or shorten your draft first."); return }
          changeMessage(next, next.length)
          requestAnimationFrame(() => input.current?.focus())
        }} onStage={async (file, kind, onProgress, signal) => {
          if (!identity || !usable || privateMode || messaging.getDeliveryMode(conversationId) === "direct-only") throw new Error("This conversation is not available for attachments.")
          return stageAttachment(messaging.sendEvent, conversationId, file, identity, kind, onProgress, signal, group)
        }} onPublish={async (prepared, caption) => {
          if (!identity || !usable || privateMode || messaging.getDeliveryMode(conversationId) === "direct-only") throw new Error("This conversation is not available for attachments.")
          const scope = actionScope.current
          const id = await publishAttachment((id, kind, payload) => {
            if (actionScope.current !== scope || !attachmentAccess.current) throw new Error("This conversation is no longer available for attachments.")
            return messaging.sendEvent(id, kind, payload)
          }, conversationId, prepared, caption ? replyTo : undefined, caption)
          if (actionScope.current === scope) jumpToLatest()
          return id
        }} onDiscard={prepared => prepared.discard()} onSend={async (file, kind, onProgress, caption) => { const scope = actionScope.current; const id = await sendAttachment(messaging.sendEvent, conversationId, file, kind, onProgress, caption ? replyTo : undefined, group, caption); if (actionScope.current === scope) jumpToLatest(); return id }}>{messageInput}</AttachmentComposer>}
          </div>
        </form>
        {!privateMode && <MessageFormattingPreview content={content} />}
        {!privateMode && mentionOpen && <div id="message-mention-options" role="listbox" aria-label="Mention suggestions" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); setMentionOpen(false); input.current?.focus() }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && mentionCandidates.length) {
            event.preventDefault()
            const current = mentionCandidates.findIndex((_, index) => document.activeElement?.id === `message-mention-${index}`)
            const next = event.key === "Home" ? 0 : event.key === "End" ? mentionCandidates.length - 1 : (current + (event.key === "ArrowDown" ? 1 : mentionCandidates.length - 1)) % mentionCandidates.length
            setMentionIndex(next); document.getElementById(`message-mention-${next}`)?.focus()
          }
        }} className="mb-2 max-h-48 overflow-y-auto rounded-[4px] border border-border bg-card p-1 text-sm">
          {mentionCandidates.map((pub, index) => <button type="button" role="option" id={`message-mention-${index}`} aria-selected={index === selectedMentionIndex} key={pub} onPointerDown={event => event.preventDefault()} onClick={() => chooseMention(pub)} className={`flex w-full items-center justify-between gap-3 min-w-0 rounded-[4px] px-3 py-2 text-left ${index === selectedMentionIndex ? "bg-primary/15 text-primary" : "text-foreground hover:bg-muted"}`}><span className="min-w-0 flex-1 truncate">@{displayName(pub)}</span><span className="shrink-0 font-mono text-xs text-muted-foreground">{shortAddress(pub)}</span></button>)}
          {!mentionCandidates.length && <p className="px-3 py-2 text-xs text-muted-foreground">{mentionQuery?.query ? "No matching members." : "Everyone is already mentioned."}</p>}
        </div>}
        {mentions.length > 0 && <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">{mentions.map(pub => <button type="button" key={pub} aria-label={`Remove mention of ${displayName(pub)}`} disabled={busy} onClick={() => removeMention(pub)} className="inline-flex items-center gap-1 rounded-[3px] bg-primary/15 px-2 py-1 text-primary">@{displayName(pub)}<X className="size-3" /></button>)}</div>}
        <div className={toolsOpen || (!privateMode && !draftSaved) ? "mt-1 flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground" : "sr-only"}><span className="hidden sm:inline">Enter to send · Shift + Enter for a new line · Math and Code in message tools</span><span className={!privateMode && !draftSaved ? "text-destructive" : ""}>{privateMode ? "Private draft stays only in this tab" : !draftSaved ? draftIssue === "read" ? "Saved draft could not be loaded" : draftIssue === "clear" ? "Sent text is waiting to be cleared from storage" : "Draft is only in this tab · Do not close it" : content ? "Draft saved on this browser" : "History saved on this browser"}</span></div>{!privateMode && !draftSaved && <Button type="button" size="sm" variant="ghost" onClick={retryDraftSave}>{draftIssue === "read" ? "Try loading draft again" : draftIssue === "clear" ? "Retry draft cleanup" : "Try saving draft again"}</Button>}{content.length > MAX_MESSAGE_LENGTH - 1000 && <p className="mt-1 text-right text-xs text-muted-foreground">{content.length.toLocaleString()} / {MAX_MESSAGE_LENGTH.toLocaleString()}</p>}
      </div>
    </footer>
    {canUsePrivate && <PrivateChatControls key={`private:${myPub}:${conversationId}`} open={privateOpen} onOpenChange={setPrivateOpen} ttlSeconds={privateTtlSeconds} disabled={!usable || sending} pluginEnabled={!!privatePlugin?.enabled} available={privateAvailability.available} availabilityReason={privateAvailability.reason} onCheckPeer={() => messaging.refreshPeerCapabilities(conversationId)} onManagePlugins={() => { setPrivateOpen(false); setPluginsOpen(true) }} onSetMode={seconds => messaging.setPrivateMode(conversationId, seconds)} onDestroy={async () => { await messaging.destroyPrivateHistory(conversationId); setAnnouncement("Private history destroyed here. The other person’s updated app will remove it when it receives the request.") }} />}
    {canUsePrivate && privateAvailability.available && secretOpen && <ShareSecretDialog key={`secret:${myPub}:${conversationId}`} recipientName={title} recipientAddress={conversationId} disabled={!usable || sending} onClose={() => setSecretOpen(false)} onSend={async (secret, seconds) => { await messaging.sendSecret(conversationId, secret, seconds); jumpToLatest() }} />}
    <PluginSettings open={pluginsOpen} onOpenChange={setPluginsOpen} />
    {identity && summaryAllowed && summaryOpen && <AiSummaryDialog key={`summary:${myPub}:${conversationId}`} identity={identity} conversationId={conversationId} messages={messages} isAllowed={isSummaryAllowed} onClose={() => setSummaryOpen(false)} onSend={async summary => {
      if (!isSummaryAllowed()) throw new Error("This conversation changed. Open a new summary before sending.")
      await messaging.sendText(conversationId, summary, undefined, [], 0)
      jumpToLatest()
    }} />}
    <PollCreator open={!privateMode && pollOpen} onOpenChange={setPollOpen} onCreate={async (question, options) => { await messaging.createPoll(conversationId, question, options); jumpToLatest() }} />
    <EditMessageDialog message={editing} onClose={() => setEditing(null)} onSave={(id, value) => messaging.editMessage(conversationId, id, value)} />
    <Dialog open={!!deleteTarget} onOpenChange={open => { if (!open && !deleting) setDeleteTarget(null) }}>
      <DialogContent onOpenAutoFocus={event => { event.preventDefault(); cancelDelete.current?.focus() }} onCloseAutoFocus={event => {
        event.preventDefault()
        if (deleteMessageMenu.current?.isConnected) deleteMessageMenu.current.focus()
        else if (input.current && !input.current.disabled) input.current.focus()
        else messagesViewport.current?.focus()
      }}>
        <DialogHeader><DialogTitle>Delete this message for you?</DialogTitle><DialogDescription>This removes the message and its attachment from saved history on this device. Other participants and linked devices keep their copies. This cannot be undone here.</DialogDescription></DialogHeader>
        {deleteTarget && <p className="line-clamp-3 break-words rounded-[4px] bg-muted p-3 text-sm text-muted-foreground [overflow-wrap:anywhere]">{displaySummary(deleteTarget)}</p>}
        {deleteError && <p role="alert" className="text-sm text-destructive">{deleteError}</p>}
        <DialogFooter><Button ref={cancelDelete} variant="outline" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancel</Button><Button variant="destructive" disabled={deleting} onClick={() => void deleteSelectedMessage()}>{deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}Delete for me</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={infoOpen} onOpenChange={setInfoOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Conversation settings and everything shared here.</DialogDescription></DialogHeader><div role="tablist" aria-label="Conversation details" className="grid grid-cols-4 gap-1 border-b border-border pb-2">{([['settings', 'Settings'], ['files', 'Files'], ['links', 'Links'], ['pins', 'Pinned']] as const).map(([tab, label]) => <button key={tab} type="button" id={`details-tab-${tab}`} role="tab" aria-selected={infoTab === tab} tabIndex={infoTab === tab ? 0 : -1} aria-controls={`details-panel-${tab}`} onKeyDown={event => { const tabs = ["settings", "files", "links", "pins"] as const; const index = tabs.indexOf(tab); const next = event.key === "ArrowRight" ? tabs[(index + 1) % tabs.length] : event.key === "ArrowLeft" ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1] : null; if (next) { event.preventDefault(); setInfoTab(next); document.getElementById(`details-tab-${next}`)?.focus() } }} onClick={() => setInfoTab(tab)} className={`rounded-[4px] px-2 py-2 text-sm ${infoTab === tab ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>{label}</button>)}</div><div role="tabpanel" id={`details-panel-${infoTab}`} aria-labelledby={`details-tab-${infoTab}`} className="min-h-32 space-y-4">
      {infoTab === "files" && (files.length ? [...files].reverse().map(message => <div key={message.id} className="space-y-2 rounded-[4px] border border-border p-3">{attachmentView(message)}<button type="button" className="text-xs text-primary hover:underline" onClick={() => openMessageFromInfo(message.id)}>View message · {new Date(message.timestamp).toLocaleDateString()}</button></div>) : <p className="py-8 text-center text-sm text-muted-foreground">Files and voice messages will appear here.</p>)}
      {infoTab === "links" && (sharedLinks.length ? sharedLinks.map(({ url, message }, index) => <div key={`${message.id}:${index}`} className="space-y-2 rounded-[4px] border border-border p-3"><a href={url} target="_blank" rel="noopener noreferrer" className="flex items-start gap-2 break-all text-sm text-primary hover:underline"><ExternalLink className="mt-0.5 size-4 shrink-0" />{url}</a><button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => openMessageFromInfo(message.id)}>View message · {displayName(message.senderPubKey)}</button></div>) : <p className="py-8 text-center text-sm text-muted-foreground">Links from this conversation will appear here.</p>)}
      {infoTab === "pins" && (pinned.length ? [...pinned].reverse().map(message => <div key={message.id} className="rounded-[4px] border border-border p-3"><button type="button" className="w-full text-left" onClick={() => openMessageFromInfo(message.id)}><span className="text-xs text-primary">{displayName(message.senderPubKey)}</span><p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-sm text-foreground">{displaySummary(message)}</p><span className="mt-2 block text-xs text-muted-foreground">Jump to message</span></button><Button size="sm" variant="ghost" disabled={!usable || actionBusy} onClick={() => void act(() => messaging.pinMessage(conversationId, message.id, false))}><PinOff className="size-3" />Unpin</Button></div>) : <p className="py-8 text-center text-sm text-muted-foreground">Pin a message to find it quickly here.</p>)}
      {infoTab === "settings" && <>
        <Button variant="outline" onClick={() => { setInfoOpen(false); setPluginsOpen(true) }}><Puzzle className="size-4" />Manage plugins</Button>
        {!isSelf && <div className="space-y-2"><Label htmlFor="conversation-notifications" className="flex items-center gap-2"><Bell className="size-4" />Notifications</Label><select id="conversation-notifications" value={notificationMode} disabled={actionBusy} onChange={event => void act(() => messaging.setNotificationMode(conversationId, event.target.value as NotificationMode))} className="h-10 w-full rounded-[4px] border border-border bg-card px-3 text-sm"><option value="all">All messages</option><option value="mentions">Mentions only</option><option value="muted">Muted</option></select><p className="text-xs leading-relaxed text-muted-foreground">Browser notifications work while Serotine is open. Enable them in the inbox settings.</p></div>}
        {isGroup && group && conversation && <GroupSettings groupName={group.name} members={activeMembers.map(pub => ({ pub, label: displayName(pub) }))} candidates={contacts.filter(contact => !activeMembers.includes(contact.pub)).map(contact => ({ pub: contact.pub, label: contact.alias || shortAddress(contact.pub) }))} canManage={group.admin === myPub && !membershipUpdating} left={leftGroup} ownerPub={group.admin} myPub={myPub} onRename={name => messaging.updateGroup(conversationId, { name })} onAdd={async pub => { const address = await parseContactCode(pub); if (activeMembers.includes(address)) throw new Error("This person is already in the group."); await messaging.updateGroup(conversationId, { members: [...activeMembers, address] }) }} onRemove={pub => messaging.updateGroup(conversationId, { members: activeMembers.filter(member => member !== pub) })} onLeave={() => messaging.leaveGroup(conversationId)} onDissolve={() => messaging.dissolveGroup(conversationId)} pendingInvitations={messaging.getPendingGroupInvitations(conversationId).map(item => ({ id: item.invitation.id, label: displayName(item.invitation.invitee) }))} onRevoke={id => messaging.revokeGroupInvitation(conversationId, id)} />}
        {!isGroup && <div className="space-y-2"><p className="text-sm font-medium">{isSelf ? "Your address" : "Contact address"}</p><QrCodeCard value={conversationId} title={isSelf ? "Your address QR code" : "Contact address QR code"} /><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">View full public address</summary><p className="mt-2 select-all break-all rounded-[4px] bg-card p-3 font-mono text-xs text-muted-foreground">{conversationId}</p></details></div>}
        {!isGroup && !isSelf && <div className="border-t border-border pt-4"><Button variant="outline" className="text-destructive" disabled={actionBusy} onClick={() => void act(() => messaging.blockContact(conversationId, !blocked))}><Ban className="size-4" />{blocked ? "Unblock contact" : "Block contact"}</Button><p className="mt-2 text-xs text-muted-foreground">Blocking stops new direct messages from this address.</p></div>}
        {isSelf && <p className="text-sm leading-relaxed text-muted-foreground">This is a conversation with your own address. Send messages, files and links here to keep them together.</p>}
      </>}
    </div>{sendError && <p role="alert" className="text-sm text-destructive">{sendError}</p>}</DialogContent></Dialog>
  </div>
}
