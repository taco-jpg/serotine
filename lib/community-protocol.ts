import { arrayBufferToHex, verifySignature } from "./crypto"
import { ID_PATTERN, MAX_MESSAGE_LENGTH, PUBLIC_KEY_PATTERN } from "./protocol"
import type { Identity } from "./identity"
import type { MessagingEvent, MessagingPreferences, StoredEvent } from "./messaging-types"
import type { CommunityEventData, CommunityInvite, CommunityMessage, CommunityModel, CommunityState } from "./community-types"

export const MAX_COMMUNITY_MEMBERS = 20
export const MAX_COMMUNITY_CHANNELS = 8
const MAX_BANS = 100
const SIGNATURE = /^[0-9a-f]{128}$/
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
const text = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && value.length <= max && (empty || !!value.trim())
const uniqueKeys = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(x => typeof x === "string" && PUBLIC_KEY_PATTERN.test(x)) && new Set(value).size === value.length
const exact = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))
const fanout = (members: string[], author: string) => { const peers = members.filter(x => x !== author); return peers.length ? peers : [author] }

export function communityOwner(id: string): string {
  if (typeof id !== "string" || !id.startsWith("community:")) return ""
  const owner = id.slice(10, 140)
  return PUBLIC_KEY_PATTERN.test(owner) && id[140] === ":" && ID_PATTERN.test(id.slice(141)) ? owner : ""
}
export function isCommunityId(id: string): boolean { return !!communityOwner(id) }
export function communityChannelKey(id: string, channelId: string): string { return `${id}:channel:${channelId}` }
export function isCommunityChannelKey(value: string): boolean { const parts = value.split(":channel:"); return parts.length === 2 && isCommunityId(parts[0]) && ID_PATTERN.test(parts[1]) }
export function isCommunityModerator(state: CommunityState, address: string): boolean { return state.members.includes(address) && (state.owner === address || state.moderators.includes(address)) }
export function canPostToCommunityChannel(state: CommunityState, address: string, channelId: string): boolean {
  const channel = state.channels.find(x => x.id === channelId)
  return !!channel && state.members.includes(address) && !state.bans.includes(address) && (channel.posting === "members" || isCommunityModerator(state, address))
}
function stateText(s: Omit<CommunityState, "signature"> | CommunityState) {
  return JSON.stringify(["serotine:community-state:v1", s.id, s.owner, s.name, s.description, s.epoch, s.updatedAt, s.members, s.moderators, s.bans,
    s.channels.map(c => [c.id, c.name, c.posting]), s.admission, s.joiningPaused, s.inviteGeneration])
}
function inviteText(i: Omit<CommunityInvite, "signature"> | CommunityInvite) {
  return JSON.stringify(["serotine:community-invite:v1", i.version, i.communityId, i.owner, i.name, i.description, i.admission, i.history, i.inviteGeneration, i.token, i.expiresAt])
}
async function sign(value: string, identity: Identity) {
  const key = await crypto.subtle.importKey("jwk", { ...identity.privateKey, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  return arrayBufferToHex(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(value)))
}
export async function signCommunityState(value: Omit<CommunityState, "signature">, identity: Identity): Promise<CommunityState> {
  if (value.owner !== identity.publicKey) throw new Error("Only the community owner can sign membership changes.")
  const state = { ...value, signature: await sign(stateText(value), identity) }
  if (!await validateCommunityState(state)) throw new Error("The community settings are invalid.")
  return state
}
export async function validateCommunityState(value: unknown): Promise<boolean> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const s = value as CommunityState
    if (!exact(s, ["id", "owner", "name", "description", "epoch", "updatedAt", "members", "moderators", "bans", "channels", "admission", "joiningPaused", "inviteGeneration", "signature"])
      || communityOwner(s.id) !== s.owner || !PUBLIC_KEY_PATTERN.test(s.owner) || !text(s.name, 80) || !text(s.description, 500, true)
      || !positive(s.epoch) || !positive(s.updatedAt) || s.updatedAt > Date.now() + 60_000 || !positive(s.inviteGeneration)
      || !uniqueKeys(s.members, MAX_COMMUNITY_MEMBERS) || !s.members.includes(s.owner) || !uniqueKeys(s.moderators, MAX_COMMUNITY_MEMBERS)
      || !s.moderators.every(x => x !== s.owner && s.members.includes(x)) || !uniqueKeys(s.bans, MAX_BANS) || s.bans.some(x => s.members.includes(x))
      || !Array.isArray(s.channels) || !s.channels.length || s.channels.length > MAX_COMMUNITY_CHANNELS
      || !s.channels.every(c => c && exact(c, ["id", "name", "posting"]) && ID_PATTERN.test(c.id) && text(c.name, 40) && ["members", "moderators"].includes(c.posting))
      || new Set(s.channels.map(c => c.id)).size !== s.channels.length || new Set(s.channels.map(c => c.name.trim().toLowerCase())).size !== s.channels.length
      || !["direct", "approval"].includes(s.admission) || typeof s.joiningPaused !== "boolean" || !SIGNATURE.test(s.signature)) return false
    return await verifySignature(stateText(s), s.signature, s.owner)
  } catch { return false }
}
export async function signCommunityInvite(value: Omit<CommunityInvite, "signature">, identity: Identity): Promise<CommunityInvite> {
  if (value.owner !== identity.publicKey) throw new Error("Only the community owner can issue invitations.")
  const invite = { ...value, signature: await sign(inviteText(value), identity) }
  if (!await validateCommunityInvite(invite)) throw new Error("The community invitation is invalid or expired.")
  return invite
}
/** now=0 validates historical signed invitations without treating them as currently usable. */
export async function validateCommunityInvite(value: unknown, now = Date.now()): Promise<boolean> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const i = value as CommunityInvite
    if (!exact(i, ["version", "communityId", "owner", "name", "description", "admission", "history", "inviteGeneration", "token", "expiresAt", "signature"])
      || i.version !== 1 || communityOwner(i.communityId) !== i.owner || !PUBLIC_KEY_PATTERN.test(i.owner) || !text(i.name, 80) || !text(i.description, 500, true)
      || !["direct", "approval"].includes(i.admission) || i.history !== "after-join" || !positive(i.inviteGeneration) || !ID_PATTERN.test(i.token)
      || !positive(i.expiresAt) || i.expiresAt <= now || !SIGNATURE.test(i.signature)) return false
    return await verifySignature(inviteText(i), i.signature, i.owner)
  } catch { return false }
}
export function buildCommunityInviteUrl(invite: CommunityInvite, origin: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(invite))
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const url = new URL("/chat/communities", origin)
  url.hash = `community=${token}`
  return url.toString()
}
export async function parseCommunityInvite(input: string, now = Date.now()): Promise<CommunityInvite> {
  try {
    if (typeof input !== "string" || input.length > 8192) throw new Error()
    let token = input.trim()
    if (token.includes("#")) token = new URLSearchParams(token.slice(token.indexOf("#") + 1)).get("community") ?? ""
    else if (token.startsWith("community=")) token = new URLSearchParams(token).get("community") ?? ""
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error()
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/")
    const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0))
    const invite = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    if (!await validateCommunityInvite(invite, now)) throw new Error()
    return invite
  } catch { throw new Error("This community invitation is invalid or expired. Ask its owner for a new link.") }
}

