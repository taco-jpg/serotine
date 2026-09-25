import { ProfileService } from "./profile-service"
import { validProfileWire } from "./profiles"
import { GROUP_INVITATION_MS, signGroupInvitation, signGroupAcceptance, validateGroupInvitation, validateGroupAcceptance, type GroupInvitationPreview, type GroupAdmissionStatus } from "./group-admission"
import { groupAdmissionRequest } from "./group-admission-client"
import { retentionDescriptor, retentionScopeId } from "./retention-protocol"
import { requestRetention } from "./retention-client"
import { CommunityService } from "./community-service"
import { communityOutboxError, communityChannelKey, isCommunityId, validateCommunityEvent } from "./community-protocol"
import { arrayBufferToHex, decryptFromPeer, encryptForPeer, importKey, verifySignature } from "./crypto"
import { loadContacts, saveContacts, shortAddress, validateAddress, type Contact, type Identity } from "./identity"
import { ID_PATTERN, isEnvelope, MAX_MESSAGE_LENGTH, PUBLIC_KEY_PATTERN } from "./protocol"
import { createRequestProof } from "./request-auth"
import { deleteMessage, getEventFeed, getLegacyInbox, storeEncryptedEvent } from "./relay-client"
import { deleteConversationHistoryFromStorage, deleteMessageHistoryFromStorage, exportAllMessagesFromStorage, migrateLegacyHistory } from "./storage"
import { createStoredEventReader, defaultMessagingPreferences, deleteStoredConversation, deleteStoredMessage, deleteStoredCommunityMessage, eventStorageKey, getMessagingPreferences, getSyncCursor, saveMessagingPreferences, saveStoredEvent, saveSyncCursor, saveCommunityUpgrade } from "./messaging-store"
import { isDeletedStoredEvent, isDeletedLegacyMessage } from "./messaging-history"
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_CHUNKS, isAttachmentMeta, prepareAttachment, assembleAttachment } from "./attachments"
import { DirectTransport } from "./direct-transport"
import { directSignaling } from "./direct-signaling"
import { DIRECT_FILE_BYTES, type DeliveryMode } from "./direct-protocol"
import { legacyMessageEvents, legacyStoredMessageId, legacyVisibleMessageIds } from "./legacy-messaging"
import { notifyIncoming, requestMessagingNotifications } from "./message-notifications"
import { isPrivateEventExpired, privateDestroyCutoffs } from "./private-messaging"
import { PRIVATE_CHAT_PLUGIN_ID, PluginNegotiation, PluginRegistry, validPluginCapabilities, type PluginAvailability, type PluginCapabilities } from "./plugins"
import { sharedMessagesFallback, sharedMessagesFromSelection, validSharedMessages, type SharedMessages, type ShareSource, type ShareDestination } from "./shared-messages"
import type { AttachmentMeta, ConversationRecord, EventKind, EventPayload, GroupState, MessageRecord, MessagingEvent, MessagingModel, MessagingPreferences, NotificationMode, PrivateTtlSeconds, StoredEvent } from "./messaging-types"

