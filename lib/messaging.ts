import { CommunityService } from "./community-service"
import { communityOutboxError, communityChannelKey, isCommunityId, validateCommunityEvent } from "./community-protocol"
import { arrayBufferToHex, decryptFromPeer, encryptForPeer, importKey, verifySignature } from "./crypto"
import { loadContacts, shortAddress, validateAddress, type Contact, type Identity } from "./identity"
import { ID_PATTERN, isEnvelope, MAX_MESSAGE_LENGTH, PUBLIC_KEY_PATTERN } from "./protocol"
import { createRequestProof } from "./request-auth"
import { deleteMessage, getEventFeed, getLegacyInbox, storeEncryptedEvent } from "./relay-client"
import { deleteConversationHistoryFromStorage, deleteMessageHistoryFromStorage, exportAllMessagesFromStorage, migrateLegacyHistory } from "./storage"
import { createStoredEventReader, defaultMessagingPreferences, deleteStoredConversation, deleteStoredMessage, deleteStoredCommunityMessage, eventStorageKey, getMessagingPreferences, getSyncCursor, saveMessagingPreferences, saveStoredEvent, saveSyncCursor, saveCommunityUpgrade } from "./messaging-store"
import { isDeletedStoredEvent, isDeletedLegacyMessage } from "./messaging-history"
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_CHUNKS, isAttachmentMeta } from "./attachments"
import { legacyMessageEvents, legacyStoredMessageId, legacyVisibleMessageIds } from "./legacy-messaging"
import { notifyIncoming, requestMessagingNotifications } from "./message-notifications"
import { isPrivateEventExpired, privateDestroyCutoffs } from "./private-messaging"
import { PRIVATE_CHAT_PLUGIN_ID, PluginNegotiation, PluginRegistry, validPluginCapabilities, type PluginAvailability, type PluginCapabilities } from "./plugins"
import type { AttachmentMeta, ConversationRecord, EventKind, EventPayload, GroupState, MessageRecord, MessagingEvent, MessagingModel, MessagingPreferences, NotificationMode, PrivateTtlSeconds, StoredEvent } from "./messaging-types"