/** The caller also validates the signed v3 envelope and relay sender binding. */
export async function validateCommunityEvent(e: MessagingEvent): Promise<boolean> {
  try {
    const owner = communityOwner(e.conversationId)
    const d = e.payload.community
    if (e.kind !== "community" || !owner || e.group || !d || typeof d !== "object" || Array.isArray(d)
      || !exact(e.payload, ["community"]) || !uniqueKeys(e.recipients, MAX_COMMUNITY_MEMBERS * 2) || !e.recipients.length) return false
    switch (d.type) {
      case "state": return exact(d, ["type", "state", "requestId", "commandId"]) && e.author === owner && d.state.id === e.conversationId && await validateCommunityState(d.state)
        && (d.requestId === undefined || ID_PATTERN.test(d.requestId)) && (d.commandId === undefined || ID_PATTERN.test(d.commandId))
        && d.state.members.every(x => x === e.author || e.recipients.includes(x))
      case "join": return exact(d, ["type", "invite"]) && d.invite.communityId === e.conversationId && e.author !== owner && sameSet(e.recipients, [owner]) && await validateCommunityInvite(d.invite, 0)
      case "decision": return exact(d, ["type", "requestId", "applicant", "status", "reason", "commandId"]) && e.author === owner && ID_PATTERN.test(d.requestId) && PUBLIC_KEY_PATTERN.test(d.applicant)
        && d.status === "rejected" && (d.reason === undefined || text(d.reason, 300)) && (d.commandId === undefined || ID_PATTERN.test(d.commandId)) && sameSet(e.recipients, [d.applicant])
      case "command": return exact(d, ["type", "epoch", "action", "target", "requestId"]) && positive(d.epoch) && ["approve", "reject", "remove", "ban", "unban"].includes(d.action)
        && PUBLIC_KEY_PATTERN.test(d.target) && d.target !== owner && (d.requestId === undefined || ID_PATTERN.test(d.requestId)) && sameSet(e.recipients, [owner])
      case "leave": return exact(d, ["type", "epoch"]) && positive(d.epoch)
      case "message": return exact(d, ["type", "epoch", "channelId", "content", "replyTo", "mentions"]) && positive(d.epoch) && ID_PATTERN.test(d.channelId) && text(d.content, MAX_MESSAGE_LENGTH)
        && (d.replyTo === undefined || ID_PATTERN.test(d.replyTo)) && (d.mentions === undefined || uniqueKeys(d.mentions, MAX_COMMUNITY_MEMBERS))
      case "hide": return exact(d, ["type", "epoch", "channelId", "targetId"]) && positive(d.epoch) && ID_PATTERN.test(d.channelId) && ID_PATTERN.test(d.targetId)
      case "report": return exact(d, ["type", "epoch", "channelId", "targetId", "reason"]) && positive(d.epoch) && ID_PATTERN.test(d.channelId) && ID_PATTERN.test(d.targetId) && text(d.reason, 1000)
      default: return false
    }
  } catch { return false }
}

