import { arrayBufferToHex, decryptFromPeer, encryptForPeer, importKey, verifySignature } from "./crypto"
import { loadContacts, shortAddress, validateAddress, type Contact, type Identity } from "./identity"
import { ID_PATTERN, isEnvelope, MAX_MESSAGE_LENGTH, PUBLIC_KEY_PATTERN } from "./protocol"
import { createRequestProof } from "./request-auth"
import { deleteMessage, getEventFeed, getLegacyInbox, storeEncryptedEvent } from "./relay-client"
import { exportAllMessagesFromStorage, migrateLegacyHistory } from "./storage"
import { defaultMessagingPreferences, eventStorageKey, getMessagingPreferences, getStoredEvents, getSyncCursor, saveMessagingPreferences, saveStoredEvent, saveSyncCursor } from "./messaging-store"
import { isAttachmentMeta } from "./attachments"
import { notifyIncoming, requestMessagingNotifications } from "./message-notifications"
import type { AttachmentMeta, ConversationRecord, EventKind, EventPayload, GroupState, MessageRecord, MessagingEvent, MessagingModel, MessagingPreferences, NotificationMode, StoredEvent } from "./messaging-types"

const MAX_MEMBERS = 20
const VISIBLE_KINDS = new Set(["message", "poll", "attachment"])
const EVENT_KINDS = new Set(["message", "edit", "pin", "poll", "vote", "receipt", "group", "leave", "attachment", "attachment-chunk"])
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
async function validateGroup(group: GroupState) {
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
  if (p.replyTo !== undefined && !validId(p.replyTo)) return false
  if (p.mentions !== undefined && (!Array.isArray(p.mentions) || p.mentions.length > MAX_MEMBERS || !p.mentions.every(x => PUBLIC_KEY_PATTERN.test(x)))) return false
  switch (kind) {
    case "message": return validText(p.content)
    case "edit": return validId(p.targetId) && validText(p.content)
    case "pin": return validId(p.targetId) && typeof p.pinned === "boolean"
    case "poll": return validText(p.question, 300) && Array.isArray(p.options) && p.options.length >= 2 && p.options.length <= 10 && p.options.every(x => validText(x, 120)) && new Set(p.options.map(x => x.trim().toLowerCase())).size === p.options.length
    case "vote": return validId(p.targetId) && Number.isInteger(p.option) && p.option! >= 0 && p.option! < 10
    case "receipt": return validId(p.targetId) && (p.receipt === "read" || p.receipt === "delivered")
    case "attachment": return validAttachment(p.attachment) && (p.content === undefined || (typeof p.content === "string" && p.content.length <= MAX_MESSAGE_LENGTH))
    case "attachment-chunk": return validId(p.attachmentId) && Number.isInteger(p.index) && p.index! >= 0 && p.index! < 80 && typeof p.data === "string" && p.data.length <= 40960 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data)
    case "group": case "leave": return Object.keys(p).length === 0
    default: return false
  }
}
export async function validateMessagingEvent(value: unknown, transport?: { senderPubKey: string; recipientPubKey: string; id: string }): Promise<boolean> {
  try {
    const e = value as MessagingEvent
    if (!e || e.version !== 3 || !validId(e.id) || !PUBLIC_KEY_PATTERN.test(e.author) || !Array.isArray(e.recipients) || e.recipients.length < 1 || e.recipients.length > MAX_MEMBERS * 2 || !e.recipients.every(x => typeof x === "string" && PUBLIC_KEY_PATTERN.test(x)) || new Set(e.recipients).size !== e.recipients.length || !validTime(e.timestamp) || !EVENT_KINDS.has(e.kind) || !validPayload(e.kind, e.payload) || !/^[0-9a-f]{128}$/.test(e.signature) || JSON.stringify(e).length > 60000) return false
    if (transport && (e.author !== transport.senderPubKey || e.id !== transport.id || !e.recipients.includes(transport.recipientPubKey))) return false
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
  return validGroupId(event.conversationId) ? event.conversationId : event.author === owner ? event.conversationId : event.author
}
function outboxStatus(record: StoredEvent) {
  if (!record.local) return "received" as const
  return record.event.recipients.every(x => record.delivered.includes(x)) ? "sent" as const : record.error ? "failed" as const : "pending" as const
}
/** Only validated immutable events may enter this reducer. Authority is checked again for controls. */
export function buildMessagingModel(records: StoredEvent[], owner: string, contacts: Contact[], preferences: MessagingPreferences, authorizedOutput?: Set<string>): MessagingModel {
  const groups = new Map<string, GroupState>()
  const left = new Map<string, Set<string>>()
  const messages = new Map<string, MessageRecord>()
  const authorized = authorizedOutput ?? new Set<string>()
  authorized.clear()
  const controls: StoredEvent[] = []
  const ordered = [...records].sort((a, b) => a.receivedAt - b.receivedAt || (a.sequence && b.sequence ? a.sequence - b.sequence : 0) || a.event.timestamp - b.event.timestamp || a.key.localeCompare(b.key))
  for (const record of ordered) {
    const e = record.event, cid = conversationForEvent(e, owner)
    if (e.author !== owner && preferences.blocked.includes(e.author)) continue
    if (e.group) {
      const prior = groups.get(cid)
      if (prior && prior.admin !== e.group.admin) continue
      if (prior && e.group.epoch < prior.epoch) continue
      if (!prior || e.group.epoch > prior.epoch) { groups.set(cid, e.group); left.set(cid, new Set()) }
      else if (JSON.stringify(prior) !== JSON.stringify(e.group)) continue
      if (e.kind !== "group" && (!e.group.members.includes(owner) || left.get(cid)?.has(e.author))) continue
      if (e.kind === "leave") { if (e.author === e.group.admin) e.group.members.forEach(member => left.get(cid)?.add(member)); else left.get(cid)?.add(e.author); continue }
    }
    authorized.add(record.key)
    if (e.kind === "group") continue
    const key = `${cid}:${e.id}`
    if (VISIBLE_KINDS.has(e.kind)) {
      if (messages.has(key)) continue
      messages.set(key, { id: e.id, conversationId: cid, senderPubKey: e.author, content: e.payload.content ?? (e.kind === "poll" ? e.payload.question! : ""), timestamp: e.timestamp, delivery: record.legacy && e.author === owner ? "sent" : outboxStatus(record), replyTo: e.payload.replyTo, pinned: false, attachment: e.payload.attachment, poll: e.kind === "poll" ? { question: e.payload.question!, options: [...e.payload.options!], votes: {} } : undefined, mentions: e.payload.mentions, error: record.error, deliveredTo: [], readBy: [] })
      continue
    }
    controls.push(record)
  }
  // Controls can arrive ahead of their target across devices or relay pages.
  for (const record of controls) {
    const e = record.event, cid = conversationForEvent(e, owner)
    const target = e.payload.targetId ? messages.get(`${cid}:${e.payload.targetId}`) : undefined
    if (!target) continue
    if (e.kind === "edit" && target.senderPubKey === e.author && !target.poll && !target.attachment && (!target.editedAt || e.timestamp >= target.editedAt)) { target.content = e.payload.content!; target.editedAt = e.timestamp }
    if (e.kind === "pin") target.pinned = e.payload.pinned!
    if (e.kind === "vote" && target.poll && e.payload.option! < target.poll.options.length) target.poll.votes[e.author] = e.payload.option!
    if (e.kind === "receipt" && target.senderPubKey === owner && e.author !== owner) {
      if (!target.deliveredTo.includes(e.author)) target.deliveredTo.push(e.author)
      if (e.payload.receipt === "read" && !target.readBy.includes(e.author)) target.readBy.push(e.author)
      target.delivery = target.readBy.length ? "read" : "delivered"
    }
  }
  // A file is only sent when its complete chunk set has left the durable outbox.
  for (const message of messages.values()) if (message.attachment && message.senderPubKey === owner) {
    const chunks = ordered.filter(r => authorized.has(r.key) && r.event.kind === "attachment-chunk" && r.event.author === owner && conversationForEvent(r.event, owner) === message.conversationId && r.event.payload.attachmentId === message.attachment!.id)
    if (new Set(chunks.map(r => r.event.payload.index)).size < message.attachment.chunks) message.delivery = "pending"
    else if (chunks.some(r => outboxStatus(r) === "failed")) { message.delivery = "failed"; message.error = chunks.find(r => r.error)?.error }
    else if (chunks.some(r => outboxStatus(r) === "pending")) message.delivery = "pending"
  }
  const list = [...messages.values()].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  const ids = new Set([owner, ...contacts.map(c => c.pub), ...groups.keys(), ...list.map(m => m.conversationId), ...preferences.accepted])
  const conversations: ConversationRecord[] = [...ids].map((id): ConversationRecord => {
    const group = groups.get(id)
    const rows = list.filter(m => m.conversationId === id)
    const lastMessage = rows.at(-1)
    const known = id === owner || contacts.some(c => c.pub === id) || preferences.accepted.includes(id) || rows.some(m => m.senderPubKey === owner) || group?.admin === owner
    const blocked = preferences.blocked.includes(id) || !!(group && preferences.blocked.includes(group.admin))
    return { id, kind: group ? "group" : id === owner ? "self" : "direct", name: group?.name ?? (id === owner ? "You" : contacts.find(c => c.pub === id)?.alias || shortAddress(id)), members: group ? group.members.filter(x => !left.get(id)?.has(x)) : id === owner ? [owner] : [owner, id], unreadCount: blocked ? 0 : rows.filter(m => m.senderPubKey !== owner && m.timestamp > (preferences.readAt[id] ?? 0)).length, lastMessage, updatedAt: lastMessage?.timestamp ?? group?.updatedAt ?? 0, notificationMode: preferences.notifications[id] ?? "all", blocked, request: !known && !blocked, group }
  }).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  return { messages: list, groups: [...groups.values()], conversations, requests: conversations.filter(c => c.request) }
}

export class MessagingEngine {
  readonly identity: Identity
  contacts: Contact[] = []
  records: StoredEvent[] = []
  preferences = defaultMessagingPreferences()
  model: MessagingModel = { conversations: [], messages: [], groups: [], requests: [] }
  status: "connecting" | "online" | "offline" = "connecting"
  error: string | null = null
  private running = false
  private disposed = false
  private listeners = new Set<() => void>()
  private key?: CryptoKey
  private timer?: ReturnType<typeof setInterval>
  private refreshTimer?: ReturnType<typeof setTimeout>
  private initializedAt = Date.now()
  private authorizedKeys = new Set<string>()
  private storeListener = () => { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => { void this.refresh().catch(error => this.fail(error)) }, 40) }
  constructor(identity: Identity) { this.identity = identity }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit() { if (!this.disposed) this.listeners.forEach(listener => listener()) }
  private fail(error: unknown) { this.error = error instanceof Error ? error.message : "Messages could not be synchronized."; this.status = "offline"; this.emit() }
  async start() {
    this.key = await importKey(this.identity.privateKey, "encryption", "private")
    await migrateLegacyHistory(this.identity.publicKey)
    await this.migrateLocalHistory()
    await this.refresh()
    if (this.disposed) return
    window.addEventListener("serotine:events", this.storeListener)
    window.addEventListener("serotine:contacts", this.storeListener)
    window.addEventListener("storage", this.storeListener)
    window.addEventListener("online", this.sync)
    this.timer = setInterval(() => { void this.sync() }, 5000)
    void this.sync()
  }
  dispose() { this.disposed = true; clearInterval(this.timer); clearTimeout(this.refreshTimer); window.removeEventListener("serotine:events", this.storeListener); window.removeEventListener("serotine:contacts", this.storeListener); window.removeEventListener("storage", this.storeListener); window.removeEventListener("online", this.sync); this.listeners.clear() }
  refresh = async () => {
    const [records, preferences] = await Promise.all([getStoredEvents(this.identity.publicKey), getMessagingPreferences(this.identity.publicKey)])
    this.records = records; this.preferences = preferences; this.contacts = loadContacts(this.identity.publicKey)
    this.model = buildMessagingModel(records, this.identity.publicKey, this.contacts, preferences, this.authorizedKeys)
    this.emit()
  }
  private async migrateLocalHistory() {
    const owner = this.identity.publicKey
    const existing = new Set((await getStoredEvents(owner)).map(r => r.key))
    for (const row of await exportAllMessagesFromStorage(owner)) {
      let id = row.id
      if (!ID_PATTERN.test(id)) {
        const hash = arrayBufferToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${row.peerPubKey}:${row.senderPubKey}:${id}`)))
        id = `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`
      }
      const cid = row.senderPubKey === owner ? row.peerPubKey : owner
      const event: MessagingEvent = { version: 3, id, author: row.senderPubKey, conversationId: cid, recipients: [cid], timestamp: row.timestamp, kind: "message", payload: { content: row.content.slice(0, MAX_MESSAGE_LENGTH) }, signature: "" }
      const key = eventStorageKey(event)
      if (existing.has(key)) continue
      const pending = row.senderPubKey === owner && ["pending", "failed"].includes(row.delivery ?? "")
      if (pending) event.signature = await signText(eventText(event), this.identity)
      await saveStoredEvent(owner, { key, event, local: pending, delivered: pending ? [] : [cid], receivedAt: row.timestamp, legacy: !pending })
    }
  }
  private groupFor(cid: string) {
    const group = this.model.groups.find(g => g.id === cid)
    const conversation = this.model.conversations.find(c => c.id === cid)
    if (!group || !conversation?.members.includes(this.identity.publicKey)) throw new Error("You are no longer a member of this group.")
    if (!sameSet(group.members, conversation.members)) throw new Error("A member left. Waiting for the group administrator to update membership before sending.")
    return group
  }
  sendEvent = async (cid: string, kind: EventKind, payload: EventPayload): Promise<string> => {
    if (!this.key) throw new Error("Your identity is still loading.")
    const owner = this.identity.publicKey
    let group: GroupState | undefined
    let recipients: string[]
    if (validGroupId(cid)) { group = this.groupFor(cid); recipients = group.members.filter(x => x !== owner); if (!recipients.length) recipients = [owner] }
    else { cid = await validateAddress(cid); if (this.preferences.blocked.includes(cid)) throw new Error("Unblock this contact before sending a message."); recipients = [cid] }
    if (kind === "group") throw new Error("Use group management to update a group.")
    const event = await signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: owner, conversationId: cid, recipients, timestamp: Date.now(), kind, payload, ...(group ? { group } : {}) }, this.identity)
    if (!await validateMessagingEvent(event)) throw new Error("This message is invalid or too large.")
    await this.queue(event)
    return event.id
  }
  private async queue(event: MessagingEvent) {
    await saveStoredEvent(this.identity.publicKey, { key: eventStorageKey(event), event, local: true, delivered: [], receivedAt: Date.now() })
    // Once durable, a view refresh failure must not make the composer resend it.
    try { await this.refresh() } catch (error) { this.fail(error) }
    void this.sync()
  }
  sendText = (cid: string, text: string, replyTo?: string, mentions?: string[]) => this.sendEvent(cid, "message", { content: text.trim(), ...(replyTo ? { replyTo } : {}), ...(mentions?.length ? { mentions } : {}) })
  editMessage = async (cid: string, messageId: string, text: string) => {
    const target = this.model.messages.find(m => m.conversationId === cid && m.id === messageId)
    if (!target || target.senderPubKey !== this.identity.publicKey || target.attachment || target.poll) throw new Error("You can edit your own text messages.")
    await this.sendEvent(cid, "edit", { targetId: messageId, content: text.trim() })
  }
  pinMessage = async (cid: string, messageId: string, pinned: boolean) => { await this.sendEvent(cid, "pin", { targetId: messageId, pinned }) }
  createPoll = (cid: string, question: string, options: string[]) => this.sendEvent(cid, "poll", { question: question.trim(), options: options.map(x => x.trim()) })
  vote = async (cid: string, messageId: string, option: number) => { await this.sendEvent(cid, "vote", { targetId: messageId, option }) }
  createGroup = async (name: string, members: string[]) => {
    const owner = this.identity.publicKey
    const normalized = [...new Set([owner, ...await Promise.all(members.map(validateAddress))])]
    if (normalized.length > MAX_MEMBERS) throw new Error(`Groups can have up to ${MAX_MEMBERS} members.`)
    const group = await signGroup({ id: `group:${crypto.randomUUID()}`, name: name.trim(), admin: owner, members: normalized, epoch: 1, updatedAt: Date.now() }, this.identity)
    if (!await validateGroup(group)) throw new Error("Enter a group name of 1–80 characters.")
    await this.queueGroup(group, normalized)
    return group.id
  }
  private async queueGroup(group: GroupState, members: string[]) {
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
  private async updatePreferences(change: (value: MessagingPreferences) => MessagingPreferences) {
    const owner = this.identity.publicKey
    const update = async () => { const prior = await getMessagingPreferences(owner); await saveMessagingPreferences(owner, change(prior)) }
    if (navigator.locks) await navigator.locks.request(`serotine:preferences:${owner}`, update); else await update()
    await this.refresh()
  }
  acceptRequest = async (cid: string) => { await this.updatePreferences(p => ({ ...p, accepted: [...new Set([...p.accepted, cid])] })) }
  blockContact = async (pub: string, blocked = true) => { await validateAddress(pub); if (pub === this.identity.publicKey) throw new Error("You cannot block yourself."); await this.updatePreferences(p => ({ ...p, blocked: blocked ? [...new Set([...p.blocked, pub])] : p.blocked.filter(x => x !== pub) })) }
  setNotificationMode = async (cid: string, mode: NotificationMode) => { await this.updatePreferences(p => ({ ...p, notifications: { ...p.notifications, [cid]: mode } })) }
  setReadReceipts = async (enabled: boolean) => { await this.updatePreferences(p => ({ ...p, readReceipts: enabled })) }
  requestNotifications = requestMessagingNotifications
  markRead = async (cid: string) => {
    const messages = this.model.messages.filter(m => m.conversationId === cid && m.senderPubKey !== this.identity.publicKey)
    const latest = Math.max(0, ...messages.map(m => m.timestamp))
    if (latest <= (this.preferences.readAt[cid] ?? 0)) return
    const unread = messages.filter(m => m.timestamp > (this.preferences.readAt[cid] ?? 0))
    await this.updatePreferences(p => ({ ...p, readAt: { ...p.readAt, [cid]: Math.max(latest, p.readAt[cid] ?? 0) } }))
    const conversation = this.model.conversations.find(c => c.id === cid)
    if (this.preferences.readReceipts && conversation && !conversation.request && !conversation.blocked && conversation.members.includes(this.identity.publicKey)) for (const message of unread) await this.sendEvent(cid, "receipt", { targetId: message.id, receipt: "read" })
  }
  getAttachmentChunks = (cid: string, messageId: string): Array<{ index: number; data: string }> => {
    const message = this.model.messages.find(m => m.conversationId === cid && m.id === messageId)
    if (!message?.attachment) return []
    const chunks = new Map<number, string>()
    for (const record of this.records) if (this.authorizedKeys.has(record.key) && record.event.kind === "attachment-chunk" && record.event.author === message.senderPubKey && conversationForEvent(record.event, this.identity.publicKey) === cid && record.event.payload.attachmentId === message.attachment.id && record.event.payload.index! < message.attachment.chunks) chunks.set(record.event.payload.index!, record.event.payload.data!)
    return [...chunks].map(([index, data]) => ({ index, data })).sort((a, b) => a.index - b.index)
  }
  retry = async (messageId?: string) => {
    const message = this.model.messages.find(m => m.id === messageId)
    for (const record of await getStoredEvents(this.identity.publicKey)) if (record.local && record.error && (!messageId || record.event.id === messageId || (message?.attachment && record.event.payload.attachmentId === message.attachment.id))) await saveStoredEvent(this.identity.publicKey, { ...record, error: undefined })
    await this.sync()
  }
  sync = async () => {
    if (this.disposed || this.running || !this.key) return
    this.running = true
    try {
      const run = async () => {
        await this.flushOutbox()
        await this.refresh()
        await this.readFeed()
        await this.readLegacyInbox()
        await this.refresh()
        const failed = this.records.find(r => r.local && r.error && r.event.recipients.some(peer => !r.delivered.includes(peer)))
        this.status = failed ? "offline" : "online"; this.error = failed?.error ?? null
        this.emit()
      }
      if (navigator.locks) await navigator.locks.request(`serotine:sync:${this.identity.publicKey}`, { ifAvailable: true }, async lock => { if (lock) await run() })
      else await run()
    } catch (error) { this.fail(error) } finally { this.running = false; this.emit() }
  }
  private async flushOutbox() {
    const owner = this.identity.publicKey
    const pending = (await getStoredEvents(owner)).filter(r => r.local && !r.legacy && !r.error && r.event.recipients.some(peer => !r.delivered.includes(peer))).sort((a, b) => a.receivedAt - b.receivedAt)
    let failure: Error | undefined
    for (let index = 0; index < pending.length; index += 4) {
      if (this.disposed) return
      await Promise.all(pending.slice(index, index + 4).map(async record => {
        for (const recipientPubKey of record.event.recipients) {
          if (record.delivered.includes(recipientPubKey)) continue
          try {
            const encryptedData = await encryptForPeer(JSON.stringify(record.event), this.key!, recipientPubKey)
            const data = { id: record.event.id, recipientPubKey, encryptedData }
            const proof = await createRequestProof("event:send", data, this.identity.privateKey, owner)
            const result = await storeEncryptedEvent(data, proof)
            if (!result.success) throw new Error(result.error)
            record.delivered = [...new Set([...record.delivered, recipientPubKey])]; delete record.error
            await saveStoredEvent(owner, record)
          } catch (error) { record.error = error instanceof Error ? error.message : "Sending failed. Retry when connected."; failure = new Error(record.error); await saveStoredEvent(owner, record); break }
        }
      }))
      if (failure) break
    }
    if (failure) { this.error = failure.message; this.status = "offline" }
  }
  private async readFeed() {
    const owner = this.identity.publicKey
    let after = await getSyncCursor(owner)
    let hasMore = true
    while (hasMore && !this.disposed) {
      const data = { after }
      const proof = await createRequestProof("event:sync", data, this.identity.privateKey, owner)
      const result = await getEventFeed(data, proof)
      if (!result.success) throw new Error(result.error)
      const notifications: string[] = []
      for (const packet of result.messages) {
        let event: MessagingEvent
        try {
          const peer = packet.senderPubKey === owner ? packet.recipientPubKey : packet.senderPubKey
          event = JSON.parse(await decryptFromPeer(packet.encryptedData, this.key!, peer)) as MessagingEvent
          if (!await validateMessagingEvent(event, packet)) continue
          if (event.author !== owner && !event.recipients.includes(owner)) continue
        } catch { continue } // Invalid ciphertext must not stall unrelated messages.
        const key = eventStorageKey(event)
        const existing = this.records.find(r => r.key === key)
        const record: StoredEvent = { key, event, local: event.author === owner, delivered: event.author === owner ? [packet.recipientPubKey] : [], receivedAt: packet.createdAt, sequence: packet.sequence, error: existing?.error }
        // Persist failures must abort the page before its cursor can advance.
        await saveStoredEvent(owner, record)
        if (!existing && event.author !== owner && VISIBLE_KINDS.has(event.kind) && packet.createdAt >= this.initializedAt) notifications.push(event.id)
      }
      await this.refresh()
      for (const id of notifications) {
        const message = this.model.messages.find(m => m.id === id)
        const conversation = message && this.model.conversations.find(c => c.id === message.conversationId)
        if (message && conversation) void notifyIncoming(message, conversation, owner)
      }
      await this.reconcileDepartures()
      await this.sendDeliveryReceipts()
      after = result.nextCursor
      await saveSyncCursor(owner, after)
      hasMore = result.hasMore
    }
  }
  private async reconcileDepartures() {
    for (const conversation of this.model.conversations) {
      const group = conversation.group
      if (!group || group.admin !== this.identity.publicKey || !conversation.members.includes(this.identity.publicKey) || sameSet(group.members, conversation.members)) continue
      const updated = await signGroup({ id: group.id, name: group.name, admin: group.admin, members: conversation.members, epoch: group.epoch + 1, updatedAt: Date.now() }, this.identity)
      await this.queueGroup(updated, group.members)
    }
  }
  private async sendDeliveryReceipts() {
    const owner = this.identity.publicKey
    const receipted = new Set(this.records.filter(r => r.event.author === owner && r.event.kind === "receipt").map(r => `${conversationForEvent(r.event, owner)}:${r.event.payload.targetId}`))
    for (const message of this.model.messages) {
      if (message.senderPubKey === owner || receipted.has(`${message.conversationId}:${message.id}`)) continue
      const conversation = this.model.conversations.find(c => c.id === message.conversationId)
      if (!conversation || conversation.request || conversation.blocked || !conversation.members.includes(owner)) continue
      if (message.attachment && this.getAttachmentChunks(message.conversationId, message.id).length !== message.attachment.chunks) continue
      await this.sendEvent(message.conversationId, "receipt", { targetId: message.id, receipt: "delivered" })
    }
  }
  private async readLegacyInbox() {
    const owner = this.identity.publicKey
    let after: { createdAt: number; id: string; senderPubKey: string } | undefined
    for (let page = 0; page < 10 && !this.disposed; page++) {
      const data = after ? { after } : {}
      const proof = await createRequestProof("message:inbox", data, this.identity.privateKey, owner)
      const result = await getLegacyInbox(data, proof)
      if (!result.success) throw new Error(result.error)
      for (const packet of result.messages) {
        try {
          const envelope = JSON.parse(await decryptFromPeer(packet.encryptedData, this.key!, packet.senderPubKey))
          if (!isEnvelope(envelope, packet.senderPubKey, owner) || envelope.id !== packet.id) continue
          const event: MessagingEvent = { version: 3, id: envelope.id, author: envelope.sender, conversationId: owner, recipients: [owner], timestamp: envelope.timestamp, kind: "message", payload: { content: envelope.content }, signature: "" }
          await saveStoredEvent(owner, { key: eventStorageKey(event), event, local: false, delivered: [owner], receivedAt: packet.createdAt, legacy: true })
          const ack = { id: packet.id, senderPubKey: packet.senderPubKey }
          await deleteMessage(ack, await createRequestProof("message:ack", ack, this.identity.privateKey, owner))
        } catch { /* Keep unpersisted legacy messages at the relay. */ }
      }
      if (!result.nextCursor) break
      after = result.nextCursor
    }
  }
}