const MAX_MEMBERS = 20
const VISIBLE_KINDS = new Set(["message", "poll", "attachment", "private-message"])
const PRIVATE_KINDS = new Set(["private-settings", "private-message", "private-destroy"])
const GROUP_INVITATION_KINDS = new Set(["group-invite", "group-accept", "group-decline", "group-revoke"])
const EVENT_KINDS = new Set([...GROUP_INVITATION_KINDS, "group-dissolve","community", "message", "edit", "pin", "poll", "vote", "receipt", "group", "leave", "attachment", "attachment-chunk", "plugin-capabilities", "profile", ...PRIVATE_KINDS])
const PRIVATE_DURATIONS = new Set([0, 300, 3600, 86400])
const validGroupId = (value: string) => typeof value === "string" && value.startsWith("group:") && ID_PATTERN.test(value.slice(6))
const sameSet = (left: string[], right: string[]) => left.length === right.length && left.every(x => right.includes(x))
const validTime = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= Date.now() + 60_000
const validId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value)
const validText = (value: unknown, max = MAX_MESSAGE_LENGTH): value is string => typeof value === "string" && !!value.trim() && value.length <= max
function eventText(e: Omit<MessagingEvent, "signature"> | MessagingEvent) { return JSON.stringify(["serotine:event:v3", e.id, e.author, e.conversationId, e.recipients, e.timestamp, e.kind, e.payload, e.group ?? null, ...(e.route ? [e.route] : [])]) }
function groupText(g: Omit<GroupState, "signature"> | GroupState) { return JSON.stringify(g.protocol === 2 ? ["serotine:group:v4", g.id, g.name, g.admin, g.members, g.epoch, g.updatedAt, g.admissions ?? [], g.legacyMembers ?? [], g.consumedInvitations ?? [], g.deleted ?? false] : ["serotine:group:v3", g.id, g.name, g.admin, g.members, g.epoch, g.updatedAt]) }
async function signText(text: string, identity: Identity) {
  const key = await crypto.subtle.importKey("jwk", { ...identity.privateKey, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  return arrayBufferToHex(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(text)))
}
export async function signGroup(group: Omit<GroupState, "signature">, identity: Identity): Promise<GroupState> { return { ...group, signature: await signText(groupText(group), identity) } }
export async function signMessagingEvent(event: Omit<MessagingEvent, "signature">, identity: Identity): Promise<MessagingEvent> { return { ...event, signature: await signText(eventText(event), identity) } }
const verifiedGroups = new Map<string, string>()
export async function validateGroup(group: GroupState) {
  if (!group || !validGroupId(group.id) || !validText(group.name, 80) || !PUBLIC_KEY_PATTERN.test(group.admin) || !Array.isArray(group.members) || group.members.length < 1 || group.members.length > MAX_MEMBERS || !group.members.every(x => typeof x === "string" && PUBLIC_KEY_PATTERN.test(x)) || new Set(group.members).size !== group.members.length || !group.members.includes(group.admin) || !Number.isSafeInteger(group.epoch) || group.epoch < 1 || !validTime(group.updatedAt) || typeof group.signature !== "string" || !/^[0-9a-f]{128}$/.test(group.signature)) return false
  if (group.protocol !== undefined && group.protocol !== 2) return false
  if (group.protocol === 2) {
    if (!Array.isArray(group.admissions) || group.admissions.length > MAX_MEMBERS || !Array.isArray(group.legacyMembers) || group.legacyMembers.length !== 0
      || !group.legacyMembers.every(member => PUBLIC_KEY_PATTERN.test(member)) || new Set(group.legacyMembers).size !== group.legacyMembers.length
      || !Array.isArray(group.consumedInvitations) || group.consumedInvitations.length > 512 || !group.consumedInvitations.every(id => ID_PATTERN.test(id))
      || (group.deleted !== undefined && typeof group.deleted !== "boolean")) return false
    for (const admission of group.admissions) if (!await validateGroupAcceptance(admission) || admission.invitation.groupId !== group.id || admission.invitation.admin !== group.admin || !group.consumedInvitations.includes(admission.invitation.id)) return false
    if (new Set(group.admissions.map(a => a.invitation.invitee)).size !== group.admissions.length) return false
    if (group.members.some(member => member !== group.admin && !group.admissions!.some(a => a.invitation.invitee === member))) return false
  } else if (group.admissions !== undefined || group.legacyMembers !== undefined || group.consumedInvitations !== undefined || group.deleted !== undefined) return false
  const text = groupText(group)
  if (verifiedGroups.get(group.signature) === text) return true
  if (!await verifySignature(text, group.signature, group.admin)) return false
  if (verifiedGroups.size > 2000) verifiedGroups.clear()
  verifiedGroups.set(group.signature, text)
  return true
}
export function validAttachment(value: AttachmentMeta | undefined): value is AttachmentMeta { return isAttachmentMeta(value) && validId(value.id) }

function validPayload(kind: EventKind, p: EventPayload) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return false
  if (p.shared !== undefined && (kind !== "message" || !validSharedMessages(p.shared) || p.content !== sharedMessagesFallback(p.shared) || p.replyTo || p.mentions)) return false
  if (p.profile !== undefined && kind !== "profile") return false
  if (p.capabilities !== undefined && kind !== "plugin-capabilities") return false
  if (p.plugin !== undefined && (!PRIVATE_KINDS.has(kind) || p.plugin?.id !== PRIVATE_CHAT_PLUGIN_ID || p.plugin.version !== "1.0.0" || Object.keys(p.plugin).length !== 2)) return false
  if (!PRIVATE_KINDS.has(kind) && ["expiresAt", "secret", "ttlSeconds", "destroyBefore"].some(key => key in p)) return false
  if (p.replyTo !== undefined && !validId(p.replyTo)) return false
  if (p.mentions !== undefined && (!Array.isArray(p.mentions) || p.mentions.length > MAX_MEMBERS || !p.mentions.every(x => PUBLIC_KEY_PATTERN.test(x)))) return false
  switch (kind) {
    case "group-invite": return Object.keys(p).length === 1 && !!p.groupInvitation
    case "group-accept": return Object.keys(p).length === 1 && !!p.groupAcceptance
    case "group-decline": case "group-revoke": return Object.keys(p).length === 1 && !!p.invitation
    case "group-dissolve": return Object.keys(p).length === 0
    case "community": return Object.keys(p).length === 1 && !!p.community
    case "message": return validText(p.content)
    case "profile": return Object.keys(p).length === 1 && validProfileWire(p.profile)
    case "plugin-capabilities": return Object.keys(p).length === 1 && validPluginCapabilities(p.capabilities)
    case "private-message": return validText(p.content) && Number.isSafeInteger(p.expiresAt) && (p.secret === undefined || typeof p.secret === "boolean") && Object.keys(p).every(key => ["content", "expiresAt", "secret", "plugin"].includes(key))
    case "private-settings": return PRIVATE_DURATIONS.has(p.ttlSeconds!) && Object.keys(p).every(key => ["ttlSeconds", "plugin"].includes(key))
    case "private-destroy": return Number.isSafeInteger(p.destroyBefore) && p.destroyBefore! > 0 && Object.keys(p).every(key => ["destroyBefore", "plugin"].includes(key))
    case "edit": return validId(p.targetId) && validText(p.content)
    case "pin": return validId(p.targetId) && typeof p.pinned === "boolean"
    case "poll": return validText(p.question, 300) && Array.isArray(p.options) && p.options.length >= 2 && p.options.length <= 10 && p.options.every(x => validText(x, 120)) && new Set(p.options.map(x => x.trim().toLowerCase())).size === p.options.length
    case "vote": return validId(p.targetId) && Number.isInteger(p.option) && p.option! >= 0 && p.option! < 10
    case "receipt": return validId(p.targetId) && (p.receipt === "read" || p.receipt === "delivered")
    case "attachment": return validAttachment(p.attachment) && (p.content === undefined || (typeof p.content === "string" && p.content.length <= MAX_MESSAGE_LENGTH))
    case "attachment-chunk": return validId(p.attachmentId) && Number.isInteger(p.index) && p.index! >= 0 && p.index! < MAX_ATTACHMENT_CHUNKS && typeof p.data === "string" && p.data.length <= ATTACHMENT_CHUNK_BYTES * 4 / 3 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data)
    case "group": case "leave": return Object.keys(p).length === 0
    default: return false
  }
}
export function validLegacyMessagingEvent(e: MessagingEvent): boolean {
  if (!e || e.version !== 3 || e.group || !PUBLIC_KEY_PATTERN.test(e.author) || !PUBLIC_KEY_PATTERN.test(e.conversationId) || !validId(e.id)
    || !Array.isArray(e.recipients) || e.recipients.length !== 1 || e.recipients[0] !== e.conversationId || !Number.isSafeInteger(e.timestamp)) return false
  if (e.kind === "message") return typeof e.payload?.content === "string" && e.payload.content.length <= MAX_MESSAGE_LENGTH
  return (e.kind === "attachment" || e.kind === "attachment-chunk") && validPayload(e.kind, e.payload)
}
export async function validateMessagingEvent(value: unknown, transport?: { senderPubKey: string; recipientPubKey: string; id: string }): Promise<boolean> {
  try {
    const e = value as MessagingEvent
    if (!e || e.version !== 3 || !validId(e.id) || !PUBLIC_KEY_PATTERN.test(e.author) || !Array.isArray(e.recipients) || e.recipients.length < 1 || e.recipients.length > MAX_MEMBERS * 2 || !e.recipients.every(x => typeof x === "string" && PUBLIC_KEY_PATTERN.test(x)) || new Set(e.recipients).size !== e.recipients.length || !validTime(e.timestamp) || !EVENT_KINDS.has(e.kind) || !validPayload(e.kind, e.payload) || !/^[0-9a-f]{128}$/.test(e.signature) || JSON.stringify(e).length > 60000) return false
    if (transport && (e.author !== transport.senderPubKey || e.id !== transport.id || !e.recipients.includes(transport.recipientPubKey))) return false
    if (e.route !== undefined && (e.route !== "direct-only" || e.group || !PUBLIC_KEY_PATTERN.test(e.conversationId) || e.author === e.conversationId
      || !["message", "private-message", "private-settings", "private-destroy", "receipt", "attachment", "attachment-chunk", "plugin-capabilities"].includes(e.kind)
      || (e.kind === "attachment" && (!e.payload.attachment || e.payload.attachment.remote || e.payload.attachment.size > DIRECT_FILE_BYTES))
      || (e.kind === "attachment-chunk" && e.payload.index! >= Math.ceil(DIRECT_FILE_BYTES / ATTACHMENT_CHUNK_BYTES)))) return false
    if (e.kind === "community") return !e.group && await validateCommunityEvent(e) && await verifySignature(eventText(e), e.signature, e.author)
    // New event kinds make old clients reject temporary content instead of
    // silently retaining it as an ordinary message.
    if ((PRIVATE_KINDS.has(e.kind) || e.kind === "plugin-capabilities") && (e.group || !PUBLIC_KEY_PATTERN.test(e.conversationId) || e.author === e.conversationId)) return false
    if (e.kind === "profile" && (e.group || !PUBLIC_KEY_PATTERN.test(e.conversationId) || (e.payload.profile?.type === "sync") !== (e.author === e.conversationId))) return false
    if (e.kind === "private-message" && (e.payload.expiresAt! <= e.timestamp || e.payload.expiresAt! - e.timestamp > 86400_000)) return false
    if (e.kind === "private-destroy" && e.payload.destroyBefore! > e.timestamp) return false
    if (GROUP_INVITATION_KINDS.has(e.kind)) {
      const preview = e.payload.groupInvitation
      const invitation = preview?.invitation ?? e.payload.groupAcceptance?.invitation ?? e.payload.invitation
      if (e.group || !invitation || invitation.groupId !== e.conversationId || !await validateGroupInvitation(invitation)) return false
      if (e.kind === "group-invite" && (!preview || !validText(preview.name, 80) || !Number.isInteger(preview.memberCount) || preview.memberCount < 1 || preview.memberCount > MAX_MEMBERS || !Object.keys(preview).every(key => ["invitation", "name", "memberCount", "migration"].includes(key)) || (preview.migration !== undefined && preview.migration !== true))) return false
      if (e.kind === "group-accept" && !await validateGroupAcceptance(e.payload.groupAcceptance)) return false
      const fromAdmin = e.kind === "group-invite" || e.kind === "group-revoke"
      if (e.author !== (fromAdmin ? invitation.admin : invitation.invitee) || !sameSet(e.recipients, [fromAdmin ? invitation.invitee : invitation.admin])) return false
      return await verifySignature(eventText(e), e.signature, e.author)
    }
    if (validGroupId(e.conversationId)) {
      if (!e.group || e.group.id !== e.conversationId || !await validateGroup(e.group)) return false
      if (e.kind === "group" || e.kind === "group-dissolve") { if (e.author !== e.group.admin || !e.group.members.every(x => x === e.author || e.recipients.includes(x))) return false }
      else {
        if (e.group.deleted) return false
        if (!e.group.members.includes(e.author)) return false
        const expected = e.group.members.filter(x => x !== e.author)
        if (!sameSet(e.recipients, expected.length ? expected : [e.author])) return false
      }
      if (e.kind === "group-dissolve" && (e.group.protocol !== 2 || !e.group.deleted || e.author !== e.group.admin)) return false
    } else if (!PUBLIC_KEY_PATTERN.test(e.conversationId) || e.group || e.kind === "group" || e.kind === "group-dissolve" || e.kind === "leave" || e.recipients.length !== 1 || e.recipients[0] !== e.conversationId) return false
    return await verifySignature(eventText(e), e.signature, e.author)
  } catch { return false }
}
export function conversationForEvent(event: MessagingEvent, owner: string): string {
  return validGroupId(event.conversationId) || isCommunityId(event.conversationId) ? event.conversationId : event.author === owner ? event.conversationId : event.author
}
function outboxStatus(record: StoredEvent) {
  if (!record.local) return "received" as const
  return record.event.recipients.every(x => record.delivered.includes(x)) ? record.event.route === "direct-only" ? "delivered" as const : "sent" as const : record.error || record.event.route === "direct-only" ? "failed" as const : "pending" as const
}
function canSendTo(record: StoredEvent, peer: string) {
  // Older failed records have no per-recipient detail and still need an
  // explicit retry. New failures leave other destinations free to continue.
  return !record.delivered.includes(peer) && (!record.error || (!!record.failedRecipients && !record.failedRecipients.includes(peer)))
}
export function isMultiPersonReceipt(event: MessagingEvent) {
  return (event.kind === "receipt" && validGroupId(event.conversationId)) || (event.kind === "community" && event.payload.community?.type === "receipt")
}
function isAttachmentChunk(event: MessagingEvent) {
  return event.kind === "attachment-chunk" || (event.kind === "community" && event.payload.community?.type === "attachment-chunk")
}
function compareOutbox(left: StoredEvent, right: StoredEvent) {
  // A short message must not wait behind hundreds of already queued file pieces.
  return Number(isAttachmentChunk(left.event)) - Number(isAttachmentChunk(right.event)) || left.receivedAt - right.receivedAt
}
/** Only validated immutable events may enter this reducer. Authority is checked again for controls. */
export function buildMessagingModel(records: StoredEvent[], owner: string, contacts: Contact[], preferences: MessagingPreferences, authorizedOutput?: Set<string>, includeDeletedConversations = false): MessagingModel {
  const now = Date.now()
  const destroyCutoffs = privateDestroyCutoffs(records, owner)
  const privateSettings = new Map<string, MessagingEvent>()
  const invitations = new Map<string, GroupInvitationPreview>()
  const invitationStates = new Map<string, "pending" | "joining" | "resolved">()
  for (const record of records) {
    const event = record.event
    if (event.kind === "group-invite" && event.payload.groupInvitation && event.payload.groupInvitation.invitation.invitee === owner) {
      invitations.set(event.payload.groupInvitation.invitation.id, event.payload.groupInvitation)
    }
    const invitation = event.payload.groupAcceptance?.invitation ?? event.payload.invitation
    if (event.kind === "group-accept" && invitation?.invitee === owner && !invitationStates.has(invitation.id)) invitationStates.set(invitation.id, "joining")
    if ((event.kind === "group-revoke" || event.kind === "group-decline") && invitation) invitationStates.set(invitation.id, "resolved")
  }
  const terminalGroups = new Set([...(preferences.terminatedGroups ?? []), ...(preferences.closedRetention ?? [])])
  for (const record of records) if (record.event.group?.deleted && record.event.author === record.event.group.admin) terminalGroups.add(record.event.group.id)

  const groups = new Map<string, GroupState>()
  const createdAt = new Map<string, number>()
  const left = new Map<string, Set<string>>()
  for (const [cid, deletion] of Object.entries(preferences.deleted ?? {})) if (deletion.group) {
    groups.set(cid, deletion.group)
    left.set(cid, new Set(deletion.leftMembers ?? []))
  }
  const messages = new Map<string, MessageRecord>()
  const authorized = authorizedOutput ?? new Set<string>()
  authorized.clear()
  const controls: StoredEvent[] = []
  const checkpoints: StoredEvent[] = Object.entries(preferences.deletedMessages ?? {}).flatMap(([cid, deletion]) => (deletion.groupEvents ?? []).map(checkpoint => ({
    key: checkpoint.key, receivedAt: checkpoint.receivedAt, sequence: checkpoint.sequence, local: false, delivered: [],
    event: { version: 3, id: checkpoint.key.slice(checkpoint.key.lastIndexOf(":") + 1), author: checkpoint.group.admin, conversationId: cid, recipients: [owner], timestamp: checkpoint.timestamp, kind: "group", payload: {}, group: checkpoint.group, signature: "" },
  })))
  const ordered = [...records, ...checkpoints].sort((a, b) => a.receivedAt - b.receivedAt || (a.sequence && b.sequence ? a.sequence - b.sequence : 0) || a.event.timestamp - b.event.timestamp || a.key.localeCompare(b.key))
  for (const record of ordered) {
    const e = record.event, cid = conversationForEvent(e, owner)
    if (GROUP_INVITATION_KINDS.has(e.kind)) { if (record.local && e.author === owner) authorized.add(record.key); continue }
    if (e.kind === "community" || e.kind === "plugin-capabilities" || e.kind === "profile" || isMultiPersonReceipt(e)) continue
    if (isDeletedStoredEvent(record, owner, preferences)) continue
    if (e.author !== owner && preferences.blocked.includes(e.author)) continue
    if (PRIVATE_KINDS.has(e.kind) && (record.legacy || e.group || e.author === e.conversationId || (e.author !== owner && (e.conversationId !== owner || !e.recipients.includes(owner))))) continue
    if (isPrivateEventExpired(record, owner, destroyCutoffs, now)) continue
    if (e.group) {
      const prior = groups.get(cid)
      if (prior && prior.admin !== e.group.admin) continue
      // A protocol upgrade cannot manufacture new grandfathered members.
      if (e.group.protocol === 2 && e.group.legacyMembers?.length && prior
        && e.group.legacyMembers.some(member => !(prior.protocol === 2 ? prior.legacyMembers ?? [] : prior.members).includes(member))) continue
      if (prior?.protocol === 2 && e.group.protocol !== 2) continue
      if (prior?.protocol === 2 && e.group.epoch > prior.epoch && prior.consumedInvitations?.some(id => !e.group!.consumedInvitations?.includes(id))) continue
      // A removed member must accept a fresh invitation; a prior signature cannot re-add them.
      if (prior?.protocol === 2 && e.group.epoch > prior.epoch && e.group.admissions?.some(admission =>
        !prior.members.includes(admission.invitation.invitee) && prior.consumedInvitations?.includes(admission.invitation.id))) continue
      if (prior && e.group.epoch < prior.epoch) continue
      if (!prior || e.group.epoch > prior.epoch) { groups.set(cid, e.group); left.set(cid, new Set()) }
      else if (JSON.stringify(prior) !== JSON.stringify(e.group)) continue
      if (e.group.deleted) { groups.set(cid, e.group); left.set(cid, new Set(e.group.members)); authorized.add(record.key); continue }
      const ownerConsented = owner === e.group.admin || e.group.admissions?.some(a => a.invitation.invitee === owner)
        || preferences.accepted.includes(cid) || records.some(row => row.event.author === owner && row.event.conversationId === cid && VISIBLE_KINDS.has(row.event.kind))
      if (e.kind !== "group" && !ownerConsented) continue
      if (e.kind !== "group" && (!e.group.members.includes(owner) || left.get(cid)?.has(e.author) || left.get(cid)?.has(owner))) continue
      if (e.kind === "leave") { authorized.add(record.key); if (e.author === e.group.admin) e.group.members.forEach(member => left.get(cid)?.add(member)); else left.get(cid)?.add(e.author); continue }
    }
    authorized.add(record.key)
    // The earliest authorized group snapshot is its local creation boundary.
    // Later names, membership, and timers are state changes, not chat activity.
    if (e.group && !createdAt.has(cid)) createdAt.set(cid, e.group.updatedAt)
    if (e.kind === "group" || e.kind === "group-dissolve") continue
    if (e.kind === "private-settings") {
      const prior = privateSettings.get(cid)
      if (!prior || e.timestamp > prior.timestamp || (e.timestamp === prior.timestamp && e.id.localeCompare(prior.id) > 0)) privateSettings.set(cid, e)
      continue
    }
    if (e.kind === "private-destroy") continue
    const key = `${cid}:${e.id}`
    if (VISIBLE_KINDS.has(e.kind)) {
      if (messages.has(key)) continue
      messages.set(key, { id: e.id, conversationId: cid, route: e.route, senderPubKey: e.author, content: e.payload.content ?? (e.kind === "poll" ? e.payload.question! : ""), timestamp: e.timestamp, delivery: record.legacy && e.author === owner ? "sent" : outboxStatus(record), replyTo: e.payload.replyTo, pinned: false, attachment: e.payload.attachment, shared: e.payload.shared, poll: e.kind === "poll" ? { question: e.payload.question!, options: [...e.payload.options!], votes: {} } : undefined, mentions: e.payload.mentions, error: record.error ?? (e.route === "direct-only" && record.local && outboxStatus(record) === "failed" ? "Direct delivery unconfirmed. Retry directly while both people are connected." : undefined), deliveredTo: [], readBy: [], ...(e.kind === "private-message" ? { private: true, expiresAt: e.payload.expiresAt, secret: e.payload.secret ?? false } : {}) })
      continue
    }
    controls.push(record)
  }
  // Controls can arrive ahead of their target across devices or relay pages.
  for (const record of controls) {
    const e = record.event, cid = conversationForEvent(e, owner)
    const target = e.payload.targetId ? messages.get(`${cid}:${e.payload.targetId}`) : undefined
    if (!target) continue
    if (e.kind === "edit" && !target.private && target.senderPubKey === e.author && !target.poll && !target.attachment && !target.shared && (!target.editedAt || e.timestamp >= target.editedAt)) { target.content = e.payload.content!; target.editedAt = e.timestamp }
    if (e.kind === "pin" && !target.private) target.pinned = e.payload.pinned!
    if (e.kind === "vote" && target.poll && e.payload.option! < target.poll.options.length) target.poll.votes[e.author] = e.payload.option!
    if (e.kind === "receipt" && !e.group && target.senderPubKey === owner && e.author !== owner) {
      if (!target.deliveredTo.includes(e.author)) target.deliveredTo.push(e.author)
      if (e.payload.receipt === "read" && !target.readBy.includes(e.author)) target.readBy.push(e.author)
      target.delivery = target.readBy.length ? "read" : "delivered"
    }
  }
  // Never turn a temporary message into a lasting reply preview.
  const privateTargets = new Set(records.filter(r => r.event.kind === "private-message").map(r => `${conversationForEvent(r.event, owner)}:${r.event.id}`))
  for (const message of messages.values()) if (message.replyTo && privateTargets.has(`${message.conversationId}:${message.replyTo}`)) message.replyTo = undefined
  // Legacy files wait for their chunk events. Remote files publish ciphertext before metadata.
  for (const message of messages.values()) if (message.attachment && !message.attachment.remote && message.senderPubKey === owner) {
    const chunks = ordered.filter(r => authorized.has(r.key) && r.event.kind === "attachment-chunk" && r.event.author === owner && conversationForEvent(r.event, owner) === message.conversationId && r.event.payload.attachmentId === message.attachment!.id)
    if (new Set(chunks.map(r => r.event.payload.index)).size < message.attachment.chunks) message.delivery = "pending"
    else if (chunks.some(r => outboxStatus(r) === "failed")) { message.delivery = "failed"; message.error = chunks.find(r => r.error)?.error }
    else if (chunks.some(r => outboxStatus(r) === "pending")) message.delivery = "pending"
  }
  const list = [...messages.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  // Receipts and group controls can fail without producing a message bubble.
  // Keep their delivery errors with the affected conversation, not the inbox.
  const sendErrors = new Map<string, string>()
  for (const record of ordered) if (authorized.has(record.key) && outboxStatus(record) === "failed") {
    sendErrors.set(conversationForEvent(record.event, owner), record.error!)
  }
  const ids = new Set([owner, ...contacts.map(c => c.pub), ...groups.keys(), ...privateSettings.keys(), ...list.map(m => m.conversationId), ...preferences.accepted, ...sendErrors.keys()])
  const conversations: ConversationRecord[] = [...ids].filter(id => includeDeletedConversations || !preferences.deleted?.[id] || list.some(message => message.conversationId === id)).map((id): ConversationRecord => {
    const group = groups.get(id)
    const rows = list.filter(m => m.conversationId === id)
    const latest = rows.at(-1)
    const lastMessage = latest?.private ? { ...latest, content: latest.secret ? "Access key" : "Private message" } : latest
    const known = id === owner || contacts.some(c => c.pub === id) || preferences.accepted.includes(id) || rows.some(m => m.senderPubKey === owner) || group?.admin === owner
    const blocked = preferences.blocked.includes(id) || !!(group && preferences.blocked.includes(group.admin))
    const activityAt = lastMessage?.timestamp ?? createdAt.get(id) ?? 0
    return { id, kind: group ? "group" : id === owner ? "self" : "direct", name: group?.name ?? (id === owner ? "You" : contacts.find(c => c.pub === id)?.alias || shortAddress(id)), members: group ? terminalGroups.has(id) ? [] : group.members.filter(x => !left.get(id)?.has(x)) : id === owner ? [owner] : [owner, id], unreadCount: blocked ? 0 : rows.filter(m => m.senderPubKey !== owner && m.timestamp > (preferences.readAt[id] ?? 0)).length, lastMessage, updatedAt: activityAt, activityAt, notificationMode: preferences.notifications[id] ?? "all", blocked, request: !known && !blocked && !terminalGroups.has(id), archived: preferences.archived?.includes(id) ?? false, group, sendError: sendErrors.get(id), privateTtlSeconds: privateSettings.get(id)?.payload.ttlSeconds }
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  for (const [id, preview] of invitations) {
    const invitation = preview.invitation, state = invitationStates.get(id)
    if (state === "resolved" || invitation.expiresAt <= now || terminalGroups.has(invitation.groupId) || preferences.blocked.includes(invitation.admin)) continue
    const current = conversations.find(item => item.id === invitation.groupId)
    if (current?.group?.members.includes(owner) && current.group.admissions?.some(a => a.invitation.id === id)) continue
    if (current && !current.request && current.members.includes(owner)) continue
    const pending: ConversationRecord = { id: invitation.groupId, kind: "group", name: preview.name, members: [], unreadCount: 0,
      updatedAt: invitation.createdAt, activityAt: invitation.createdAt, notificationMode: "all", blocked: false, request: true, archived: false, invitation: preview, invitationStatus: state === "joining" ? "joining" : "pending" }
    const index = conversations.findIndex(item => item.id === pending.id)
    if (index < 0) conversations.push(pending); else conversations[index] = pending
  }
  return { messages: list, groups: [...groups.values()], conversations, requests: conversations.filter(c => c.request && !c.archived) }
}

export class MessagingEngine {
  readonly identity: Identity
  private readonly pluginRegistry: PluginRegistry
  private readonly pluginNegotiation = new PluginNegotiation()
  private readonly groupAdmissionChecked = new Map<string, number>()
  private readonly groupAdmissionStates = new Map<string, GroupAdmissionStatus>()
  private readonly observedCapabilities = new Set<string>()
  private readonly direct: DirectTransport
  private directTimer?: ReturnType<typeof setInterval>
  private directPolling = false
  private directFileSending = false
  private directFiles = new Map<string, { attachmentId: string; events: MessagingEvent[]; bytes: number; until: number }>()
  contacts: Contact[] = []
  records: StoredEvent[] = []
  preferences = defaultMessagingPreferences()
  model: MessagingModel = { conversations: [], messages: [], groups: [], requests: [] }
  status: "connecting" | "online" | "offline" = "connecting"
  error: string | null = null
  private running = false
  private syncRequested = false
  private communityReads = new Set<string>()
  private outboxRetryAt = 0
  private disposed = false
  private listeners = new Set<() => void>()
  private key?: CryptoKey
  private timer?: ReturnType<typeof setInterval>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private expiryTimer?: ReturnType<typeof setTimeout>
  private refreshGeneration = 0
  private refreshCompletion?: Promise<void>
  private refreshPending = false
  private queuedRevision = 0
  private readonly storedEvents: ReturnType<typeof createStoredEventReader>
  private preferencesText = ""
  private retentionSyncOffset = 0
  private contactsText = ""
  private initializedAt = Date.now()
  private authorizedKeys = new Set<string>()
  private pluginStorageListener = (event: StorageEvent) => {
    if (this.disposed || (event.key !== null && event.key !== `serotine.plugins.v1:${this.identity.publicKey}`)) return
    const privateEnabled = this.pluginRegistry.enabled(PRIVATE_CHAT_PLUGIN_ID)
    this.pluginRegistry.reload()
    this.emit()
    if (privateEnabled !== this.pluginRegistry.enabled(PRIVATE_CHAT_PLUGIN_ID)) {
      this.pluginNegotiation.revoke()
      void this.broadcastPluginChange().catch(error => this.fail(error))
    }
  }
  private storeListener = () => {
    if (this.disposed) return
    this.refreshPending = true
    clearTimeout(this.refreshTimer)
    if (this.running) return
    this.refreshTimer = setTimeout(() => {
      if (this.disposed || this.running) return
      this.refreshPending = false
      void this.refresh().catch(error => this.fail(error))
    }, 40)
  }
  readonly profiles: ProfileService
  readonly communities: CommunityService
  constructor(identity: Identity) {
    this.identity = identity
    this.pluginRegistry = new PluginRegistry(identity.publicKey)
    this.profiles = new ProfileService({ relationshipBoundary: peer => this.preferences.relationshipBoundaries?.[peer] ?? 0, canSend: peer => this.getDeliveryMode(peer) !== "direct-only", owner: identity.publicKey, trusted: peer => this.trustedPluginPeer(peer), peers: () => [...new Set([...this.contacts.map(contact => contact.pub), ...this.preferences.accepted])].filter(peer => this.trustedPluginPeer(peer)), send: (peer, wire) => this.sendEvent(peer, "profile", { profile: wire }), changed: () => this.emit(), assertActive: () => this.assertActive() })
    this.direct = new DirectTransport(identity, {
      signal: async signal => { await directSignaling(identity, "direct:signal", { signal }) },
      event: event => this.receiveDirectEvent(event),
      allowed: peer => !this.disposed && this.getDeliveryMode(peer) === "direct-only" && this.trustedPluginPeer(peer),
      changed: () => this.emit(),
    })
    this.storedEvents = createStoredEventReader(identity.publicKey)
    this.communities = new CommunityService({
      identity, records: () => this.records, preferences: () => this.preferences,
      refresh: () => this.refresh(), assertActive: () => this.assertActive(),
      sign: event => signMessagingEvent(event, identity),
      queue: async event => {
        this.assertActive()
        if (!this.key) throw new Error("Your identity is still loading.")
        if (!await validateMessagingEvent(event)) throw new Error("The community event is invalid.")
        await this.queue(event)
      },
      queueBatch: async events => {
        this.assertActive()
        if (!this.key) throw new Error("Your identity is still loading.")
        const receivedAt = Date.now()
        await saveCommunityUpgrade(identity.publicKey, events.map((event, index) => ({
          key: eventStorageKey(event), event, local: true, delivered: [], receivedAt: receivedAt + index,
        })))
        this.assertActive()
        try { await this.refresh() } catch (error) { this.fail(error) }
        this.queuedRevision++
        this.requestSync()
      },
    })
  }
  getDeliveryMode = (cid: string): DeliveryMode => {
    try { if (typeof localStorage !== "undefined" && localStorage.getItem(`serotine.direct.v1:${this.identity.publicKey}:${cid}`) === "1") return "direct-only" } catch { return "direct-only" }
    return this.preferences.directOnly?.includes(cid) ? "direct-only" : "relay"
  }
  setDeliveryMode = async (cid: string, mode: DeliveryMode) => {
    this.assertActive()
    if (!["relay", "direct-only"].includes(mode) || !this.trustedPluginPeer(cid)) throw new Error("Choose an accepted, unblocked direct contact.")
    const key = `serotine.direct.v1:${this.identity.publicKey}:${cid}`
    // The synchronous fence stops a relay send already preparing in another tab.
    if (mode === "direct-only") localStorage.setItem(key, "1")
    else this.direct.disconnect(cid)
    await this.updatePreferences(p => ({ ...p, directOnly: mode === "direct-only" ? [...new Set([...(p.directOnly ?? []), cid])] : (p.directOnly ?? []).filter(peer => peer !== cid) }))
    if (mode === "relay") localStorage.removeItem(key)
    this.emit()
  }
  getDirectStatus = (cid: string) => this.direct.status(cid)
  connectDirect = async (cid: string) => { this.assertActive(); await this.refresh(); await this.direct.connect(cid); await this.pollDirect() }
  private pollDirect = async () => {
    if (this.disposed || this.directPolling) return
    const peers = [...new Set([...(this.preferences.directOnly ?? []), ...this.contacts.map(contact => contact.pub), ...this.preferences.accepted])].filter(peer => this.getDeliveryMode(peer) === "direct-only" && this.trustedPluginPeer(peer)).slice(0, 100)
    if (!peers.length) return
    this.directPolling = true
    try {
      for (const [peer, file] of this.directFiles) if (file.until < Date.now()) this.directFiles.delete(peer)
      for (const signal of await directSignaling(this.identity, "direct:poll", { peers })) await this.direct.receiveSignal(signal)
    } catch { /* Connection deadlines surface setup failure without changing relay status. */ }
    finally { this.directPolling = false }
  }
  private receiveDirectEvent = async (event: MessagingEvent) => {
    this.assertActive()
    if (event.route !== "direct-only" || this.getDeliveryMode(event.author) !== "direct-only" || !this.trustedPluginPeer(event.author) || !await validateMessagingEvent(event)) throw new Error("The direct event could not be authenticated.")
    const owner = this.identity.publicKey
    const record = (e: MessagingEvent): StoredEvent => ({ key: eventStorageKey(e), event: e, local: false, delivered: [], receivedAt: Date.now() })
    if (event.kind === "attachment-chunk") {
      const id = event.payload.attachmentId!, prior = this.directFiles.get(event.author)
      if (prior && prior.attachmentId !== id && prior.until > Date.now()) throw new Error("Finish the current direct file before sending another.")
      const file = prior?.attachmentId === id ? prior : { attachmentId: id, events: [], bytes: 0, until: Date.now() + 60000 }
      const duplicate = file.events.find(item => item.payload.index === event.payload.index)
      if (duplicate) { if (duplicate.signature !== event.signature) throw new Error("Conflicting direct file piece."); return }
      const bytes = atob(event.payload.data!).length
      if (file.bytes + bytes > DIRECT_FILE_BYTES || file.events.length >= Math.ceil(DIRECT_FILE_BYTES / ATTACHMENT_CHUNK_BYTES)) throw new Error("Direct files are limited to 2 MiB.")
      file.events.push(event); file.bytes += bytes; file.until = Date.now() + 60000; this.directFiles.set(event.author, file); return
    }
    if (event.kind === "attachment") {
      const existing = this.records.find(row => row.event.id === event.id && row.event.author === event.author)
      if (existing) {
        if (existing.event.signature !== event.signature) throw new Error("Conflicting direct file identifier.")
        if (this.directFiles.get(event.author)?.attachmentId === event.payload.attachment!.id) this.directFiles.delete(event.author)
        return
      }
      const file = this.directFiles.get(event.author)
      if (!file || file.attachmentId !== event.payload.attachment!.id) throw new Error("Direct file is incomplete. Retry the file directly.")
      await assembleAttachment(event.payload.attachment!, file.events.map(item => ({ index: item.payload.index!, data: item.payload.data! })))
      for (const piece of file.events) await saveStoredEvent(owner, record(piece))
      this.directFiles.delete(event.author)
    }
    const existing = this.records.some(row => row.event.id === event.id && row.event.author === event.author)
    if (await saveStoredEvent(owner, record(event)) === false) throw new Error("The direct content expired or was deleted before acknowledgement.")
    await this.refresh()
    if (!existing && VISIBLE_KINDS.has(event.kind)) {
      const message = this.model.messages.find(item => item.id === event.id), conversation = this.model.conversations.find(item => item.id === event.author)
      if (message && conversation) void notifyIncoming(message, conversation, owner)
    }
  }
  sendDirectFile = async (cid: string, file: File, signal?: AbortSignal, onProgress?: (percent: number) => void) => {
    this.assertActive()
    if (this.directFileSending) throw new Error("Wait for the current direct file to finish.")
    if (this.getDeliveryMode(cid) !== "direct-only" || this.getDirectStatus(cid).state !== "connected") throw new Error("Establish a direct connection before sending a file.")
    if (file.size > DIRECT_FILE_BYTES) throw new Error("Force P2P supports files up to 2 MiB. This file has not been uploaded.")
    if (this.getPrivateMode(cid)) throw new Error("Turn off private mode before sending files.")
    this.directFileSending = true
    try {
      const prepared = await prepareAttachment(file), timestamp = Date.now(), owner = this.identity.publicKey
      const events: MessagingEvent[] = []
      for (const chunk of prepared.chunks) events.push(await signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: owner, conversationId: cid, recipients: [cid], timestamp, kind: "attachment-chunk", route: "direct-only", payload: { attachmentId: prepared.metadata.id, ...chunk } }, this.identity))
      const message = await signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: owner, conversationId: cid, recipients: [cid], timestamp, kind: "attachment", route: "direct-only", payload: { attachment: prepared.metadata } }, this.identity)
      const record = (event: MessagingEvent): StoredEvent => ({ key: eventStorageKey(event), event, local: true, delivered: [], receivedAt: Date.now() })
      for (const event of [...events, message]) {
        this.assertActive()
        if (!await validateMessagingEvent(event) || await saveStoredEvent(owner, record(event)) === false) throw new Error("The direct file could not be saved locally.")
      }
      await this.refresh()
      try {
        for (let index = 0; index < events.length; index++) {
          if (signal?.aborted) throw new Error("Direct transfer cancelled. Incomplete received pieces expire after one minute. Retry this file directly when ready.")
          await this.deliverDirect(record(events[index]))
          onProgress?.(Math.round((index + 1) * 95 / events.length))
        }
        if (signal?.aborted) throw new Error("Direct transfer cancelled.")
        await this.deliverDirect(record(message)); onProgress?.(100); return message.id
      } catch (error) {
        await saveStoredEvent(owner, { ...record(message), error: error instanceof Error ? error.message : "Direct file incomplete. Retry directly.", failedRecipients: [cid] })
        await this.refresh(); throw error
      }
    } finally { this.directFileSending = false }
  }
  private async deliverDirect(record: StoredEvent) {
    if (record.event.route !== "direct-only") throw new Error("This message was not created for direct delivery.")
    this.assertPrivatePlugin(record.event.conversationId, record.event.kind, record.event.payload)
    try {
      await this.direct.send(record.event.conversationId, record.event)
      await saveStoredEvent(this.identity.publicKey, { ...record, delivered: [...record.event.recipients], error: undefined, failedRecipients: undefined })
    } catch (error) {
      await saveStoredEvent(this.identity.publicKey, { ...record, error: error instanceof Error ? error.message : "Direct delivery unconfirmed. Retry directly.", failedRecipients: [...record.event.recipients] })
      throw error
    } finally { await this.refresh() }
  }
  get plugins() { return this.pluginRegistry.states }
  private trustedPluginPeer(cid: string, preferences = this.preferences) {
    return PUBLIC_KEY_PATTERN.test(cid) && cid !== this.identity.publicKey && !preferences.blocked.includes(cid)
      && (loadContacts(this.identity.publicKey).some(contact => contact.pub === cid) || preferences.accepted.includes(cid))
  }
  getPluginAvailability = (id: string, cid: string): PluginAvailability => {
    if (this.disposed) return { available: false, peerStatus: "local", reason: "Your identity changed. Reopen this conversation before continuing." }
    this.pluginRegistry.reload()
    const state = this.plugins.find(plugin => plugin.manifest.id === id)
    if (!state?.enabled) return { available: false, peerStatus: "local", reason: "Enable this plugin and approve its permissions in Settings → Plugins." }
    if (!state.manifest.shared) return { available: true, peerStatus: "local", reason: "This plugin runs only when you request it." }
    if (!this.trustedPluginPeer(cid)) return { available: false, peerStatus: "unavailable", reason: "Private Chat requires an unblocked contact or accepted direct conversation." }
    return this.pluginNegotiation.availability(cid, state.manifest)
  }
  private async advertiseCapabilities(cid: string, extra: Pick<PluginCapabilities, "request" | "responseTo"> = {}) {
    this.pluginRegistry.reload()
    await this.sendEvent(cid, "plugin-capabilities", { capabilities: this.pluginNegotiation.advertise(this.pluginRegistry.advertised(), extra) })
  }
  refreshPeerCapabilities = async (cid: string) => {
    this.assertActive()
    await this.refresh()
    if (!this.trustedPluginPeer(cid)) throw new Error("Add or accept this contact before checking plugin compatibility.")
    const request = this.pluginNegotiation.challenge(cid)
    if (request) { this.emit(); await this.advertiseCapabilities(cid, { request }) }
    await this.sync()
  }
  private async broadcastPluginChange() {
    this.pluginNegotiation.revoke()
    this.emit()
    const peers = [...new Set([...this.contacts.map(contact => contact.pub), ...this.preferences.accepted])].filter(cid => this.trustedPluginPeer(cid))
    for (const cid of peers) {
      this.assertActive()
      const request = this.pluginRegistry.enabled(PRIVATE_CHAT_PLUGIN_ID) ? this.pluginNegotiation.challenge(cid) : undefined
      await this.advertiseCapabilities(cid, request ? { request } : {})
    }
  }
  setPluginEnabled = async (id: string, enabled: boolean, grantPermissions = false) => {
    this.assertActive()
    this.pluginRegistry.setEnabled(id, enabled, grantPermissions)
    this.emit()
    if (id === PRIVATE_CHAT_PLUGIN_ID) await this.broadcastPluginChange()
  }
  removePlugin = async (id: string) => {
    this.assertActive()
    this.pluginRegistry.remove(id)
    this.emit()
    if (id === PRIVATE_CHAT_PLUGIN_ID) await this.broadcastPluginChange()
  }
  private async observePluginCapabilities() {
    for (const record of this.records) {
      const event = record.event
      if (event.kind !== "plugin-capabilities" || event.author === this.identity.publicKey || record.legacy
        || event.conversationId !== this.identity.publicKey || !this.trustedPluginPeer(event.author)) continue
      const key = `${record.key}:${event.signature}`
      if (this.observedCapabilities.has(key)) continue
      if (!await validateMessagingEvent(event)) continue
      this.observedCapabilities.add(key)
      this.pluginNegotiation.observe(event.author, event.payload.capabilities!, event.timestamp)
    }
  }
  private async respondPluginCapabilities() {
    for (const record of this.records) {
      const event = record.event
      if (event.kind !== "plugin-capabilities" || !this.observedCapabilities.has(`${record.key}:${event.signature}`)
        || !this.trustedPluginPeer(event.author)) continue
      const capabilities = event.payload.capabilities!
      if (!this.pluginNegotiation.shouldRespond(event.author, capabilities, event.timestamp)) continue
      await this.advertiseCapabilities(event.author, { responseTo: capabilities.request })
      // The requester and responder each need their own fresh challenge.
      if (this.pluginRegistry.enabled(PRIVATE_CHAT_PLUGIN_ID) && !this.getPluginAvailability(PRIVATE_CHAT_PLUGIN_ID, event.author).available) {
        const request = this.pluginNegotiation.challenge(event.author)
        if (request) await this.advertiseCapabilities(event.author, { request })
      }
    }
  }
  private assertPrivatePlugin(cid: string, kind: EventKind, payload: EventPayload, preferences = this.preferences) {
    if (kind !== "private-message" && !(kind === "private-settings" && payload.ttlSeconds)) return
    const availability = this.getPluginAvailability(PRIVATE_CHAT_PLUGIN_ID, cid)
    if (!availability.available) throw new Error(availability.reason + " Your private message was not sent.")
    if (!this.trustedPluginPeer(cid, preferences)) throw new Error("Private Chat requires an unblocked contact or accepted direct conversation. Your private message was not sent.")
  }
  markCommunityRead = async (cid: string, channelId: string) => {
    this.assertActive()
    if (typeof document !== "undefined" && (document.visibilityState !== "visible" || !document.hasFocus())) return
    const community = this.communities.model.communities.find(item => item.id === cid && item.joined && !item.deleted)
    if (!community?.channels.some(channel => channel.id === channelId)) return
    const key = communityChannelKey(cid, channelId)
    const messages = this.communities.model.messages.filter(message => message.conversationId === cid && message.channelId === channelId && !message.hidden && message.senderPubKey !== this.identity.publicKey)
    const latest = Math.max(0, ...messages.map(message => message.timestamp))
    if (latest > (this.preferences.readAt[key] ?? 0)) await this.updatePreferences(p => ({ ...p, readAt: { ...p.readAt, [key]: Math.max(latest, p.readAt[key] ?? 0) } }))
  }
  deleteCommunityMessage = async (cid: string, channelId: string, messageId: string) => {
    this.assertActive()
    const message = this.communities.model.messages.find(item => item.conversationId === cid && item.channelId === channelId && item.id === messageId)
    if (!message) throw new Error("This channel message is no longer available.")
    await deleteStoredCommunityMessage(this.identity.publicKey, cid, channelId, messageId)
    this.assertActive()
    await this.refresh()
  }
  archiveCommunity = async (cid: string, archived = true) => {
    this.assertActive()
    if (!this.communities.model.communities.some(item => item.id === cid && item.joined && !item.deleted)) throw new Error("This community is no longer available.")
    await this.updatePreferences(p => ({ ...p, archived: archived ? [...new Set([...(p.archived ?? []), cid])] : (p.archived ?? []).filter(id => id !== cid) }))
  }
  private requestSync() {
    if (this.running) this.syncRequested = true
    else void this.sync()
  }
  subscribe = (listener: () => void) => { this.assertActive(); this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private assertActive() { if (this.disposed) throw new Error("Your identity changed. Reopen this conversation before continuing.") }
  private emit() { if (!this.disposed) this.listeners.forEach(listener => listener()) }
  private fail(error: unknown) { if (this.disposed) return; this.error = error instanceof Error ? error.message : "Messages could not be synchronized."; this.status = "offline"; this.emit() }
  async start() {
    this.assertActive()
    this.key = await importKey(this.identity.privateKey, "encryption", "private")
    if (this.disposed) { this.key = undefined; return }
    await migrateLegacyHistory(this.identity.publicKey)
    if (this.disposed) return
    await this.migrateLocalHistory()
    if (this.disposed) return
    await this.refresh()
    if (this.disposed) return
    window.addEventListener("serotine:events", this.storeListener)
    window.addEventListener("serotine:contacts", this.storeListener)
    window.addEventListener("storage", this.storeListener)
    window.addEventListener("storage", this.pluginStorageListener)
    window.addEventListener("online", this.sync)
    window.addEventListener("focus", this.sync)
    this.timer = setInterval(() => { void this.sync() }, 5000)
    this.directTimer = setInterval(() => { void this.pollDirect() }, 2000)
    void this.pollDirect()
    void this.sync()
  }
  dispose() { this.direct.dispose(); this.directFiles.clear(); clearInterval(this.directTimer); this.disposed = true; this.profiles.dispose(); this.key = undefined; this.pluginNegotiation.revoke(); this.storedEvents.dispose(); clearInterval(this.timer); clearTimeout(this.refreshTimer); clearTimeout(this.expiryTimer); window.removeEventListener("serotine:events", this.storeListener); window.removeEventListener("serotine:contacts", this.storeListener); window.removeEventListener("storage", this.storeListener); window.removeEventListener("storage", this.pluginStorageListener); window.removeEventListener("online", this.sync); window.removeEventListener("focus", this.sync); this.listeners.clear() }
  refresh = async () => {
    this.assertActive()
    const generation = ++this.refreshGeneration
    const completion = (async () => {
      const [records, preferences] = await Promise.all([this.storedEvents.read(), getMessagingPreferences(this.identity.publicKey)])
      this.assertActive()
      // Permission-sensitive callers must wait for the newer snapshot, not
      // continue with old state when overlapping reads supersede their own.
      if (generation !== this.refreshGeneration) { await this.refreshCompletion; return }
      const cutoffs = privateDestroyCutoffs(records, this.identity.publicKey)
      const retained = records.some(record => isPrivateEventExpired(record, this.identity.publicKey, cutoffs))
        ? records.filter(record => !isPrivateEventExpired(record, this.identity.publicKey, cutoffs)) : records
      const contacts = loadContacts(this.identity.publicKey)
      const preferencesText = JSON.stringify(preferences), contactsText = JSON.stringify(contacts)
      const pluginsChanged = this.pluginRegistry.reload()
      // The reader retains unchanged immutable event references. An idle poll
      // need not rebuild every conversation or re-render every retained file.
      if (this.records === retained && this.preferencesText === preferencesText && this.contactsText === contactsText && !pluginsChanged) return
      this.records = retained
      if (this.preferencesText !== preferencesText) this.preferences = preferences
      if (this.contactsText !== contactsText) this.contacts = contacts
      this.preferencesText = preferencesText; this.contactsText = contactsText
      for (const cid of this.preferences.directOnly ?? []) if (typeof localStorage !== "undefined") localStorage.setItem(`serotine.direct.v1:${this.identity.publicKey}:${cid}`, "1")
      for (const peer of this.preferences.blocked) this.pluginNegotiation.revoke(peer)
      await this.observePluginCapabilities()
      await this.profiles.observe(this.records)
      this.assertActive()
      this.model = buildMessagingModel(this.records, this.identity.publicKey, this.contacts, this.preferences, this.authorizedKeys)
      this.model.conversations = this.model.conversations.map(conversation => conversation.kind === "direct" && !this.contacts.find(contact => contact.pub === conversation.id)?.alias && this.profiles.getProfile(conversation.id).displayName ? { ...conversation, name: this.profiles.getProfile(conversation.id).displayName! } : conversation)
      this.applyGroupAdmissionStates()
      this.scheduleExpiry()
      this.emit()
    })()
    this.refreshCompletion = completion
    await completion
  }
  private scheduleExpiry() {
    clearTimeout(this.expiryTimer)
    const deadlines = this.records.filter(record => record.event.kind === "private-message").map(record => record.event.payload.expiresAt!)
    if (!deadlines.length || this.disposed) return
    this.expiryTimer = setTimeout(() => {
      if (this.disposed) return
      const owner = this.identity.publicKey, cutoffs = privateDestroyCutoffs(this.records, owner)
      // Clear plaintext from the live model immediately, even when a network
      // request or a durable-storage read is still waiting to complete.
      this.records = this.records.filter(record => !isPrivateEventExpired(record, owner, cutoffs))
      this.model = buildMessagingModel(this.records, owner, this.contacts, this.preferences, this.authorizedKeys)
      this.scheduleExpiry()
      this.emit()
      void this.refresh().catch(error => this.fail(error))
    }, Math.max(0, Math.min(...deadlines) - Date.now()))
    this.expiryTimer.unref?.()
  }
  private async migrateLocalHistory() {
    const owner = this.identity.publicKey
    const existing = new Map((await this.storedEvents.read()).map(record => [record.key, record]))
    for (const row of await exportAllMessagesFromStorage(owner)) {
      this.assertActive()
      if (isDeletedLegacyMessage(row, await getMessagingPreferences(owner))) continue
      const id = await legacyStoredMessageId(row)
      const cid = row.senderPubKey === owner ? row.peerPubKey : owner
      const pending = row.senderPubKey === owner && ["pending", "failed"].includes(row.delivery ?? "")
      const events = await legacyMessageEvents({ id, sender: row.senderPubKey, recipient: cid, timestamp: row.timestamp, content: row.content, attachments: row.attachments })
      await this.persistLegacyEvents(events, pending, row.timestamp, existing)
    }
  }
  private async persistLegacyEvents(events: MessagingEvent[], pending: boolean, receivedAt: number, existing?: Map<string, StoredEvent>) {
    const owner = this.identity.publicKey
    const saved = existing ?? new Map((await this.storedEvents.read()).map(record => [record.key, record]))
    for (const event of events) {
      this.assertActive()
      const key = eventStorageKey(event)
      const prior = saved.get(key)
      if (prior) {
        if (eventText(prior.event) !== eventText(event)) throw new Error("Conflicting legacy message identifier.")
        continue
      }
      if (pending) event.signature = await signText(eventText(event), this.identity)
      this.assertActive()
      try {
        const record = { key, event, local: pending, delivered: pending ? [] : [...event.recipients], receivedAt, legacy: !pending }
        await saveStoredEvent(owner, record)
        saved.set(key, record)
      } catch (error) {
        this.assertActive()
        // Concurrent tabs can sign the same migration with different valid ECDSA signatures.
        const concurrent = (await this.storedEvents.read()).find(record => record.key === key)
        if (!concurrent || eventText(concurrent.event) !== eventText(event)) throw error
        saved.set(key, concurrent)
      }
    }
  }
  private groupFor(cid: string) {
    this.assertActive()
    if (this.preferences.closedRetention?.includes(cid)) throw new Error("Group no longer exists.")
    const group = this.model.groups.find(g => g.id === cid)
    const conversation = this.model.conversations.find(c => c.id === cid)
    if (group?.deleted || this.preferences.terminatedGroups?.includes(cid) || this.groupAdmissionStates.get(cid)?.terminal) throw new Error("Group no longer exists.")
    if (!group || !conversation?.members.includes(this.identity.publicKey)) throw new Error("You are no longer a member of this group.")
    if (!sameSet(group.members, conversation.members)) throw new Error("A member left. Waiting for the group administrator to update membership before sending.")
    return group
  }
  getPrivateMode = (cid: string): PrivateTtlSeconds => {
    const owner = this.identity.publicKey
    if (!PUBLIC_KEY_PATTERN.test(cid) || cid === owner) return 0
    let latest: MessagingEvent | undefined
    for (const record of this.records) {
      const event = record.event
      if (record.legacy || event.group || event.kind !== "private-settings" || conversationForEvent(event, owner) !== cid
        || (event.author !== owner && (event.conversationId !== owner || !event.recipients.includes(owner)))
        || isDeletedStoredEvent(record, owner, this.preferences) || this.preferences.blocked.includes(event.author)) continue
      if (!latest || event.timestamp > latest.timestamp || (event.timestamp === latest.timestamp && event.id.localeCompare(latest.id) > 0)) latest = event
    }
    return latest?.payload.ttlSeconds ?? 0
  }
  sendEvent = async (cid: string, kind: EventKind, payload: EventPayload, requiredRoute?: "direct-only"): Promise<string> => {
    this.assertActive()
    if (!this.key) throw new Error("Your identity is still loading.")
    const owner = this.identity.publicKey
    const startedAt = Date.now()
    const submittedRoute = requiredRoute ?? this.getDeliveryMode(cid)
    const submittedPrivateTtl = this.getPrivateMode(cid.trim().toLowerCase())
    const preferences = await getMessagingPreferences(owner)
    let group: GroupState | undefined
    let recipients: string[]
    if (validGroupId(cid)) {
      group = this.groupFor(cid)
      if (group.protocol !== 2) {
        if (group.admin !== owner) throw new Error("The administrator needs to update this group before new messages can be sent.")
        await this.migrateLegacyGroup(group); group = this.groupFor(cid)
      }
      if (group.protocol === 2) {
        const state = await groupAdmissionRequest(this.identity, "status", { groupId: cid, admin: group.admin })
        this.assertActive(); this.groupAdmissionStates.set(cid, state)
        if (state.terminal) throw new Error("Group no longer exists.")
        group = this.groupFor(cid)
      }
      recipients = group.members.filter(x => x !== owner); if (!recipients.length) recipients = [owner]
    }
    else { cid = await validateAddress(cid); if (this.preferences.blocked.includes(cid) && !(kind === "profile" && payload.profile?.type === "revoke")) throw new Error("Unblock this contact before sending a message."); recipients = [cid] }
    this.assertActive()
    if (kind === "receipt" && group) throw new Error("Group reads remain on this device; group receipts are not sent.")
    if (kind === "profile" && (group || !payload.profile || !this.profiles.canDeliver(cid, payload.profile))) throw new Error("Profile sharing is no longer authorized for this friend.")
    if (kind === "community") throw new Error("Use community management to send community events.")
    if (kind === "group-dissolve" || GROUP_INVITATION_KINDS.has(kind)) throw new Error("Use explicit group invitation management for this operation.")
    if (kind === "group") throw new Error("Use group management to update a group.")
    if (kind === "plugin-capabilities" && (!this.trustedPluginPeer(cid) || group || payload.capabilities?.session !== this.pluginNegotiation.session)) throw new Error("Plugin capabilities are exchanged only with accepted direct contacts.")
    if (PRIVATE_KINDS.has(kind) && (group || cid === owner)) throw new Error("Private messages are available only in direct conversations with another person.")
    const targetId = payload.replyTo ?? payload.targetId
    const target = targetId ? this.model.messages.find(message => message.conversationId === cid && message.id === targetId) : undefined
    if (target?.private && (payload.replyTo || kind === "edit" || kind === "pin")) throw new Error("Private messages cannot be replied to, edited, or pinned.")
    const currentPrivateTtl = this.getPrivateMode(cid)
    if (payload.shared && (submittedPrivateTtl || currentPrivateTtl)) throw new Error("Shared copies cannot be sent while private mode is active.")
    // A mode change while signing/preparing a draft must never downgrade a
    // private submission into persistent history. Keep the shorter live timer.
    const ttlSeconds = submittedPrivateTtl && currentPrivateTtl ? Math.min(submittedPrivateTtl, currentPrivateTtl) : submittedPrivateTtl || currentPrivateTtl
    if (ttlSeconds && ["attachment", "attachment-chunk", "poll"].includes(kind)) throw new Error("Turn off private mode before sending files or polls.")
    const priorSettingTime = kind === "private-settings" ? Math.max(0, ...this.records.filter(record => record.event.kind === kind && conversationForEvent(record.event, owner) === cid).map(record => record.event.timestamp)) : 0
    const destroyBefore = privateDestroyCutoffs(this.records, owner)[cid] ?? 0
    const timestamp = Math.max(startedAt, (preferences.deleted?.[cid]?.deletedAt ?? 0) + 1, priorSettingTime + 1, kind === "private-message" || (kind === "message" && ttlSeconds) ? destroyBefore + 1 : 0, kind === "private-destroy" ? payload.destroyBefore ?? 0 : 0)
    if (ttlSeconds && kind === "message") {
      if (payload.replyTo) throw new Error("Replies are unavailable in private mode.")
      kind = "private-message"
      payload = { content: payload.content, expiresAt: timestamp + ttlSeconds * 1000 }
    }
    const route = submittedRoute === "direct-only" || this.getDeliveryMode(cid) === "direct-only" || target?.route === "direct-only" ? "direct-only" as const : undefined
    if (route && this.getDirectStatus(cid).state !== "connected") throw new Error("Peer unavailable. Connect directly before sending; your draft stays here.")
    if (route && !["message", "private-message", "private-settings", "private-destroy", "receipt", "attachment", "attachment-chunk", "plugin-capabilities"].includes(kind)) throw new Error("This feature is unavailable in Force P2P. It has not been relayed.")
    if (route && payload.attachment?.remote) throw new Error("Server-backed attachments cannot be sent in Force P2P.")
    this.assertPrivatePlugin(cid, kind, payload, preferences)
    // Off/destruction retain the legacy wire shape so safety cleanup still
    // reaches an older client that has not installed the plugin-aware release.
    if (kind === "private-message" || (kind === "private-settings" && payload.ttlSeconds)) payload = { ...payload, plugin: { id: PRIVATE_CHAT_PLUGIN_ID, version: "1.0.0" } }
    const eventId = payload.attachment?.remote?.messageId ?? crypto.randomUUID()
    if (kind === "attachment" && payload.attachment?.remote) {
      const { registerAttachmentDelivery } = await import("./file-upload-client")
      payload = { ...payload, attachment: await registerAttachmentDelivery(this.identity, payload.attachment, eventId, recipients, retentionDescriptor(cid, owner, timestamp, group?.admin), () => { if (this.getDeliveryMode(cid) === "direct-only") throw new Error("Server-backed attachments cannot be sent in Force P2P.") }) }
      this.assertActive()
    }
    const event = await signMessagingEvent({ version: 3, id: eventId, author: owner, conversationId: cid, recipients, timestamp, kind, payload, ...(route ? { route } : {}), ...(group ? { group } : {}) }, this.identity)
    if (!await validateMessagingEvent(event)) throw new Error("This message is invalid or too large.")
    await this.queue(event)
    return event.id
  }
  private async queue(event: MessagingEvent) {
    this.assertActive()
    this.assertPrivatePlugin(event.conversationId, event.kind, event.payload)
    if (event.kind === "profile" && !this.profiles.canDeliver(event.conversationId, event.payload.profile!)) throw new Error("Profile sharing changed while preparing the update.")
    if (isMultiPersonReceipt(event)) throw new Error("Multi-person receipts are not sent.")
    const saved = await saveStoredEvent(this.identity.publicKey, { key: eventStorageKey(event), event, local: true, delivered: [], receivedAt: Date.now() })
    if (saved === false) throw new Error(event.kind === "private-message" ? "This private message expired or was destroyed while being prepared. Send a new message." : "This chat was deleted while the message was being prepared. Send a new message to reopen it.")
    this.assertActive()
    if (event.route === "direct-only") {
      await this.deliverDirect({ key: eventStorageKey(event), event, local: true, delivered: [], receivedAt: Date.now() })
      return
    }
    // Chunks are durable individually, but refreshing the full history after each
    // piece would repeatedly clone an entire large file. Its metadata refreshes
    // and starts delivery when preparation finishes; normal sync can also recover
    // already saved pieces if preparation is interrupted.
    if (isAttachmentChunk(event)) return
    // Once durable, a view refresh failure must not make the composer resend it.
    try { await this.refresh() } catch (error) { this.fail(error) }
    this.assertActive()
    this.queuedRevision++
    this.requestSync()
  }
  sendText = (cid: string, text: string, replyTo?: string, mentions?: string[], expectedPrivateTtlSeconds?: PrivateTtlSeconds) => {
    // The composer may still have a private draft when a remote mode change
    // triggers its next render. Preserve the timer captured by that submission.
    if (expectedPrivateTtlSeconds) {
      if (!PRIVATE_DURATIONS.has(expectedPrivateTtlSeconds)) return Promise.reject(new Error("Choose a valid private message expiry."))
      if (replyTo) return Promise.reject(new Error("Replies are unavailable in private mode."))
      return this.sendEvent(cid, "private-message", { content: text.trim(), expiresAt: Date.now() + expectedPrivateTtlSeconds * 1000 })
    }
    return this.sendEvent(cid, "message", { content: text.trim(), ...(replyTo ? { replyTo } : {}), ...(mentions?.length ? { mentions } : {}) })
  }
  shareMessages = async (source: ShareSource, ids: string[], destination: ShareDestination, preview: SharedMessages) => {
    this.assertActive()
    await this.refresh()
    const sourceMessages = source.channelId ? this.communities.model.messages : this.model.messages
    if (source.channelId && !this.communities.model.communities.some(community => community.id === source.conversationId && community.joined && !community.deleted && community.effectiveMembers.includes(this.identity.publicKey))) throw new Error("This source channel is no longer available.")
    if (!source.channelId && this.preferences.blocked.includes(source.conversationId)) throw new Error("This source conversation is no longer available.")
    const shared = sharedMessagesFromSelection(sourceMessages, source, ids)
    if (!validSharedMessages(preview) || JSON.stringify(shared) !== JSON.stringify(preview)) throw new Error("The selected messages changed. Close this dialog and review the selection again.")
    const payload = { content: sharedMessagesFallback(shared), shared }
    if (destination.channelId) return this.communities.sendEvent(destination.conversationId, destination.channelId, "message", payload)
    const conversation = this.model.conversations.find(item => item.id === destination.conversationId)
    if (!conversation || conversation.blocked || conversation.request || !conversation.members.includes(this.identity.publicKey)) throw new Error("Choose an available accepted conversation.")
    if (this.getPrivateMode(destination.conversationId)) throw new Error("Turn off private mode before sharing a retained copy.")
    return this.sendEvent(destination.conversationId, "message", payload)
  }
  setPrivateMode = async (cid: string, ttlSeconds: PrivateTtlSeconds) => {
    if (!PRIVATE_DURATIONS.has(ttlSeconds)) throw new Error("Choose Off, 5 minutes, 1 hour, or 24 hours.")
    await this.sendEvent(cid, "private-settings", { ttlSeconds })
  }
  destroyPrivateHistory = async (cid: string) => {
    this.assertActive()
    // A peer clock can be slightly ahead. Include all currently visible private
    // content rather than leaving those already-received messages behind.
    const destroyBefore = Math.max(Date.now(), ...this.model.messages.filter(message => message.conversationId === cid && message.private).map(message => message.timestamp))
    await this.sendEvent(cid, "private-destroy", { destroyBefore }, this.records.some(record => record.event.route === "direct-only" && record.event.kind === "private-message" && conversationForEvent(record.event, this.identity.publicKey) === cid) ? "direct-only" : undefined)
  }
  sendSecret = async (cid: string, text: string, ttlSeconds = 3600) => {
    this.assertActive()
    if (!ttlSeconds || !PRIVATE_DURATIONS.has(ttlSeconds)) return Promise.reject(new Error("Choose an expiry of 5 minutes, 1 hour, or 24 hours."))
    return this.sendEvent(cid, "private-message", { content: text, expiresAt: Date.now() + ttlSeconds * 1000, secret: true })
  }
  editMessage = async (cid: string, messageId: string, text: string) => {
    this.assertActive()
    const target = this.model.messages.find(m => m.conversationId === cid && m.id === messageId)
    if (!target || target.senderPubKey !== this.identity.publicKey || target.attachment || target.poll || target.private || target.shared) throw new Error("You can edit your own ordinary text messages.")
    await this.sendEvent(cid, "edit", { targetId: messageId, content: text.trim() })
  }
  deleteMessage = async (cid: string, messageId: string) => {
    this.assertActive()
    const owner = this.identity.publicKey
    const legacyRows = []
    // A legacy envelope may contain text and several files. Remove its duplicate
    // raw bytes while keeping every other already-migrated message intact.
    for (const row of await exportAllMessagesFromStorage(owner)) if (row.peerPubKey === cid) {
      const id = await legacyStoredMessageId(row)
      const ids = await legacyVisibleMessageIds({ id, sender: row.senderPubKey, recipient: row.senderPubKey === owner ? cid : owner, timestamp: row.timestamp, content: row.content, attachments: row.attachments })
      if (ids.includes(messageId)) legacyRows.push(row)
    }
    this.assertActive()
    await deleteStoredMessage(owner, cid, messageId, legacyRows)
    this.assertActive()
    try {
      for (const row of legacyRows) await deleteMessageHistoryFromStorage(owner, cid, row.senderPubKey, row.id)
    } finally { await this.refresh() }
  }
  pinMessage = async (cid: string, messageId: string, pinned: boolean) => { await this.sendEvent(cid, "pin", { targetId: messageId, pinned }) }
  createPoll = (cid: string, question: string, options: string[]) => this.sendEvent(cid, "poll", { question: question.trim(), options: options.map(x => x.trim()) })
  vote = async (cid: string, messageId: string, option: number) => { await this.sendEvent(cid, "vote", { targetId: messageId, option }) }
  private async migrateLegacyGroup(prior: GroupState) {
    if (prior.protocol === 2) return
    if (prior.admin !== this.identity.publicKey) throw new Error("Only the administrator can update the group admission protocol.")
    const current = this.model.groups.find(group => group.id === prior.id)
    if (current?.protocol === 2) return
    await groupAdmissionRequest(this.identity, "create", { groupId: prior.id, admin: prior.admin })
    this.assertActive()
    const group = await signGroup({ ...prior, protocol: 2, members: [prior.admin], admissions: [], legacyMembers: [], consumedInvitations: [], epoch: prior.epoch + 1, updatedAt: Date.now() }, this.identity)
    await this.queueGroup(group, prior.members)
    for (const member of prior.members) if (member !== prior.admin) await this.inviteGroupMember(prior.id, member, true)
  }
  createGroup = async (name: string, members: string[]) => {
    this.assertActive()
    const owner = this.identity.publicKey
    const invited = [...new Set(await Promise.all(members.map(validateAddress)))].filter(member => member !== owner)
    if (invited.length >= MAX_MEMBERS) throw new Error(`Groups can have up to ${MAX_MEMBERS} members.`)
    const group = await signGroup({ id: `group:${crypto.randomUUID()}`, name: name.trim(), admin: owner, members: [owner], epoch: 1, updatedAt: Date.now(), protocol: 2, admissions: [], legacyMembers: [], consumedInvitations: [] }, this.identity)
    if (!await validateGroup(group)) throw new Error("Enter a group name of 1–80 characters.")
    await groupAdmissionRequest(this.identity, "create", { groupId: group.id, admin: owner })
    this.assertActive()
    await this.queueGroup(group, [owner])
    for (const peer of invited) await this.inviteGroupMember(group.id, peer)
    return group.id
  }
  private async queueGroup(group: GroupState, members: string[], dissolve = false) {
    this.assertActive()
    let recipients = [...new Set(members)].filter(x => x !== this.identity.publicKey)
    if (!recipients.length) recipients = [this.identity.publicKey]
    const event = await signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: this.identity.publicKey, conversationId: group.id, recipients, timestamp: Date.now(), kind: dissolve ? "group-dissolve" : "group", payload: {}, group }, this.identity)
    if (!await validateMessagingEvent(event)) throw new Error("The group update is invalid.")
    if (dissolve) {
      // The terminal server marker is authoritative. It intentionally forbids
      // new retained traffic, including this local signed tombstone.
      await saveStoredEvent(this.identity.publicKey, { key: eventStorageKey(event), event, local: true, delivered: [...recipients], receivedAt: Date.now() })
      await this.refresh()
    } else await this.queue(event)
  }
  private async queueGroupControl(cid: string, recipient: string, kind: EventKind, payload: EventPayload) {
    this.assertActive()
    const event = await signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: this.identity.publicKey, conversationId: cid, recipients: [recipient], timestamp: Date.now(), kind, payload }, this.identity)
    if (!await validateMessagingEvent(event)) throw new Error("This invitation control is invalid.")
    await this.queue(event)
  }
  getPendingGroupInvitations = (cid: string): GroupInvitationPreview[] => {
    const group = this.model.groups.find(item => item.id === cid)
    if (group?.deleted || this.preferences.terminatedGroups?.includes(cid) || this.groupAdmissionStates.get(cid)?.terminal) return []
    const invitations = new Map<string, GroupInvitationPreview>()
    const resolved = new Set<string>()
    for (const { event } of this.records) {
      if (event.conversationId !== cid) continue
      if (event.kind === "group-invite" && event.payload.groupInvitation) invitations.set(event.payload.groupInvitation.invitation.id, event.payload.groupInvitation)
      if (event.kind === "group-decline" || event.kind === "group-revoke") { const id = event.payload.invitation?.id; if (id) resolved.add(id) }
    }
    for (const row of this.groupAdmissionStates.get(cid)?.invitations ?? []) if (row.status !== "pending") resolved.add(row.invitationId)
    for (const admission of group?.admissions ?? []) resolved.add(admission.invitation.id)
    return [...invitations.values()].filter(item => item.invitation.admin === this.identity.publicKey && item.invitation.expiresAt > Date.now() && !resolved.has(item.invitation.id))
  }
  inviteGroupMember = async (cid: string, publicKey: string, migration = false) => {
    await this.refresh()
    let group = this.groupFor(cid)
    if (group.protocol !== 2) { await this.migrateLegacyGroup(group); group = this.groupFor(cid) }
    const peer = await validateAddress(publicKey)
    if (group.admin !== this.identity.publicKey) throw new Error("Only the administrator can invite members.")
    if (group.members.includes(peer)) throw new Error("This person is already a member.")
    const pending = this.getPendingGroupInvitations(cid)
    if (pending.some(item => item.invitation.invitee === peer)) throw new Error("This person already has a pending invitation.")
    if (group.members.length + pending.length >= MAX_MEMBERS) throw new Error("This group has reached its member and invitation limit.")
    await groupAdmissionRequest(this.identity, "create", { groupId: cid, admin: group.admin })
    const now = Date.now()
    const invitation = await signGroupInvitation({ id: crypto.randomUUID(), groupId: cid, admin: group.admin, invitee: peer, createdAt: now, expiresAt: now + GROUP_INVITATION_MS }, this.identity)
    const state = await groupAdmissionRequest(this.identity, "invite", { groupId: cid, admin: group.admin, invitation })
    this.assertActive()
    this.groupAdmissionStates.set(cid, state)
    if (state.terminal) throw new Error("Group no longer exists.")
    await this.queueGroupControl(cid, peer, "group-invite", { groupInvitation: { invitation, name: group.name, memberCount: group.members.length, ...(migration ? { migration: true } : {}) } })
  }
  revokeGroupInvitation = async (cid: string, invitationId: string) => {
    const group = this.groupFor(cid)
    if (group.admin !== this.identity.publicKey) throw new Error("Only the administrator can revoke invitations.")
    const invitation = this.getPendingGroupInvitations(cid).find(item => item.invitation.id === invitationId)?.invitation
    if (!invitation) throw new Error("This invitation is no longer pending.")
    this.groupAdmissionStates.set(cid, await groupAdmissionRequest(this.identity, "revoke", { groupId: cid, admin: group.admin, invitationId }))
    await this.queueGroupControl(cid, invitation.invitee, "group-revoke", { invitation })
  }
  declineGroupInvitation = async (cid: string) => {
    const invitation = this.model.conversations.find(item => item.id === cid)?.invitation?.invitation
    if (!invitation) throw new Error("This invitation is no longer pending.")
    this.groupAdmissionStates.set(cid, await groupAdmissionRequest(this.identity, "decline", { groupId: cid, admin: invitation.admin, invitationId: invitation.id }))
    await this.queueGroupControl(cid, invitation.admin, "group-decline", { invitation })
  }
  private async acceptGroupInvitation(cid: string) {
    await this.refresh()
    const invitation = this.model.conversations.find(item => item.id === cid)?.invitation?.invitation
    if (!invitation) throw new Error("Ask the administrator for a fresh group invitation before joining.")
    const acceptance = await signGroupAcceptance(invitation, this.identity)
    const state = await groupAdmissionRequest(this.identity, "accept", { groupId: cid, admin: invitation.admin, acceptance })
    this.assertActive()
    this.groupAdmissionStates.set(cid, state)
    if (state.terminal) throw new Error("Group no longer exists.")
    await this.queueGroupControl(cid, invitation.admin, "group-accept", { groupAcceptance: acceptance })
    await this.updatePreferences(p => ({ ...p, accepted: [...new Set([...p.accepted, cid])] }))
  }
  updateGroup = async (cid: string, changes: { name?: string; members?: string[] }) => {
    await this.refresh()
    let prior = this.groupFor(cid)
    if (prior.protocol !== 2) { await this.migrateLegacyGroup(prior); prior = this.groupFor(cid) }
    if (prior.admin !== this.identity.publicKey) throw new Error("Only the group creator can change its name or members.")
    const requested = changes.members ? [...new Set([prior.admin, ...await Promise.all(changes.members.map(validateAddress))])] : this.model.conversations.find(c => c.id === cid)!.members
    for (const added of requested.filter(member => !prior.members.includes(member))) await this.inviteGroupMember(cid, added)
    const members = requested.filter(member => prior.members.includes(member))
    if (sameSet(members, prior.members) && (changes.name?.trim() ?? prior.name) === prior.name) return
    const group = await signGroup({ ...prior, name: changes.name?.trim() ?? prior.name, members, epoch: prior.epoch + 1, updatedAt: Date.now(),
      ...(prior.protocol === 2 ? { admissions: prior.admissions!.filter(a => members.includes(a.invitation.invitee)), legacyMembers: prior.legacyMembers!.filter(member => members.includes(member)) } : {}) }, this.identity)
    if (!await validateGroup(group)) throw new Error("Check the group name and member list (maximum 20).")
    await this.queueGroup(group, [...prior.members, ...members])
  }
  dissolveGroup = async (cid: string) => {
    await this.refresh()
    const prior = this.groupFor(cid)
    if (prior.admin !== this.identity.publicKey) throw new Error("Only the administrator can dissolve this group.")
    const pending = this.getPendingGroupInvitations(cid)
    await groupAdmissionRequest(this.identity, "create", { groupId: cid, admin: prior.admin })
    this.groupAdmissionStates.set(cid, await groupAdmissionRequest(this.identity, "dissolve", { groupId: cid, admin: prior.admin }))
    const group = await signGroup({ ...prior, protocol: 2, members: prior.protocol === 2 ? prior.members : [prior.admin], admissions: prior.admissions ?? [], legacyMembers: [], consumedInvitations: prior.consumedInvitations ?? [], deleted: true, epoch: prior.epoch + 1, updatedAt: Date.now() }, this.identity)
    await this.queueGroup(group, [...prior.members, ...pending.map(item => item.invitation.invitee)], true)
    await this.updatePreferences(p => ({ ...p, terminatedGroups: [...new Set([...(p.terminatedGroups ?? []), cid])] }))
  }
  leaveGroup = async (cid: string) => {
    const group = this.groupFor(cid)
    if (group.admin === this.identity.publicKey) throw new Error("Administrators must use Dissolve group to close the group for everyone.")
    await this.sendEvent(cid, "leave", {})
    try { await this.setNotificationMode(cid, "muted") } catch (error) { this.fail(error) }
  }
  archiveConversation = async (cid: string, archived = true) => {
    this.assertActive()
    if (!validGroupId(cid) && !PUBLIC_KEY_PATTERN.test(cid)) throw new Error("Choose a valid conversation.")
    await this.updatePreferences(p => ({ ...p, archived: archived ? [...new Set([...(p.archived ?? []), cid])] : (p.archived ?? []).filter(id => id !== cid) }))
  }
  deleteConversation = async (cid: string) => {
    this.assertActive()
    const owner = this.identity.publicKey
    await deleteStoredConversation(owner, cid)
    this.assertActive()
    try { await deleteConversationHistoryFromStorage(owner, cid) } finally { await this.refresh() }
  }
  private async updatePreferences(change: (value: MessagingPreferences) => MessagingPreferences) {
    this.assertActive()
    const owner = this.identity.publicKey
    const update = async () => { this.assertActive(); const prior = await getMessagingPreferences(owner); this.assertActive(); await saveMessagingPreferences(owner, change(prior)) }
    if (navigator.locks) await navigator.locks.request(`serotine:preferences:${owner}`, update); else await update()
    await this.refresh()
  }
  acceptRequest = async (cid: string) => {
    this.assertActive()
    if (validGroupId(cid)) { await this.acceptGroupInvitation(cid); return }
    cid = await validateAddress(cid)
    if (cid !== this.identity.publicKey && this.getDeliveryMode(cid) !== "direct-only") {
      await requestRetention(this.identity, "retention:accept", retentionDescriptor(cid, this.identity.publicKey, Date.now()))
      this.assertActive()
    }
    await this.updatePreferences(p => ({ ...p, accepted: [...new Set([...p.accepted, cid])] }))
  }
  removeFriend = async (pub: string) => {
    this.assertActive(); pub = await validateAddress(pub)
    // Closing earlier relay history is metadata-only cleanup, including while Force P2P is active.
    await requestRetention(this.identity, "retention:close", retentionDescriptor(pub, this.identity.publicKey, Date.now()))
    this.assertActive()
    saveContacts(this.identity.publicKey, loadContacts(this.identity.publicKey).filter(contact => contact.pub !== pub))
    await this.updatePreferences(p => ({ ...p, accepted: p.accepted.filter(peer => peer !== pub) }))
    await this.profiles.revoke(pub)
  }
  blockContact = async (pub: string, blocked = true) => { this.assertActive(); await validateAddress(pub); if (pub === this.identity.publicKey) throw new Error("You cannot block yourself."); this.pluginNegotiation.revoke(pub); await this.updatePreferences(p => ({ ...p, blocked: blocked ? [...new Set([...p.blocked, pub])] : p.blocked.filter(x => x !== pub) })); if (blocked) await this.profiles.revoke(pub) }
  setNotificationMode = async (cid: string, mode: NotificationMode) => { await this.updatePreferences(p => ({ ...p, notifications: { ...p.notifications, [cid]: mode } })) }
  setReadReceipts = async (enabled: boolean) => { await this.updatePreferences(p => ({ ...p, readReceipts: enabled })) }
  requestNotifications = () => { this.assertActive(); return requestMessagingNotifications() }
  markRead = async (cid: string) => {
    this.assertActive()
    const messages = this.model.messages.filter(m => m.conversationId === cid && m.senderPubKey !== this.identity.publicKey)
    const latest = Math.max(0, ...messages.map(m => m.timestamp))
    if (latest <= (this.preferences.readAt[cid] ?? 0)) return
    const unread = messages.filter(m => m.timestamp > (this.preferences.readAt[cid] ?? 0))
    await this.updatePreferences(p => ({ ...p, readAt: { ...p.readAt, [cid]: Math.max(latest, p.readAt[cid] ?? 0) } }))
    const conversation = this.model.conversations.find(c => c.id === cid)
    if (!validGroupId(cid) && this.preferences.readReceipts && this.getDeliveryMode(cid) !== "direct-only" && conversation && !conversation.request && !conversation.blocked && conversation.members.includes(this.identity.publicKey)) for (const message of unread) await this.sendEvent(cid, "receipt", { targetId: message.id, receipt: "read" })
  }
  getAttachmentChunks = (cid: string, messageId: string): Array<{ index: number; data: string }> => {
    // The previous conversation can remain visible while an identity switch
    // finishes. Reading its cached file pieces must remain safe during render.
    const message = this.model.messages.find(m => m.conversationId === cid && m.id === messageId)
    if (!message?.attachment || message.attachment.remote) return []
    const chunks = new Map<number, string>()
    for (const record of this.records) if (this.authorizedKeys.has(record.key) && record.event.kind === "attachment-chunk" && record.event.author === message.senderPubKey && conversationForEvent(record.event, this.identity.publicKey) === cid && record.event.payload.attachmentId === message.attachment.id && record.event.payload.index! < message.attachment.chunks) chunks.set(record.event.payload.index!, record.event.payload.data!)
    return [...chunks].map(([index, data]) => ({ index, data })).sort((a, b) => a.index - b.index)
  }
  retry = async (messageId?: string) => {
    this.assertActive()
    const directMessage = this.model.messages.find(m => m.id === messageId)
    if (directMessage?.route === "direct-only") {
      const matching = this.records.filter(record => record.local && record.event.route === "direct-only" && record.event.conversationId === directMessage.conversationId && (record.event.id === directMessage.id || (directMessage.attachment && record.event.payload.attachmentId === directMessage.attachment.id)))
      for (const record of matching.sort((a, b) => Number(a.event.kind === "attachment") - Number(b.event.kind === "attachment"))) await this.deliverDirect(record)
      return
    }
    const communityMessage = directMessage ? undefined : this.communities.model.messages.find(m => m.id === messageId)
    const message = directMessage || communityMessage
    for (const record of await this.storedEvents.read()) {
      const communityData = record.event.payload.community
      const sameCommunityMessage = !communityMessage || (record.event.conversationId === communityMessage.conversationId && record.event.author === communityMessage.senderPubKey && communityData && "channelId" in communityData && communityData.channelId === communityMessage.channelId)
      const matchingChunk = communityMessage
        ? sameCommunityMessage && communityData?.type === "attachment-chunk" && communityData.attachmentId === communityMessage.attachment?.id
        : message?.attachment && record.event.kind === "attachment-chunk" && record.event.payload.attachmentId === message.attachment.id
      if (record.local && record.event.route !== "direct-only" && record.error && (!messageId || (record.event.id === messageId && sameCommunityMessage) || matchingChunk)) { this.assertActive(); await saveStoredEvent(this.identity.publicKey, { ...record, error: undefined, failedRecipients: undefined }) }
    }
    this.assertActive()
    await this.sync()
  }
  sync = async () => {
    if (this.disposed || this.running || !this.key) return
    this.running = true
    try {
      const run = async () => {
        this.assertActive()
        // Community sends must see retained membership updates before fanout.
        // Direct/group delivery retains its established retry behavior.
        await this.refresh()
        for (const group of [...this.model.groups]) if (group.protocol !== 2 && group.admin === this.identity.publicKey && this.model.conversations.some(item => item.id === group.id && item.members.includes(this.identity.publicKey))) await this.migrateLegacyGroup(group)
        await this.refreshGroupAdmissions()
        // Apply incoming capability revocations before releasing private outbox
        // content. Ordinary messages keep the established fast delivery path.
        if (this.records.some(record => record.local && (record.event.kind === "profile" || record.event.kind === "private-message" || (record.event.kind === "private-settings" && record.event.payload.ttlSeconds)) && record.event.recipients.some(peer => canSendTo(record, peer)))) await this.readFeed()
        const hasCommunities = this.records.some(record => record.event.kind === "community")
        if (hasCommunities) {
          // Unrelated direct/group sends do not need to wait for the community
          // membership feed. Community fanout still waits for its fresh state.
          if (await this.flushOutbox({ regularOnly: true, skipChunks: true })) await this.refresh()
          await this.readFeed(); await this.communities.reconcile()
        }
        if (await this.flushOutbox({ regularOnly: !hasCommunities })) await this.refresh()
        await this.readFeed()
        if (this.records.some(record => record.event.kind === "community")) {
          await this.communities.reconcile()
          if (await this.flushOutbox()) await this.refresh()
        }
        await this.profiles.flush()
        if (await this.readLegacyInbox()) await this.refresh()
        // Successful inbox reads establish connectivity. An older failed send
        // (including a receipt to a retired contact) says nothing about it.
        if (this.status !== "online" || this.error) {
          this.status = "online"; this.error = null; this.emit()
        }
      }
      if (navigator.locks) await navigator.locks.request(`serotine:sync:${this.identity.publicKey}`, { ifAvailable: true }, async lock => { if (lock) await run() })
      else await run()
    } catch (error) { this.fail(error) } finally {
      this.running = false
      // Storage notifications during a transfer are covered by its own awaited
      // refreshes; coalesce any concurrent local changes into one final read.
      if (this.refreshPending && !this.disposed) this.storeListener()
      // A message queued after this pass captured its outbox should leave now,
      // rather than waiting for the next five-second polling interval.
      if (this.syncRequested && !this.disposed) { this.syncRequested = false; void this.sync() }
    }
  }
  private async flushOutbox({ regularOnly = false, skipChunks = false } = {}) {
    this.assertActive()
    if (Date.now() < this.outboxRetryAt) return false
    const owner = this.identity.publicKey
    const eligible = (record: StoredEvent) => record.local && !record.legacy && !this.preferences.closedRetention?.includes(record.event.conversationId) && !isMultiPersonReceipt(record.event) && record.event.route !== "direct-only" && this.getDeliveryMode(record.event.conversationId) !== "direct-only" && (!regularOnly || record.event.kind !== "community")
      && (!skipChunks || !isAttachmentChunk(record.event)) && (record.event.kind !== "profile" || this.profiles.canDeliver(record.event.conversationId, record.event.payload.profile!)) && record.event.recipients.some(peer => canSendTo(record, peer))
    // sync already awaited a current snapshot. Keep its immutable records out
    // of mutable delivery bookkeeping and avoid a second full history read.
    let pending = this.records.filter(eligible).sort(compareOutbox)
    const attempted = new Set<string>()
    const checkedAdmissions = new Map<string, Promise<GroupAdmissionStatus>>()
    let queuedRevision = this.queuedRevision
    let didWork = false
    let transportFailed = false
    while (pending.length) {
      if (this.disposed) return
      const batch = pending.splice(0, 4)
      didWork = true
      for (const record of batch) attempted.add(record.key)
      await Promise.all(batch.map(async snapshot => {
        const record = { ...snapshot, delivered: [...snapshot.delivered], ...(snapshot.failedRecipients ? { failedRecipients: [...snapshot.failedRecipients] } : {}) }
        for (const recipientPubKey of record.event.recipients) {
          if (this.disposed || Date.now() < this.outboxRetryAt) return
          if (!canSendTo(record, recipientPubKey)) continue
          try {
            this.assertPrivatePlugin(record.event.conversationId, record.event.kind, record.event.payload)
            if (record.event.group) {
              const group = this.model.groups.find(item => item.id === record.event.conversationId)
              if (group?.deleted || this.preferences.terminatedGroups?.includes(record.event.conversationId) || this.groupAdmissionStates.get(record.event.conversationId)?.terminal) throw new Error("Group no longer exists.")
              if (group && (group.epoch !== record.event.group.epoch || group.signature !== record.event.group.signature)) throw new Error("Group membership changed. Review the group before sending again.")
              if (record.event.group.protocol === 2) {
                const cid = record.event.conversationId
                let check = checkedAdmissions.get(cid)
                if (!check) { check = groupAdmissionRequest(this.identity, "status", { groupId: cid, admin: record.event.group.admin }); checkedAdmissions.set(cid, check) }
                const state = await check
                this.assertActive(); this.groupAdmissionStates.set(record.event.conversationId, state)
                if (state.terminal) throw new Error("Group no longer exists.")
              }
            }
            if (record.event.kind === "community") {
              // The pass already refreshed local state. Recheck again after
              // encryption below, when a newer membership could have arrived.
              const reason = communityOutboxError(record.event, this.communities.model, owner)
              if (reason) {
                record.error = reason
                record.failedRecipients = record.event.recipients.filter(peer => !record.delivered.includes(peer))
                await saveStoredEvent(owner, record)
                return
              }
            }
            const encryptedData = await encryptForPeer(JSON.stringify(record.event), this.key!, recipientPubKey)
            this.assertActive()
            const communityState = record.event.payload.community?.type === "state" ? record.event.payload.community.state : this.communities.model.communities.find(item => item.id === record.event.conversationId)
            const retention = retentionDescriptor(record.event.conversationId, owner, record.event.timestamp, record.event.group?.admin ?? record.event.payload.groupInvitation?.invitation.admin ?? record.event.payload.groupAcceptance?.invitation.admin ?? record.event.payload.invitation?.admin, (record.event.payload.community?.type === "join" ? record.event.payload.community.invite.transfers : record.event.payload.community?.type === "decision" ? record.event.payload.community.transfers : communityState?.transfers))
            const data = { id: record.event.id, recipientPubKey, encryptedData, retention }
            const proof = await createRequestProof("event:send", data, this.identity.privateKey, owner)
            this.assertActive()
            this.assertPrivatePlugin(record.event.conversationId, record.event.kind, record.event.payload)
            const latestPreferences = await getMessagingPreferences(owner)
            if (isDeletedStoredEvent(record, owner, latestPreferences)) return
            if (record.event.kind === "private-message") {
              const current = await this.storedEvents.read()
              if (!current.some(row => row.key === record.key) || isPrivateEventExpired(record, owner, privateDestroyCutoffs(current, owner))) return
            }
            if (record.event.kind === "community") {
              await this.refresh()
              const reason = communityOutboxError(record.event, this.communities.model, owner)
              if (reason) {
                record.error = reason
                record.failedRecipients = record.event.recipients.filter(peer => !record.delivered.includes(peer))
                await saveStoredEvent(owner, record)
                return
              }
            }
            this.assertPrivatePlugin(record.event.conversationId, record.event.kind, record.event.payload, latestPreferences)
            if (latestPreferences.closedRetention?.includes(record.event.conversationId) || this.preferences.closedRetention?.includes(record.event.conversationId)) return
            if (record.event.group) {
              const current = this.model.groups.find(group => group.id === record.event.conversationId)
              if (current?.deleted || latestPreferences.terminatedGroups?.includes(record.event.conversationId) || this.groupAdmissionStates.get(record.event.conversationId)?.terminal) throw new Error("Group no longer exists.")
              if (current && (current.epoch !== record.event.group.epoch || current.signature !== record.event.group.signature)) throw new Error("Group membership changed. Review the group before sending again.")
            }
            if (record.event.kind === "profile" && (record.event.payload.profile!.type !== "revoke" && record.event.payload.profile!.type !== "sync" && !this.trustedPluginPeer(recipientPubKey, latestPreferences) || !this.profiles.canDeliver(recipientPubKey, record.event.payload.profile!))) return
            // Permanent signed marker plus current cross-tab policy fence: no retry,
            // restore or mode change can release direct content to the relay.
            if (record.event.route === "direct-only" || this.getDeliveryMode(record.event.conversationId) === "direct-only") return
            const result = await storeEncryptedEvent(data, proof, () => {
              // Installed clients may wait for a durable snapshot before native
              // I/O. Recheck live policy after that wait, immediately before send.
              this.assertActive()
              this.assertPrivatePlugin(record.event.conversationId, record.event.kind, record.event.payload)
              if (!eligible(record) || isDeletedStoredEvent(record, owner, this.preferences)) throw new Error("Sending is no longer allowed for this conversation.")
              if (record.event.kind === "private-message" && (!this.records.some(row => row.key === record.key)
                || isPrivateEventExpired(record, owner, privateDestroyCutoffs(this.records, owner)))) throw new Error("This private message has expired.")
              if (record.event.group) {
                const current = this.model.groups.find(group => group.id === record.event.conversationId)
                if (current?.deleted || this.preferences.terminatedGroups?.includes(record.event.conversationId) || this.groupAdmissionStates.get(record.event.conversationId)?.terminal
                  || (current && (current.epoch !== record.event.group.epoch || current.signature !== record.event.group.signature))) throw new Error("Group membership changed. Review the group before sending again.")
              }
              if (record.event.kind === "community") {
                const reason = communityOutboxError(record.event, this.communities.model, owner)
                if (reason) throw new Error(reason)
              }
              if (record.event.kind === "profile" && record.event.payload.profile!.type !== "revoke" && record.event.payload.profile!.type !== "sync" && !this.trustedPluginPeer(recipientPubKey)) throw new Error("Profile sharing is no longer allowed.")
            })
            this.assertActive()
            if (!result.success && result.retryAfterMs) {
              // This authenticated refusal did not store the event. Keep the
              // durable outbox pending and retry with a fresh proof next window.
              this.outboxRetryAt = Math.max(this.outboxRetryAt, Date.now() + result.retryAfterMs)
              return
            }
            if (!result.success) {
              record.error = record.event.group ? `${shortAddress(recipientPubKey)}: ${result.error}` : result.error
              record.failedRecipients = [...new Set([...(record.failedRecipients ?? []), recipientPubKey])]
              await saveStoredEvent(owner, record)
              // A refused destination must not block active group members or
              // unrelated conversations. Rejected recipients stay unconfirmed.
              continue
            }
            record.delivered = [...new Set([...record.delivered, recipientPubKey])]
            if (record.event.recipients.every(peer => record.delivered.includes(peer))) { record.error = undefined; record.failedRecipients = undefined }
            await saveStoredEvent(owner, record)
          } catch (error) { if (this.disposed) return; record.error = error instanceof Error ? error.message : "Sending failed. Retry when connected."; record.failedRecipients = [...new Set([...(record.failedRecipients ?? []), recipientPubKey])]; transportFailed = true; await saveStoredEvent(owner, record); break }
        }
      }))
      if (transportFailed || Date.now() < this.outboxRetryAt) break
      if (queuedRevision !== this.queuedRevision) {
        // Local sends refresh the live snapshot before raising this revision.
        // Pick them up between small batches, including during a large upload.
        queuedRevision = this.queuedRevision
        const queued = new Map(pending.map(record => [record.key, record]))
        for (const record of this.records) if (!attempted.has(record.key) && eligible(record)) queued.set(record.key, record)
        pending = [...queued.values()].sort(compareOutbox)
      }
    }
    return didWork
  }
  private async readFeed() {
    this.assertActive()
    const owner = this.identity.publicKey
    let after = await getSyncCursor(owner)
    const communities = this.communities.model
    const candidates = [...new Set([
      ...this.model.groups.map(group => group.id), ...communities.communities.map(community => community.id), ...communities.requests.map(request => request.communityId),
      ...this.contacts.map(contact => contact.pub), ...this.preferences.accepted.filter(cid => PUBLIC_KEY_PATTERN.test(cid)),
      ...this.model.conversations.filter(conversation => conversation.kind === "direct" && PUBLIC_KEY_PATTERN.test(conversation.id)).map(conversation => conversation.id),
    ])].filter(cid => cid !== owner && !this.preferences.closedRetention?.includes(cid)).sort()
    const offset = candidates.length ? this.retentionSyncOffset % candidates.length : 0
    const batch = [...candidates.slice(offset), ...candidates.slice(0, offset)].slice(0, 100)
    this.retentionSyncOffset = offset + batch.length
    const scopes = new Map(await Promise.all(batch.map(async cid => {
      const descriptor = retentionDescriptor(cid, owner, Date.now(), this.model.groups.find(group => group.id === cid)?.admin)
      return [await retentionScopeId(descriptor), cid] as const
    })))
    let hasMore = true
    while (hasMore && !this.disposed) {
      const data = { after, ...(scopes.size ? { retentionScopes: [...scopes.keys()] } : {}) }
      const proof = await createRequestProof("event:sync", data, this.identity.privateKey, owner)
      this.assertActive()
      const result = await getEventFeed(data, proof)
      this.assertActive()
      if (!result.success) throw new Error(result.error)
      const closed = (result.closedScopes ?? []).flatMap(scope => { const cid = scopes.get(scope); return cid && (isCommunityId(cid) || validGroupId(cid)) ? [cid] : [] })
      const boundaries = (result.relationshipBoundaries ?? []).flatMap(row => { const peer = scopes.get(row.scopeId); return peer && PUBLIC_KEY_PATTERN.test(peer) ? [[peer, row.boundaryAt] as const] : [] })
      if (closed.some(cid => !this.preferences.closedRetention?.includes(cid)) || boundaries.some(([peer, time]) => time > (this.preferences.relationshipBoundaries?.[peer] ?? 0))) {
        await this.updatePreferences(prior => ({ ...prior, closedRetention: [...new Set([...(prior.closedRetention ?? []), ...closed])],
          relationshipBoundaries: { ...prior.relationshipBoundaries, ...Object.fromEntries(boundaries.map(([peer, time]) => [peer, Math.max(time, prior.relationshipBoundaries?.[peer] ?? 0)])) } }))
      }
      // Receiving a feed response establishes connectivity before a large
      // history download or the compatibility inbox has finished processing.
      if (this.status !== "online" || this.error) {
        this.status = "online"; this.error = null; this.emit()
      }
      const notifications: string[] = []
      let changed = false, admissionChanged = false
      for (const packet of result.messages) {
        this.assertActive()
        let event: MessagingEvent
        try {
          const peer = packet.senderPubKey === owner ? packet.recipientPubKey : packet.senderPubKey
          event = JSON.parse(await decryptFromPeer(packet.encryptedData, this.key!, peer)) as MessagingEvent
          if (!await validateMessagingEvent(event, packet) || event.route === "direct-only") continue
          if (event.author !== owner && !event.recipients.includes(owner)) continue
        } catch { continue } // Invalid ciphertext must not stall unrelated messages.
        this.assertActive()
        const key = eventStorageKey(event)
        const existing = this.records.find(r => r.key === key)
        const record: StoredEvent = { key, event, local: event.author === owner, delivered: event.author === owner ? [packet.recipientPubKey] : [], receivedAt: packet.createdAt, sequence: packet.sequence, error: existing?.error }
        // Persist failures must abort the page before its cursor can advance.
        await saveStoredEvent(owner, record)
        changed = true
        if (GROUP_INVITATION_KINDS.has(event.kind) || event.kind === "group-dissolve") admissionChanged = true
        if (!existing && event.author !== owner && (VISIBLE_KINDS.has(event.kind) || (event.kind === "community" && ["message", "attachment", "poll"].includes(event.payload.community?.type ?? ""))) && packet.createdAt >= this.initializedAt) notifications.push(event.id)
      }
      if (changed) await this.refresh()
      await this.respondPluginCapabilities()
      if (admissionChanged) await this.refreshGroupAdmissions(true)
      this.assertActive()
      for (const id of notifications) {
        const message = this.model.messages.find(m => m.id === id)
        const conversation = message && this.model.conversations.find(c => c.id === message.conversationId)
        if (message && conversation && !conversation.archived) void notifyIncoming(message, conversation, owner)
        else {
          const model = this.communities.model
          const communityMessage = model.messages.find(row => row.id === id && !row.hidden)
          const community = communityMessage && model.communities.find(row => row.id === communityMessage.conversationId && row.joined)
          if (communityMessage && community) {
            const channel = community.channels.find(row => row.id === communityMessage.channelId)
            const notificationMode = this.preferences.notifications[communityChannelKey(community.id, communityMessage.channelId)] ?? community.notificationMode
            void notifyIncoming(communityMessage, { id: community.id, kind: "group", name: `${community.name} / ${channel?.name ?? "channel"}`, members: community.members, unreadCount: community.unreadCount, updatedAt: community.updatedAt, notificationMode, blocked: false, request: false, archived: (this.preferences.archived ?? []).includes(community.id) }, owner,
              `/chat/communities#id=${encodeURIComponent(community.id)}&channel=${communityMessage.channelId}`)
          }
        }
      }
      await this.reconcileDepartures()
      await this.sendDeliveryReceipts()
      this.assertActive()
      after = result.nextCursor
      await saveSyncCursor(owner, after)
      hasMore = result.hasMore
    }
  }
  private applyGroupAdmissionStates() {
    this.model.conversations = this.model.conversations.filter(conversation => {
      const invitation = conversation.invitation?.invitation
      if (!invitation) return true
      const state = this.groupAdmissionStates.get(conversation.id)
      const row = state?.invitations.find(item => item.invitationId === invitation.id)
      return !state?.terminal && (!row || row.status === "pending" || row.status === "accepted")
    })
    this.model.requests = this.model.conversations.filter(conversation => conversation.request && !conversation.archived)
  }
  private async refreshGroupAdmissions(force = false) {
    const targets = new Map<string, string>()
    for (const group of this.model.groups) if (group.protocol === 2 && !group.deleted && !this.preferences.terminatedGroups?.includes(group.id)) targets.set(group.id, group.admin)
    for (const { event } of this.records) if (event.kind === "group-invite" && event.payload.groupInvitation) {
      const invitation = event.payload.groupInvitation.invitation
      if (!this.preferences.terminatedGroups?.includes(invitation.groupId)) targets.set(invitation.groupId, invitation.admin)
    }
    for (const [cid, admin] of targets) {
      if (!force && Date.now() - (this.groupAdmissionChecked.get(cid) ?? 0) < 15_000) continue
      const state = await groupAdmissionRequest(this.identity, "status", { groupId: cid, admin })
      this.assertActive()
      this.groupAdmissionChecked.set(cid, Date.now()); this.groupAdmissionStates.set(cid, state)
      if (state.terminal) {
        await this.updatePreferences(p => ({ ...p, terminatedGroups: [...new Set([...(p.terminatedGroups ?? []), cid])] }))
        continue
      }
      if (admin !== this.identity.publicKey) {
        const migration = this.model.conversations.find(item => item.id === cid)?.invitation
        const hasPriorConsent = this.preferences.accepted.includes(cid) || this.records.some(record => record.event.author === this.identity.publicKey && record.event.conversationId === cid && record.event.group && record.event.group.protocol !== 2 && VISIBLE_KINDS.has(record.event.kind))
        if (migration?.migration && hasPriorConsent && state.invitations.some(row => row.invitationId === migration.invitation.id && row.status === "pending" && row.expiresAt > Date.now())) await this.acceptGroupInvitation(cid)
        continue
      }
      const prior = this.model.groups.find(group => group.id === cid)
      if (!prior || prior.deleted || !prior.members.includes(admin)) continue
      const pending = state.invitations.filter(row => row.status === "accepted" && row.acceptance && !prior.consumedInvitations?.includes(row.invitationId)
        && !prior.admissions?.some(admission => admission.invitation.id === row.invitationId))
      if (!pending.length) continue
      const admissions = [...(prior.admissions ?? [])], members = [...prior.members], consumed = [...(prior.consumedInvitations ?? [])]
      for (const row of pending) {
        if (!await validateGroupAcceptance(row.acceptance) || row.acceptance!.invitation.admin !== admin || row.acceptance!.invitation.groupId !== cid) continue
        if (!members.includes(row.invitee) && members.length >= MAX_MEMBERS) continue
        if (!members.includes(row.invitee)) members.push(row.invitee)
        if (!admissions.some(admission => admission.invitation.invitee === row.invitee)) admissions.push(row.acceptance!)
        consumed.push(row.invitationId)
      }
      if (sameSet(members, prior.members) && admissions.length === (prior.admissions?.length ?? 0)) continue
      const group = await signGroup({ ...prior, protocol: 2, admissions, members, consumedInvitations: [...new Set(consumed)],
        legacyMembers: [], epoch: prior.epoch + 1, updatedAt: Date.now() }, this.identity)
      await this.queueGroup(group, [...prior.members, ...members])
    }
    this.applyGroupAdmissionStates(); this.emit()
  }
  private async reconcileDepartures() {
    const internal = buildMessagingModel(this.records, this.identity.publicKey, this.contacts, this.preferences, undefined, true)
    for (const conversation of internal.conversations) {
      this.assertActive()
      const group = conversation.group
      if (!group || this.preferences.closedRetention?.includes(group.id) || group.admin !== this.identity.publicKey || !conversation.members.includes(this.identity.publicKey) || sameSet(group.members, conversation.members)) continue
      const updated = await signGroup({ ...group, members: conversation.members, ...(group.protocol === 2 ? { admissions: group.admissions!.filter(a => conversation.members.includes(a.invitation.invitee)), legacyMembers: group.legacyMembers!.filter(member => conversation.members.includes(member)) } : {}), epoch: group.epoch + 1, updatedAt: Date.now() }, this.identity)
      await this.queueGroup(updated, group.members)
    }
  }
  private async sendDeliveryReceipts() {
    this.assertActive()
    const owner = this.identity.publicKey
    const receipted = new Set(this.records.filter(r => r.event.author === owner && r.event.kind === "receipt").map(r => `${conversationForEvent(r.event, owner)}:${r.event.payload.targetId}`))
    for (const message of this.model.messages) {
      this.assertActive()
      if (validGroupId(message.conversationId) || message.senderPubKey === owner || receipted.has(`${message.conversationId}:${message.id}`)) continue
      const conversation = this.model.conversations.find(c => c.id === message.conversationId)
      if (!conversation || conversation.request || conversation.blocked || !conversation.members.includes(owner) || message.route === "direct-only" || this.getDeliveryMode(conversation.id) === "direct-only") continue
      if (message.attachment && !message.attachment.remote && this.getAttachmentChunks(message.conversationId, message.id).length !== message.attachment.chunks) continue
      await this.sendEvent(message.conversationId, "receipt", { targetId: message.id, receipt: "delivered" })
    }

  }
  private async readLegacyInbox() {
    this.assertActive()
    const owner = this.identity.publicKey
    let existing: Map<string, StoredEvent> | undefined
    let changed = false
    let after: { createdAt: number; id: string; senderPubKey: string } | undefined
    for (let page = 0; page < 10 && !this.disposed; page++) {
      const data = after ? { after } : {}
      const proof = await createRequestProof("message:inbox", data, this.identity.privateKey, owner)
      this.assertActive()
      const result = await getLegacyInbox(data, proof)
      this.assertActive()
      if (!result.success) throw new Error(result.error)
      // Most accounts have no legacy traffic. Avoid cloning all modern event
      // history just to check an empty compatibility inbox every five seconds.
      if (result.messages.length && !existing) existing = new Map((await this.storedEvents.read()).map(record => [record.key, record]))
      for (const packet of result.messages) {
        this.assertActive()
        try {
          const envelope = JSON.parse(await decryptFromPeer(packet.encryptedData, this.key!, packet.senderPubKey))
          if (!isEnvelope(envelope, packet.senderPubKey, owner) || envelope.id !== packet.id) continue
          await this.persistLegacyEvents(await legacyMessageEvents(envelope), false, packet.createdAt, existing)
          changed = true
          this.assertActive()
          const ack = { id: packet.id, senderPubKey: packet.senderPubKey }
          const ackProof = await createRequestProof("message:ack", ack, this.identity.privateKey, owner)
          this.assertActive()
          await deleteMessage(ack, ackProof)
        } catch { if (this.disposed) return; /* Keep unpersisted legacy messages at the relay. */ }
      }
      if (!result.nextCursor) break
      after = result.nextCursor
    }
    return changed
  }
}