/** Recheck immediately before encryption; an immutable stale event is cancelled, never rerouted. */
export function communityOutboxError(e: MessagingEvent, model: CommunityModel, owner: string): string | undefined {
  const d = e.payload.community
  if (!d || e.kind !== "community" || e.author !== owner) return "The outgoing community event is invalid."
  const controller = communityOwner(e.conversationId)
  if (d.type === "state" || d.type === "decision") return owner === controller ? undefined : "Only the community owner can publish membership decisions."
  if (d.type === "join") return d.invite.expiresAt > Date.now() ? undefined : "This invitation expired before the request was sent. Ask for a new link."
  const state = model.communities.find(c => c.id === e.conversationId)
  if (!state || state.epoch !== d.epoch || !state.members.includes(owner)) return "Community membership changed. Review the community and send again."
  // A locally queued leave already changes the reducer's effective membership.
  if (d.type === "leave") return sameSet(e.recipients, fanout(state.members, owner)) ? undefined : "The community recipients changed."
  if (!state.effectiveMembers.includes(owner) || !sameSet(state.effectiveMembers, state.members)) return "A member left. Wait for the owner to update membership before sending."
  if (d.type === "command") return isCommunityModerator(state, owner) && sameSet(e.recipients, [controller]) && d.target !== controller
    && (owner === controller || !state.moderators.includes(d.target)) ? undefined : "You no longer have permission to perform this action."
  if (d.type === "report") {
    const staff = [controller, ...state.moderators].filter(x => x !== owner)
    return sameSet(e.recipients, staff.length ? staff : [controller]) ? undefined : "The community moderators changed. Send the report again."
  }
  if (!sameSet(e.recipients, fanout(state.members, owner))) return "The community recipients changed."
  if (d.type === "hide") return isCommunityModerator(state, owner) ? undefined : "You are no longer a community moderator."
  if (d.type === "message") return canPostToCommunityChannel(state, owner, d.channelId) ? undefined : "You cannot post in this channel."
  return "The outgoing community event is unsupported."
}
export function canSendCommunityEvent(e: MessagingEvent, model: CommunityModel, owner: string): boolean { return communityOutboxError(e, model, owner) === undefined }