const MAX_MEMBERS = 20
const VISIBLE_KINDS = new Set(["message", "poll", "attachment", "private-message"])
const PRIVATE_KINDS = new Set(["private-settings", "private-message", "private-destroy"])
const EVENT_KINDS = new Set(["community", "message", "edit", "pin", "poll", "vote", "receipt", "group", "leave", "attachment", "attachment-chunk", "plugin-capabilities", ...PRIVATE_KINDS])
const PRIVATE_DURATIONS = new Set([0, 300, 3600, 86400])
const validGroupId = (value: string) => typeof value === "string" && value.startsWith("group:") && ID_PATTERN.test(value.slice(6))
const sameSet = (left: string[], right: string[]) => left.length === right.length && left.every(x => right.includes(x))
const validTime = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= Date.now() + 60_000
const validId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value)
const validText = (value: unknown, max = MAX_MESSAGE_LENGTH): value is string => typeof value === "string" && !!value.trim() && value.length <= max
function eventText(e: Omit<MessagingEvent, "signature"> | MessagingEvent) { return JSON.stringify(["serotine:event:v3", e.id, e.author, e.conversationId, e.recipients, e.timestamp, e.kind, e.payload, e.group ?? null]) }
function groupText(g: Omit<GroupState, "signature"> | GroupState) { return JSON.stringify(["serotine:group:v3", g.id, g.name, g.admin, g.members, g.epoch, g.updatedAt]) }
async function signText(text: string, identity: Identity) {
  const key = await crypto.subtle.importKey("jwk", { ...identity.privateKey, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  return arrayBufferToHex(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(text)))
}
export async function signGroup(group: Omit<GroupState, "signature">, identity: Identity): Promise<GroupState> { return { ...group, signature: await signText(groupText(group), identity) } }
export async function signMessagingEvent(event: Omit<MessagingEvent, "signature">, identity: Identity): Promise<MessagingEvent> { return { ...event, signature: await signText(eventText(event), identity) } }
const verifiedGroups = new Map<string, string>()
export async function validateGroup(group: GroupState) {
  if (!group || !validGroupId(group.id) || !validText(group.name, 80) || !PUBLIC_KEY_PATTERN.test(group.admin) || !Array.isArray(group.members) || group.members.length < 1 || group.members.length > MAX_MEMBERS || !group.members.every(x => typeof x === "string" && PUBLIC_KEY_PATTERN.test(x)) || new Set(group.members).size !== group.members.length || !group.members.includes(group.admin) || !Number.isSafeInteger(group.epoch) || group.epoch < 1 || !validTime(group.updatedAt) || typeof group.signature !== "string" || !/^[0-9a-f]{128}$/.test(group.signature)) return false
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
  if (p.capabilities !== undefined && kind !== "plugin-capabilities") return false
  if (p.plugin !== undefined && (!PRIVATE_KINDS.has(kind) || p.plugin?.id !== PRIVATE_CHAT_PLUGIN_ID || p.plugin.version !== "1.0.0" || Object.keys(p.plugin).length !== 2)) return false
  if (!PRIVATE_KINDS.has(kind) && ["expiresAt", "secret", "ttlSeconds", "destroyBefore"].some(key => key in p)) return false
  if (p.replyTo !== undefined && !validId(p.replyTo)) return false
  if (p.mentions !== undefined && (!Array.isArray(p.mentions) || p.mentions.length > MAX_MEMBERS || !p.mentions.every(x => PUBLIC_KEY_PATTERN.test(x)))) return false
  switch (kind) {
    case "community": return Object.keys(p).length === 1 && !!p.community
    case "message": return validText(p.content)
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
    if (e.kind === "community") return !e.group && await validateCommunityEvent(e) && await verifySignature(eventText(e), e.signature, e.author)
    // New event kinds make old clients reject temporary content instead of
    // silently retaining it as an ordinary message.
    if ((PRIVATE_KINDS.has(e.kind) || e.kind === "plugin-capabilities") && (e.group || !PUBLIC_KEY_PATTERN.test(e.conversationId) || e.author === e.conversationId)) return false
    if (e.kind === "private-message" && (e.payload.expiresAt! <= e.timestamp || e.payload.expiresAt! - e.timestamp > 86400_000)) return false
    if (e.kind === "private-destroy" && e.payload.destroyBefore! > e.timestamp) return false
    if (validGroupId(e.conversationId)) {
      if (!e.group || e.group.id !== e.conversationId || !await validateGroup(e.group)) return false
      if (e.kind === "group") { if (e.author !== e.group.admin || !e.group.members.every(x => x === e.author || e.recipients.includes(x))) return false }
      else {
        if (!e.group.members.includes(e.author)) return false
        const expected = e.group.members.filter(x => x !== e.author)
        if (!sameSet(e.recipients, expected.length ? expected : [e.author])) return false
      }
    } else if (!PUBLIC_KEY_PATTERN.test(e.conversationId) || e.group || e.kind === "group" || e.kind === "leave" || e.recipients.length !== 1 || e.recipients[0] !== e.conversationId) return false
    return await verifySignature(eventText(e), e.signature, e.author)
  } catch { return false }
}
export function conversationForEvent(event: MessagingEvent, owner: string): string {
  return validGroupId(event.conversationId) || isCommunityId(event.conversationId) ? event.conversationId : event.author === owner ? event.conversationId : event.author
}
function outboxStatus(record: StoredEvent) {
  if (!record.local) return "received" as const
  return record.event.recipients.every(x => record.delivered.includes(x)) ? "sent" as const : record.error ? "failed" as const : "pending" as const
}
function canSendTo(record: StoredEvent, peer: string) {
  // Older failed records have no per-recipient detail and still need an
  // explicit retry. New failures leave other destinations free to continue.
  return !record.delivered.includes(peer) && (!record.error || (!!record.failedRecipients && !record.failedRecipients.includes(peer)))
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
  const groups = new Map<string, GroupState>()
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
    if (e.kind === "community" || e.kind === "plugin-capabilities") continue
    if (isDeletedStoredEvent(record, owner, preferences)) continue
    if (e.author !== owner && preferences.blocked.includes(e.author)) continue
    if (PRIVATE_KINDS.has(e.kind) && (record.legacy || e.group || e.author === e.conversationId || (e.author !== owner && (e.conversationId !== owner || !e.recipients.includes(owner))))) continue
    if (isPrivateEventExpired(record, owner, destroyCutoffs, now)) continue
    if (e.group) {
      const prior = groups.get(cid)
      if (prior && prior.admin !== e.group.admin) continue
      if (prior && e.group.epoch < prior.epoch) continue
      if (!prior || e.group.epoch > prior.epoch) { groups.set(cid, e.group); left.set(cid, new Set()) }
      else if (JSON.stringify(prior) !== JSON.stringify(e.group)) continue
      if (e.kind !== "group" && (!e.group.members.includes(owner) || left.get(cid)?.has(e.author) || left.get(cid)?.has(owner))) continue
      if (e.kind === "leave") { authorized.add(record.key); if (e.author === e.group.admin) e.group.members.forEach(member => left.get(cid)?.add(member)); else left.get(cid)?.add(e.author); continue }
    }
    authorized.add(record.key)
    if (e.kind === "group") continue
    if (e.kind === "private-settings") {
      const prior = privateSettings.get(cid)
      if (!prior || e.timestamp > prior.timestamp || (e.timestamp === prior.timestamp && e.id.localeCompare(prior.id) > 0)) privateSettings.set(cid, e)
      continue
    }
    if (e.kind === "private-destroy") continue
    const key = `${cid}:${e.id}`
    if (VISIBLE_KINDS.has(e.kind)) {
      if (messages.has(key)) continue
      messages.set(key, { id: e.id, conversationId: cid, senderPubKey: e.author, content: e.payload.content ?? (e.kind === "poll" ? e.payload.question! : ""), timestamp: e.timestamp, delivery: record.legacy && e.author === owner ? "sent" : outboxStatus(record), replyTo: e.payload.replyTo, pinned: false, attachment: e.payload.attachment, poll: e.kind === "poll" ? { question: e.payload.question!, options: [...e.payload.options!], votes: {} } : undefined, mentions: e.payload.mentions, error: record.error, deliveredTo: [], readBy: [], ...(e.kind === "private-message" ? { private: true, expiresAt: e.payload.expiresAt, secret: e.payload.secret ?? false } : {}) })
      continue
    }
    controls.push(record)
  }
  // Controls can arrive ahead of their target across devices or relay pages.
  for (const record of controls) {
    const e = record.event, cid = conversationForEvent(e, owner)
    const target = e.payload.targetId ? messages.get(`${cid}:${e.payload.targetId}`) : undefined
    if (!target) continue
    if (e.kind === "edit" && !target.private && target.senderPubKey === e.author && !target.poll && !target.attachment && (!target.editedAt || e.timestamp >= target.editedAt)) { target.content = e.payload.content!; target.editedAt = e.timestamp }
    if (e.kind === "pin" && !target.private) target.pinned = e.payload.pinned!
    if (e.kind === "vote" && target.poll && e.payload.option! < target.poll.options.length) target.poll.votes[e.author] = e.payload.option!
    if (e.kind === "receipt" && target.senderPubKey === owner && e.author !== owner) {
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
    return { id, kind: group ? "group" : id === owner ? "self" : "direct", name: group?.name ?? (id === owner ? "You" : contacts.find(c => c.pub === id)?.alias || shortAddress(id)), members: group ? group.members.filter(x => !left.get(id)?.has(x)) : id === owner ? [owner] : [owner, id], unreadCount: blocked ? 0 : rows.filter(m => m.senderPubKey !== owner && m.timestamp > (preferences.readAt[id] ?? 0)).length, lastMessage, updatedAt: lastMessage?.timestamp ?? privateSettings.get(id)?.timestamp ?? group?.updatedAt ?? 0, notificationMode: preferences.notifications[id] ?? "all", blocked, request: !known && !blocked, archived: preferences.archived?.includes(id) ?? false, group, sendError: sendErrors.get(id), privateTtlSeconds: privateSettings.get(id)?.payload.ttlSeconds }
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  return { messages: list, groups: [...groups.values()], conversations, requests: conversations.filter(c => c.request && !c.archived) }
}

export class MessagingEngine {
  readonly identity: Identity
  private readonly pluginRegistry: PluginRegistry
  private readonly pluginNegotiation = new PluginNegotiation()
  private readonly observedCapabilities = new Set<string>()
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
  readonly communities: CommunityService
  constructor(identity: Identity) {
    this.identity = identity
    this.pluginRegistry = new PluginRegistry(identity.publicKey)
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
    const key = communityChannelKey(cid, channelId)
    if (this.communityReads.has(key) || (typeof document !== "undefined" && (document.visibilityState !== "visible" || !document.hasFocus()))) return
    const model = this.communities.model
    const community = model.communities.find(item => item.id === cid && item.joined && !item.deleted)
    if (!community?.channels.some(item => item.id === channelId)) return
    const messages = model.messages.filter(message => message.conversationId === cid && message.channelId === channelId && !message.hidden && message.senderPubKey !== this.identity.publicKey)
    const latest = Math.max(0, ...messages.map(message => message.timestamp))
    const readAt = this.preferences.readAt[key] ?? 0
    // File metadata can clear the local unread badge before all bytes arrive.
    // Once complete and visible, acknowledge that file even if its timestamp
    // was already covered; recorded read receipts prevent duplicate sends.
    const unread = this.preferences.readReceipts ? messages.filter(message => !message.readBy.includes(this.identity.publicKey)
      && (message.timestamp > readAt || (message.attachment && (message.attachment.remote || this.communities.getAttachmentChunks(cid, channelId, message.id).length === message.attachment.chunks)))) : []
    if (latest <= readAt && !unread.length) return
    this.communityReads.add(key)
    try {
      if (latest > readAt) await this.updatePreferences(p => ({ ...p, readAt: { ...p.readAt, [key]: Math.max(latest, p.readAt[key] ?? 0) } }))
      if (this.preferences.readReceipts) for (const message of unread) {
        if (!this.preferences.readReceipts || (typeof document !== "undefined" && (document.visibilityState !== "visible" || !document.hasFocus()))) break
        const current = this.communities.model.messages.find(item => item.id === message.id && item.conversationId === cid && item.channelId === channelId && !item.hidden)
        if (!current || current.readBy.includes(this.identity.publicKey) || (current.attachment && !current.attachment.remote && this.communities.getAttachmentChunks(cid, channelId, current.id).length !== current.attachment.chunks)) continue
        await this.communities.receipt(cid, channelId, message.id, "read")
      }
    } finally { this.communityReads.delete(key) }
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
    void this.sync()
  }
  dispose() { this.disposed = true; this.key = undefined; this.pluginNegotiation.revoke(); this.storedEvents.dispose(); clearInterval(this.timer); clearTimeout(this.refreshTimer); clearTimeout(this.expiryTimer); window.removeEventListener("serotine:events", this.storeListener); window.removeEventListener("serotine:contacts", this.storeListener); window.removeEventListener("storage", this.storeListener); window.removeEventListener("storage", this.pluginStorageListener); window.removeEventListener("online", this.sync); window.removeEventListener("focus", this.sync); this.listeners.clear() }
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
      for (const peer of this.preferences.blocked) this.pluginNegotiation.revoke(peer)
      await this.observePluginCapabilities()
      this.assertActive()
      this.model = buildMessagingModel(this.records, this.identity.publicKey, this.contacts, this.preferences, this.authorizedKeys)
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
    const group = this.model.groups.find(g => g.id === cid)
    const conversation = this.model.conversations.find(c => c.id === cid)
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
  sendEvent = async (cid: string, kind: EventKind, payload: EventPayload): Promise<string> => {
    this.assertActive()
    if (!this.key) throw new Error("Your identity is still loading.")
    const owner = this.identity.publicKey
    const startedAt = Date.now()
    const submittedPrivateTtl = this.getPrivateMode(cid.trim().toLowerCase())
    const preferences = await getMessagingPreferences(owner)
    let group: GroupState | undefined
    let recipients: string[]
    if (validGroupId(cid)) { group = this.groupFor(cid); recipients = group.members.filter(x => x !== owner); if (!recipients.length) recipients = [owner] }
    else { cid = await validateAddress(cid); if (this.preferences.blocked.includes(cid)) throw new Error("Unblock this contact before sending a message."); recipients = [cid] }
    this.assertActive()
    if (kind === "community") throw new Error("Use community management to send community events.")
    if (kind === "group") throw new Error("Use group management to update a group.")
    if (kind === "plugin-capabilities" && (!this.trustedPluginPeer(cid) || group || payload.capabilities?.session !== this.pluginNegotiation.session)) throw new Error("Plugin capabilities are exchanged only with accepted direct contacts.")
    if (PRIVATE_KINDS.has(kind) && (group || cid === owner)) throw new Error("Private messages are available only in direct conversations with another person.")
    const targetId = payload.replyTo ?? payload.targetId
    const target = targetId ? this.model.messages.find(message => message.conversationId === cid && message.id === targetId) : undefined
    if (target?.private && (payload.replyTo || kind === "edit" || kind === "pin")) throw new Error("Private messages cannot be replied to, edited, or pinned.")
    const currentPrivateTtl = this.getPrivateMode(cid)
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
    this.assertPrivatePlugin(cid, kind, payload, preferences)
    // Off/destruction retain the legacy wire shape so safety cleanup still
    // reaches an older client that has not installed the plugin-aware release.
    if (kind === "private-message" || (kind === "private-settings" && payload.ttlSeconds)) payload = { ...payload, plugin: { id: PRIVATE_CHAT_PLUGIN_ID, version: "1.0.0" } }
    const event = await signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: owner, conversationId: cid, recipients, timestamp, kind, payload, ...(group ? { group } : {}) }, this.identity)
    if (!await validateMessagingEvent(event)) throw new Error("This message is invalid or too large.")
    await this.queue(event)
    return event.id
  }
  private async queue(event: MessagingEvent) {
    this.assertActive()
    this.assertPrivatePlugin(event.conversationId, event.kind, event.payload)
    const saved = await saveStoredEvent(this.identity.publicKey, { key: eventStorageKey(event), event, local: true, delivered: [], receivedAt: Date.now() })
    if (saved === false) throw new Error(event.kind === "private-message" ? "This private message expired or was destroyed while being prepared. Send a new message." : "This chat was deleted while the message was being prepared. Send a new message to reopen it.")
    this.assertActive()
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
  setPrivateMode = async (cid: string, ttlSeconds: PrivateTtlSeconds) => {
    if (!PRIVATE_DURATIONS.has(ttlSeconds)) throw new Error("Choose Off, 5 minutes, 1 hour, or 24 hours.")
    await this.sendEvent(cid, "private-settings", { ttlSeconds })
  }
  destroyPrivateHistory = async (cid: string) => {
    this.assertActive()
    // A peer clock can be slightly ahead. Include all currently visible private
    // content rather than leaving those already-received messages behind.
    const destroyBefore = Math.max(Date.now(), ...this.model.messages.filter(message => message.conversationId === cid && message.private).map(message => message.timestamp))
    await this.sendEvent(cid, "private-destroy", { destroyBefore })
  }
  sendSecret = async (cid: string, text: string, ttlSeconds = 3600) => {
    this.assertActive()
    if (!ttlSeconds || !PRIVATE_DURATIONS.has(ttlSeconds)) return Promise.reject(new Error("Choose an expiry of 5 minutes, 1 hour, or 24 hours."))
    return this.sendEvent(cid, "private-message", { content: text, expiresAt: Date.now() + ttlSeconds * 1000, secret: true })
  }
  editMessage = async (cid: string, messageId: string, text: string) => {
    this.assertActive()
    const target = this.model.messages.find(m => m.conversationId === cid && m.id === messageId)
    if (!target || target.senderPubKey !== this.identity.publicKey || target.attachment || target.poll || target.private) throw new Error("You can edit your own ordinary text messages.")
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
  createGroup = async (name: string, members: string[]) => {
    this.assertActive()
    const owner = this.identity.publicKey
    const normalized = [...new Set([owner, ...await Promise.all(members.map(validateAddress))])]
    this.assertActive()
    if (normalized.length > MAX_MEMBERS) throw new Error(`Groups can have up to ${MAX_MEMBERS} members.`)
    const group = await signGroup({ id: `group:${crypto.randomUUID()}`, name: name.trim(), admin: owner, members: normalized, epoch: 1, updatedAt: Date.now() }, this.identity)
    if (!await validateGroup(group)) throw new Error("Enter a group name of 1–80 characters.")
    await this.queueGroup(group, normalized)
    return group.id
  }
  private async queueGroup(group: GroupState, members: string[]) {
    this.assertActive()
    let recipients = [...new Set(members)].filter(x => x !== this.identity.publicKey)
    if (!recipients.length) recipients = [this.identity.publicKey]
    const event = await signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: this.identity.publicKey, conversationId: group.id, recipients, timestamp: Date.now(), kind: "group", payload: {}, group }, this.identity)
    if (!await validateMessagingEvent(event)) throw new Error("The group update is invalid.")
    await this.queue(event)
  }
  updateGroup = async (cid: string, changes: { name?: string; members?: string[] }) => {
    const prior = this.groupFor(cid)
    if (prior.admin !== this.identity.publicKey) throw new Error("Only the group creator can change its name or members.")
    const members = changes.members ? [...new Set([prior.admin, ...await Promise.all(changes.members.map(validateAddress))])] : this.model.conversations.find(c => c.id === cid)!.members
    const group = await signGroup({ id: cid, admin: prior.admin, name: changes.name?.trim() ?? prior.name, members, epoch: prior.epoch + 1, updatedAt: Date.now() }, this.identity)
    if (!await validateGroup(group)) throw new Error("Check the group name and member list (maximum 20).")
    await this.queueGroup(group, [...prior.members, ...members])
  }
  leaveGroup = async (cid: string) => {
    this.groupFor(cid)
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
  acceptRequest = async (cid: string) => { await this.updatePreferences(p => ({ ...p, accepted: [...new Set([...p.accepted, cid])] })) }
  blockContact = async (pub: string, blocked = true) => { this.assertActive(); await validateAddress(pub); if (pub === this.identity.publicKey) throw new Error("You cannot block yourself."); this.pluginNegotiation.revoke(pub); await this.updatePreferences(p => ({ ...p, blocked: blocked ? [...new Set([...p.blocked, pub])] : p.blocked.filter(x => x !== pub) })) }
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
    if (this.preferences.readReceipts && conversation && !conversation.request && !conversation.blocked && conversation.members.includes(this.identity.publicKey)) for (const message of unread) await this.sendEvent(cid, "receipt", { targetId: message.id, receipt: "read" })
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
    const communityMessage = directMessage ? undefined : this.communities.model.messages.find(m => m.id === messageId)
    const message = directMessage || communityMessage
    for (const record of await this.storedEvents.read()) {
      const communityData = record.event.payload.community
      const sameCommunityMessage = !communityMessage || (record.event.conversationId === communityMessage.conversationId && record.event.author === communityMessage.senderPubKey && communityData && "channelId" in communityData && communityData.channelId === communityMessage.channelId)
      const matchingChunk = communityMessage
        ? sameCommunityMessage && communityData?.type === "attachment-chunk" && communityData.attachmentId === communityMessage.attachment?.id
        : message?.attachment && record.event.kind === "attachment-chunk" && record.event.payload.attachmentId === message.attachment.id
      if (record.local && record.error && (!messageId || (record.event.id === messageId && sameCommunityMessage) || matchingChunk)) { this.assertActive(); await saveStoredEvent(this.identity.publicKey, { ...record, error: undefined, failedRecipients: undefined }) }
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
        // Apply incoming capability revocations before releasing private outbox
        // content. Ordinary messages keep the established fast delivery path.
        if (this.records.some(record => record.local && (record.event.kind === "private-message" || (record.event.kind === "private-settings" && record.event.payload.ttlSeconds)) && record.event.recipients.some(peer => canSendTo(record, peer)))) await this.readFeed()
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
    const eligible = (record: StoredEvent) => record.local && !record.legacy && (!regularOnly || record.event.kind !== "community")
      && (!skipChunks || !isAttachmentChunk(record.event)) && record.event.recipients.some(peer => canSendTo(record, peer))
    // sync already awaited a current snapshot. Keep its immutable records out
    // of mutable delivery bookkeeping and avoid a second full history read.
    let pending = this.records.filter(eligible).sort(compareOutbox)
    const attempted = new Set<string>()
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
            const data = { id: record.event.id, recipientPubKey, encryptedData }
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
            const result = await storeEncryptedEvent(data, proof)
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
    let hasMore = true
    while (hasMore && !this.disposed) {
      const data = { after }
      const proof = await createRequestProof("event:sync", data, this.identity.privateKey, owner)
      this.assertActive()
      const result = await getEventFeed(data, proof)
      this.assertActive()
      if (!result.success) throw new Error(result.error)
      // Receiving a feed response establishes connectivity before a large
      // history download or the compatibility inbox has finished processing.
      if (this.status !== "online" || this.error) {
        this.status = "online"; this.error = null; this.emit()
      }
      const notifications: string[] = []
      let changed = false
      for (const packet of result.messages) {
        this.assertActive()
        let event: MessagingEvent
        try {
          const peer = packet.senderPubKey === owner ? packet.recipientPubKey : packet.senderPubKey
          event = JSON.parse(await decryptFromPeer(packet.encryptedData, this.key!, peer)) as MessagingEvent
          if (!await validateMessagingEvent(event, packet)) continue
          if (event.author !== owner && !event.recipients.includes(owner)) continue
        } catch { continue } // Invalid ciphertext must not stall unrelated messages.
        this.assertActive()
        const key = eventStorageKey(event)
        const existing = this.records.find(r => r.key === key)
        const record: StoredEvent = { key, event, local: event.author === owner, delivered: event.author === owner ? [packet.recipientPubKey] : [], receivedAt: packet.createdAt, sequence: packet.sequence, error: existing?.error }
        // Persist failures must abort the page before its cursor can advance.
        await saveStoredEvent(owner, record)
        changed = true
        if (!existing && event.author !== owner && (VISIBLE_KINDS.has(event.kind) || (event.kind === "community" && ["message", "attachment", "poll"].includes(event.payload.community?.type ?? ""))) && packet.createdAt >= this.initializedAt) notifications.push(event.id)
      }
      if (changed) await this.refresh()
      await this.respondPluginCapabilities()
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
  private async reconcileDepartures() {
    const internal = buildMessagingModel(this.records, this.identity.publicKey, this.contacts, this.preferences, undefined, true)
    for (const conversation of internal.conversations) {
      this.assertActive()
      const group = conversation.group
      if (!group || group.admin !== this.identity.publicKey || !conversation.members.includes(this.identity.publicKey) || sameSet(group.members, conversation.members)) continue
      const updated = await signGroup({ id: group.id, name: group.name, admin: group.admin, members: conversation.members, epoch: group.epoch + 1, updatedAt: Date.now() }, this.identity)
      await this.queueGroup(updated, group.members)
    }
  }
  private async sendDeliveryReceipts() {
    this.assertActive()
    const owner = this.identity.publicKey
    const receipted = new Set(this.records.filter(r => r.event.author === owner && r.event.kind === "receipt").map(r => `${conversationForEvent(r.event, owner)}:${r.event.payload.targetId}`))
    for (const message of this.model.messages) {
      this.assertActive()
      if (message.senderPubKey === owner || receipted.has(`${message.conversationId}:${message.id}`)) continue
      const conversation = this.model.conversations.find(c => c.id === message.conversationId)
      if (!conversation || conversation.request || conversation.blocked || !conversation.members.includes(owner)) continue
      if (message.attachment && !message.attachment.remote && this.getAttachmentChunks(message.conversationId, message.id).length !== message.attachment.chunks) continue
      await this.sendEvent(message.conversationId, "receipt", { targetId: message.id, receipt: "delivered" })
    }
    const communityAccepted = new Set(this.communities.model.acceptedKeys)
    const communityReceipted = new Set(this.records.flatMap(record => {
      const data = record.event.payload.community
      return communityAccepted.has(record.key) && record.event.author === owner && data?.type === "receipt" ? [`${communityChannelKey(record.event.conversationId, data.channelId)}:${data.targetId}`] : []
    }))
    for (const message of this.communities.model.messages) {
      this.assertActive()
      if (message.hidden || message.senderPubKey === owner || communityReceipted.has(`${communityChannelKey(message.conversationId, message.channelId)}:${message.id}`)) continue
      const community = this.communities.model.communities.find(item => item.id === message.conversationId && item.joined && !item.deleted)
      if (!community || !community.effectiveMembers.includes(message.senderPubKey) || community.members.length !== community.effectiveMembers.length) continue
      if (message.attachment && !message.attachment.remote && this.communities.getAttachmentChunks(message.conversationId, message.channelId, message.id).length !== message.attachment.chunks) continue
      await this.communities.receipt(message.conversationId, message.channelId, message.id, "delivered")
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