/** Only cryptographically validated, immutable events may enter this reducer. */
export function buildCommunityModel(records: StoredEvent[], owner: string, preferences: MessagingPreferences): CommunityModel {
  const model: CommunityModel = { communities: [], messages: [], requests: [], reports: [], commands: [], processedIds: [] }
  const states = new Map<string, CommunityState>()
  const departed = new Map<string, Set<string>>()
  const messages = new Map<string, CommunityMessage>()
  const requests = new Map<string, CommunityModel["requests"][number]>()
  const processed = new Set<string>()
  const decisions = new Map<string, { communityId: string; applicant: string; reason?: string }>()
  const approvals = new Map<string, { communityId: string; members: string[] }>()
  const hidden = new Set<string>()
  const seen = new Set<string>()
  const deferred = new Map<string, Map<string, StoredEvent>>()
  const ordered = records.filter(r => r.event.kind === "community" && !r.legacy).sort((a, b) => a.receivedAt - b.receivedAt || (a.sequence && b.sequence ? a.sequence - b.sequence : 0) || a.event.timestamp - b.event.timestamp || a.key.localeCompare(b.key))
  const replay: StoredEvent[] = []
  let cursor = 0
  while (cursor < ordered.length || replay.length) {
    const record = replay.pop() ?? ordered[cursor++]
    const e = record.event, cid = e.conversationId, controller = communityOwner(cid), d = e.payload.community as CommunityEventData
    if (!controller || !d || seen.has(record.key) || (e.author !== owner && !e.recipients.includes(owner))) continue
    seen.add(record.key)
    // Blocking hides content; it cannot revoke a member's right to leave or
    // override authenticated membership decisions and moderation permissions.
    if (preferences.blocked.includes(e.author) && (d.type === "message" || d.type === "report")) continue
    if (d.type === "join") {
      if (d.invite.owner !== controller || d.invite.communityId !== cid || !sameSet(e.recipients, [controller])) continue
      requests.set(e.id, { id: e.id, communityId: cid, author: e.author, timestamp: e.timestamp, invite: d.invite, status: "pending" })
      continue
    }
    if (d.type === "decision") {
      if (e.author !== controller || !sameSet(e.recipients, [d.applicant])) continue
      const request = requests.get(d.requestId)
      if (request && request.communityId === cid && request.author === d.applicant) { request.status = "rejected"; request.reason = d.reason }
      decisions.set(d.requestId, { communityId: cid, applicant: d.applicant, reason: d.reason })
      processed.add(d.requestId); if (d.commandId) processed.add(d.commandId)
      continue
    }
    const prior = states.get(cid)
    if (d.type === "state") {
      if (e.author !== controller || d.state.owner !== controller || d.state.id !== cid || (prior && d.state.epoch === prior.epoch && stateText(d.state) !== stateText(prior))) continue
      // An older authenticated acknowledgement still resolves its request even
      // when a newer owner snapshot arrived first. It never rolls state back.
      if (d.requestId) {
        processed.add(d.requestId)
        approvals.set(d.requestId, { communityId: cid, members: d.state.members })
        const request = requests.get(d.requestId)
        if (request?.communityId === cid && d.state.members.includes(request.author)) request.status = "approved"
      }
      if (d.commandId) processed.add(d.commandId)
      if (prior && d.state.epoch < prior.epoch) continue
      if (!prior || d.state.epoch > prior.epoch) { states.set(cid, d.state); departed.set(cid, new Set()) }
      const waiting = deferred.get(cid)
      if (waiting) {
        const ready: StoredEvent[] = []
        for (const [key, pending] of waiting) {
          const payload = pending.event.payload.community
          if (payload && "epoch" in payload && payload.epoch <= d.state.epoch) {
            waiting.delete(key)
            if (payload.epoch === d.state.epoch) { seen.delete(key); ready.push(pending) }
          }
        }
        for (let index = ready.length - 1; index >= 0; index--) replay.push(ready[index])
        if (!waiting.size) deferred.delete(cid)
      }
      continue
    }
    // Relay fanout from different senders can deliver epoch N content before
    // the owner's epoch N state. Defer only unknown/future epochs. A known
    // newer state permanently rejects stale traffic, including removed peers.
    if (!prior || d.epoch > prior.epoch) {
      const waiting = deferred.get(cid) ?? new Map<string, StoredEvent>()
      waiting.set(record.key, record)
      deferred.set(cid, waiting)
      continue
    }
    // Messages cannot introduce membership, reveal prior history, or roll it back.
    if (!prior || d.epoch !== prior.epoch || !prior.members.includes(e.author) || !prior.members.includes(owner) || prior.bans.includes(e.author)
      || departed.get(cid)?.has(e.author) || departed.get(cid)?.has(controller) || departed.get(cid)?.has(owner)) continue
    const audience = fanout(prior.members, e.author)
    if (d.type === "command") {
      if (!isCommunityModerator(prior, e.author) || !sameSet(e.recipients, [controller]) || d.target === controller
        || (e.author !== controller && prior.moderators.includes(d.target))) continue
      model.commands.push({ id: e.id, communityId: cid, author: e.author, timestamp: e.timestamp, epoch: d.epoch, action: d.action, target: d.target, requestId: d.requestId })
      continue
    }
    if (d.type === "report") {
      const staff = [controller, ...prior.moderators].filter(x => x !== e.author)
      if (!sameSet(e.recipients, staff.length ? staff : [controller]) || !prior.channels.some(c => c.id === d.channelId)) continue
      model.reports.push({ id: e.id, communityId: cid, author: e.author, timestamp: e.timestamp, channelId: d.channelId, targetId: d.targetId, reason: d.reason })
      continue
    }
    if (!sameSet(e.recipients, audience)) continue
    if (d.type === "leave") {
      departed.get(cid)?.add(e.author)
      model.commands.push({ id: e.id, communityId: cid, author: e.author, timestamp: e.timestamp, epoch: d.epoch, action: "leave", target: e.author })
      continue
    }
    if (d.type === "hide") {
      if (isCommunityModerator(prior, e.author) && prior.channels.some(c => c.id === d.channelId)) hidden.add(`${cid}:${d.channelId}:${d.targetId}`)
      continue
    }
    if (d.type === "message" && canPostToCommunityChannel(prior, e.author, d.channelId)) {
      const key = `${cid}:${e.id}`
      if (messages.has(key)) continue
      messages.set(key, { id: e.id, conversationId: cid, channelId: d.channelId, senderPubKey: e.author, content: d.content, timestamp: e.timestamp,
        delivery: record.local ? e.recipients.every(x => record.delivered.includes(x)) ? "sent" : record.error ? "failed" : "pending" : "received",
        pinned: false, hidden: false, replyTo: d.replyTo, mentions: d.mentions, error: record.error, deliveredTo: [], readBy: [] })
    }
  }
  model.messages = [...messages.values()].map(m => ({ ...m, hidden: hidden.has(`${m.conversationId}:${m.channelId}:${m.id}`) })).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  model.requests = [...requests.values()].map(request => {
    const decision = decisions.get(request.id)
    if (decision?.communityId === request.communityId && decision.applicant === request.author) return { ...request, status: "rejected", reason: decision.reason }
    const approval = approvals.get(request.id)
    if (approval?.communityId === request.communityId && approval.members.includes(request.author)) return { ...request, status: "approved" }
    return request
  })
  model.processedIds = [...processed]
  model.commands = model.commands.filter(c => !processed.has(c.id))
  for (const state of states.values()) {
    const left = departed.get(state.id) ?? new Set<string>()
    const effectiveMembers = left.has(state.owner) ? [] : state.members.filter(x => !left.has(x))
    const joined = effectiveMembers.includes(owner)
    const rows = model.messages.filter(m => m.conversationId === state.id && !m.hidden)
    const channelUnread: Record<string, number> = {}
    for (const c of state.channels) {
      const key = communityChannelKey(state.id, c.id)
      channelUnread[c.id] = rows.filter(m => m.channelId === c.id && m.senderPubKey !== owner && m.timestamp > (preferences.readAt[key] ?? 0)).length
    }
    model.communities.push({ ...state, joined, effectiveMembers, channelUnread, unreadCount: joined ? Object.values(channelUnread).reduce((a, b) => a + b, 0) : 0,
      lastMessage: rows.at(-1), notificationMode: preferences.notifications[state.id] ?? "all" })
  }
  model.communities.sort((a, b) => (b.lastMessage?.timestamp ?? b.updatedAt) - (a.lastMessage?.timestamp ?? a.updatedAt))
  return model
}
