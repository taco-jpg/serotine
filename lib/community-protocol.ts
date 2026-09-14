import { arrayBufferToHex, verifySignature } from "./crypto"
import { ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_CHUNKS, isAttachmentMeta } from "./attachments"
import { ID_PATTERN, MAX_MESSAGE_LENGTH, PUBLIC_KEY_PATTERN } from "./protocol"
import type { Identity } from "./identity"
import type { MessagingEvent, MessagingPreferences, StoredEvent } from "./messaging-types"
import type { CommunityChannel, CommunityEventData, CommunityInvite, CommunityMessage, CommunityModel, CommunityState, CommunityTransfer, CommunitySettingsChanges } from "./community-types"

export const MAX_COMMUNITY_MEMBERS = 20
export const MAX_COMMUNITY_CHANNELS = 8
const MAX_BANS = 100
const SIGNATURE = /^[0-9a-f]{128}$/
const HASH = /^[0-9a-f]{64}$/
export const MAX_COMMUNITY_TRANSFERS = 32
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0
const text = (value: unknown, max: number, empty = false): value is string => typeof value === "string" && value.length <= max && (empty || !!value.trim())
const uniqueKeys = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length <= max && value.every(x => typeof x === "string" && PUBLIC_KEY_PATTERN.test(x)) && new Set(value).size === value.length
const exact = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every(x => b.includes(x))
const fanout = (members: string[], author: string) => { const peers = members.filter(x => x !== author); return peers.length ? peers : [author] }
const postingTypes = new Set(["message", "attachment", "attachment-chunk", "edit", "pin", "poll"])
const contentTypes = new Set([...postingTypes, "vote", "receipt"])
const validId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value)

export function communityOwner(id: string): string {
  if (typeof id !== "string" || !id.startsWith("community:")) return ""
  const owner = id.slice(10, 140)
  return PUBLIC_KEY_PATTERN.test(owner) && id[140] === ":" && ID_PATTERN.test(id.slice(141)) ? owner : ""
}
export function isCommunityId(id: string): boolean { return !!communityOwner(id) }
export function communityChannelKey(id: string, channelId: string): string { return `${id}:channel:${channelId}` }
export function isCommunityChannelKey(value: string): boolean { const parts = value.split(":channel:"); return parts.length === 2 && isCommunityId(parts[0]) && ID_PATTERN.test(parts[1]) }
export function isCommunityCoOwner(state: CommunityState, address: string): boolean { return !state.deleted && state.members.includes(address) && !!state.coOwners?.includes(address) }
export function isCommunityAdmin(state: CommunityState, address: string): boolean { return !state.deleted && state.members.includes(address) && (state.owner === address || isCommunityCoOwner(state, address)) }
export function isCommunityModerator(state: CommunityState, address: string): boolean { return !state.deleted && state.members.includes(address) && (isCommunityAdmin(state, address) || state.moderators.includes(address)) }
export function communityStateReference(state: CommunityState): { stateRef?: string } { return state.version === 2 ? { stateRef: state.signature } : {} }
function canUseCommunityChannel(state: CommunityState, address: string, channel: CommunityChannel | undefined): boolean {
  return !state.deleted && !!channel && state.members.includes(address) && !state.bans.includes(address) && (channel.posting === "members" || isCommunityModerator(state, address))
}
export function canPostToCommunityChannel(state: CommunityState, address: string, channelId: string): boolean {
  const channel = state.channels.find(x => x.id === channelId)
  return channel?.kind !== "voice" && canUseCommunityChannel(state, address, channel)
}
/** Moderators-only voice channels admit owners and moderators; there is no listener role. */
export function canJoinCommunityVoiceChannel(state: CommunityState, address: string, channelId: string): boolean {
  const channel = state.channels.find(x => x.id === channelId)
  return channel?.kind === "voice" && canUseCommunityChannel(state, address, channel)
}
/** Copy only authenticated fields, without adding defaults to legacy signed data. */
export function communityStateSnapshot(state: CommunityState): CommunityState {
  return { id: state.id, owner: state.owner, name: state.name, description: state.description,
    epoch: state.epoch, updatedAt: state.updatedAt, members: [...state.members], moderators: [...state.moderators],
    bans: [...state.bans], channels: state.channels.map(channel => ({ ...channel })), admission: state.admission,
    joiningPaused: state.joiningPaused, inviteGeneration: state.inviteGeneration, signature: state.signature,
    ...(state.version === 2 ? { version: 2, coOwners: [...(state.coOwners ?? [])], transfers: (state.transfers ?? []).map(transfer => ({ ...transfer })), signer: state.signer, deleted: state.deleted } : {}) }
}
function validChannel(value: unknown): value is CommunityChannel {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exact(value, ["id", "name", "posting", "kind"])) return false
  const channel = value as CommunityChannel
  return validId(channel.id) && text(channel.name, 40) && ["members", "moderators"].includes(channel.posting)
    && (!Object.hasOwn(channel, "kind") || channel.kind === "text" || channel.kind === "voice")
}
function channelFields(channel: CommunityChannel) {
  // A fourth item authenticates the new kind. Never append a default to an old
  // channel: both v1 and v2 communities already have signatures over three items.
  const fields = [channel.id, channel.name, channel.posting]
  return channel.kind === undefined ? fields : [...fields, channel.kind]
}
function stateFields(s: Omit<CommunityState, "signature"> | CommunityState) {
  return [s.id, s.owner, s.name, s.description, s.epoch, s.updatedAt, s.members, s.moderators, s.bans,
    s.channels.map(channelFields), s.admission, s.joiningPaused, s.inviteGeneration]
}
function stateText(s: Omit<CommunityState, "signature"> | CommunityState) {
  if (s.version === 2) return JSON.stringify(["serotine:community-state:v2", ...stateFields(s), s.coOwners, s.transfers, s.signer, s.deleted])
  return JSON.stringify(["serotine:community-state:v1", s.id, s.owner, s.name, s.description, s.epoch, s.updatedAt, s.members, s.moderators, s.bans,
    s.channels.map(channelFields), s.admission, s.joiningPaused, s.inviteGeneration])
}
function inviteText(i: Omit<CommunityInvite, "signature"> | CommunityInvite) {
  if (i.version === 2) return JSON.stringify(["serotine:community-invite:v2", i.version, i.communityId, i.owner, i.name, i.description, i.admission, i.history, i.inviteGeneration, i.token, i.expiresAt, i.transfers])
  return JSON.stringify(["serotine:community-invite:v1", i.version, i.communityId, i.owner, i.name, i.description, i.admission, i.history, i.inviteGeneration, i.token, i.expiresAt])
}
function transferText(id: string, t: Omit<CommunityTransfer, "signature">) {
  return JSON.stringify(["serotine:community-transfer:v2", id, t.from, t.to, t.epoch, t.previous, t.stateHash])
}
async function handoffHash(s: Omit<CommunityState, "signature">) {
  return arrayBufferToHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["serotine:community-handoff:v2", ...stateFields(s), s.coOwners, s.signer, s.deleted]))))
}
export async function validateCommunityTransfers(id: string, value: unknown): Promise<boolean> {
  if (!communityOwner(id) || !Array.isArray(value) || value.length > MAX_COMMUNITY_TRANSFERS) return false
  let owner = communityOwner(id), previous = "", epoch = 0
  for (const t of value as CommunityTransfer[]) {
    if (!t || !exact(t, ["from", "to", "epoch", "previous", "stateHash", "signature"]) || t.from !== owner || !PUBLIC_KEY_PATTERN.test(t.to)
      || t.from === t.to || !positive(t.epoch) || t.epoch <= epoch || t.previous !== previous || !HASH.test(t.stateHash) || !SIGNATURE.test(t.signature)
      || !await verifySignature(transferText(id, t), t.signature, owner)) return false
    owner = t.to; previous = t.signature; epoch = t.epoch
  }
  return true
}
function transferOwner(id: string, transfers?: CommunityTransfer[]) { return transfers?.at(-1)?.to ?? communityOwner(id) }
function sameAuthority(a: CommunityState, b: CommunityState) {
  return (a.version === 2) === (b.version === 2) && (a.transfers?.length ?? 0) === (b.transfers?.length ?? 0)
    && (a.transfers ?? []).every((t, index) => t.signature === b.transfers?.[index]?.signature)
}
function authorityExtends(next: CommunityState, prior: CommunityState) {
  return !(prior.version === 2 && next.version !== 2) && (prior.transfers ?? []).every((t, index) => t.signature === next.transfers?.[index]?.signature)
}
function currentReference(state: CommunityState, data: { stateRef?: string }) {
  return state.version === 2 ? data.stateRef === state.signature : data.stateRef === undefined
}
async function sign(value: string, identity: Identity) {
  const key = await crypto.subtle.importKey("jwk", { ...identity.privateKey, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  return arrayBufferToHex(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(value)))
}
export async function signCommunityState(value: Omit<CommunityState, "signature">, identity: Identity): Promise<CommunityState> {
  if (value.owner !== identity.publicKey) throw new Error("Only the community owner can sign membership changes.")
  const unsigned = value.version === 2 ? { ...value, signer: identity.publicKey } : value
  const state = { ...unsigned, signature: await sign(stateText(unsigned), identity) }
  if (!await validateCommunityState(state)) throw new Error("The community settings are invalid.")
  return state
}
/** The departing owner can authorize exactly one handoff snapshot, never future successor states. */
export async function signCommunityTransfer(value: Omit<CommunityState, "signature">, nextOwner: string, identity: Identity): Promise<CommunityState> {
  if (value.version !== 2 || value.owner !== identity.publicKey || value.deleted || !value.members.includes(nextOwner) || nextOwner === value.owner)
    throw new Error("Only the primary owner can transfer this community to a current member.")
  if (!await validateCommunityTransfers(value.id, value.transfers) || transferOwner(value.id, value.transfers) !== identity.publicKey)
    throw new Error("The community ownership proof is invalid.")
  const unsigned = { ...value, owner: nextOwner, signer: identity.publicKey,
    coOwners: value.coOwners?.filter(address => address !== nextOwner), moderators: value.moderators.filter(address => address !== nextOwner) }
  const transfer = { from: identity.publicKey, to: nextOwner, epoch: unsigned.epoch,
    previous: value.transfers?.at(-1)?.signature ?? "", stateHash: await handoffHash(unsigned) }
  unsigned.transfers = [...(value.transfers ?? []), { ...transfer, signature: await sign(transferText(value.id, transfer), identity) }]
  const state = { ...unsigned, signature: await sign(stateText(unsigned), identity) }
  if (!await validateCommunityState(state)) throw new Error("The ownership transfer is invalid or exceeds the transfer limit.")
  return state
}
export async function validateCommunityState(value: unknown): Promise<boolean> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const s = value as CommunityState
    if (!exact(s, ["id", "owner", "name", "description", "epoch", "updatedAt", "members", "moderators", "bans", "channels", "admission", "joiningPaused", "inviteGeneration", "signature", ...(s.version === 2 ? ["version", "coOwners", "transfers", "signer", "deleted"] : [])])
      || !communityOwner(s.id) || !PUBLIC_KEY_PATTERN.test(s.owner) || !text(s.name, 80) || !text(s.description, 500, true)
      || !positive(s.epoch) || !positive(s.updatedAt) || s.updatedAt > Date.now() + 60_000 || !positive(s.inviteGeneration)
      || !uniqueKeys(s.members, MAX_COMMUNITY_MEMBERS) || !s.members.includes(s.owner) || !uniqueKeys(s.moderators, MAX_COMMUNITY_MEMBERS)
      || !s.moderators.every(x => x !== s.owner && s.members.includes(x)) || !uniqueKeys(s.bans, MAX_BANS) || s.bans.some(x => s.members.includes(x))
      || !Array.isArray(s.channels) || !s.channels.length || s.channels.length > MAX_COMMUNITY_CHANNELS
      || !s.channels.every(validChannel)
      || new Set(s.channels.map(c => c.id)).size !== s.channels.length || new Set(s.channels.map(c => c.name.trim().toLowerCase())).size !== s.channels.length
      || !["direct", "approval"].includes(s.admission) || typeof s.joiningPaused !== "boolean" || !SIGNATURE.test(s.signature)) return false
    if (s.version !== 2) return communityOwner(s.id) === s.owner && await verifySignature(stateText(s), s.signature, s.owner)
    if (!uniqueKeys(s.coOwners, MAX_COMMUNITY_MEMBERS) || !s.coOwners.every(x => x !== s.owner && s.members.includes(x) && !s.moderators.includes(x))
      || typeof s.deleted !== "boolean" || !PUBLIC_KEY_PATTERN.test(s.signer ?? "") || !await validateCommunityTransfers(s.id, s.transfers)
      || transferOwner(s.id, s.transfers) !== s.owner || (s.deleted && (!s.joiningPaused || s.coOwners.length > 0 || s.moderators.length > 0))) return false
    const last = s.transfers?.at(-1)
    if (last && s.epoch < last.epoch) return false
    if (s.signer !== s.owner && (!last || s.signer !== last.from || s.epoch !== last.epoch || s.deleted || last.stateHash !== await handoffHash(s))) return false
    return await verifySignature(stateText(s), s.signature, s.signer!)
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
    if (!exact(i, ["version", "communityId", "owner", "name", "description", "admission", "history", "inviteGeneration", "token", "expiresAt", "signature", ...(i.version === 2 ? ["transfers"] : [])])
      || ![1, 2].includes(i.version) || !PUBLIC_KEY_PATTERN.test(i.owner) || !text(i.name, 80) || !text(i.description, 500, true)
      || !["direct", "approval"].includes(i.admission) || i.history !== "after-join" || !positive(i.inviteGeneration) || !ID_PATTERN.test(i.token)
      || !positive(i.expiresAt) || i.expiresAt <= now || !SIGNATURE.test(i.signature)) return false
    if (i.version === 2 ? !await validateCommunityTransfers(i.communityId, i.transfers) || transferOwner(i.communityId, i.transfers) !== i.owner : communityOwner(i.communityId) !== i.owner) return false
    return await verifySignature(inviteText(i), i.signature, i.owner)
  } catch { return false }
}
export function buildCommunityInviteUrl(invite: CommunityInvite, origin: string): string {
  // Compact the public proof for QR codes; verification still uses the complete
  // canonical signed invitation. No membership roster is embedded in an invite.
  const wire = invite.version === 2 ? [2, packHex(communityOwner(invite.communityId)), invite.communityId.slice(141), invite.name, invite.description,
    invite.admission === "direct" ? 0 : 1, invite.inviteGeneration, invite.token, invite.expiresAt, packHex(invite.signature),
    (invite.transfers ?? []).map(t => [packHex(t.to), t.epoch, packHex(t.stateHash), packHex(t.signature)])] : invite
  const bytes = new TextEncoder().encode(JSON.stringify(wire))
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  const url = new URL("/chat/communities", origin)
  url.hash = `community=${token}`
  return url.toString()
}
function packHex(value: string): string { return btoa(String.fromCharCode(...Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }
function unpackHex(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid proof encoding")
  return Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("")
}
function expandInvite(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  if (value.length !== 11 || value[0] !== 2 || ![0, 1].includes(value[5]) || !Array.isArray(value[10]) || value[10].length > MAX_COMMUNITY_TRANSFERS) throw new Error("Invalid invitation encoding")
  const founder = unpackHex(value[1]), communityId = `community:${founder}:${value[2]}`
  let from = founder, previous = ""
  const transfers = value[10].map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== 4) throw new Error("Invalid transfer encoding")
    const transfer = { from, to: unpackHex(row[0]), epoch: row[1], previous, stateHash: unpackHex(row[2]), signature: unpackHex(row[3]) }
    from = transfer.to; previous = transfer.signature
    return transfer
  })
  return { version: 2, communityId, owner: from, name: value[3], description: value[4], admission: value[5] === 0 ? "direct" : "approval", history: "after-join",
    inviteGeneration: value[6], token: value[7], expiresAt: value[8], signature: unpackHex(value[9]), transfers }
}
export async function parseCommunityInvite(input: string, now = Date.now()): Promise<CommunityInvite> {
  try {
    if (typeof input !== "string" || input.length > 48_000) throw new Error()
    let token = input.trim()
    if (token.includes("#")) token = new URLSearchParams(token.slice(token.indexOf("#") + 1)).get("community") ?? ""
    else if (token.startsWith("community=")) token = new URLSearchParams(token).get("community") ?? ""
    if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error()
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/")
    const bytes = Uint8Array.from(atob(base64 + "=".repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0))
    const invite = expandInvite(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) as CommunityInvite
    if (!await validateCommunityInvite(invite, now)) throw new Error()
    return invite
  } catch { throw new Error("This community invitation is invalid or expired. Ask its owner for a new link.") }
}

/** The caller also validates the signed v3 envelope and relay sender binding. */
function validChanges(value: unknown): value is CommunitySettingsChanges {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exact(value, ["name", "description", "admission", "joiningPaused", "channels"]) || !Object.keys(value).length) return false
  const c = value as CommunitySettingsChanges
  return (c.name === undefined || text(c.name, 80)) && (c.description === undefined || text(c.description, 500, true))
    && (c.admission === undefined || ["direct", "approval"].includes(c.admission)) && (c.joiningPaused === undefined || typeof c.joiningPaused === "boolean")
    && (c.channels === undefined || (Array.isArray(c.channels) && c.channels.length > 0 && c.channels.length <= MAX_COMMUNITY_CHANNELS
      && c.channels.every(validChannel)
      && new Set(c.channels.map(channel => channel.id)).size === c.channels.length && new Set(c.channels.map(channel => channel.name.trim().toLowerCase())).size === c.channels.length))
}
function canCommand(state: CommunityState, author: string, d: Extract<CommunityEventData, { type: "command" }>) {
  if (!isCommunityModerator(state, author)) return false
  if (d.action === "update" || d.action === "revoke-invites") return isCommunityAdmin(state, author) && d.target === author
  if (d.target === state.owner || state.coOwners?.includes(d.target)) return false
  if ((d.action === "promote" || d.action === "demote") && !isCommunityAdmin(state, author)) return false
  return isCommunityAdmin(state, author) || !state.moderators.includes(d.target)
}
export async function validateCommunityEvent(e: MessagingEvent): Promise<boolean> {
  try {
    const owner = communityOwner(e.conversationId)
    const d = e.payload.community
    if (e.kind !== "community" || !owner || e.group || !d || typeof d !== "object" || Array.isArray(d)
      || !exact(e.payload, ["community"]) || !uniqueKeys(e.recipients, MAX_COMMUNITY_MEMBERS * 2) || !e.recipients.length) return false
    if ("stateRef" in d && (d.stateRef === undefined || !SIGNATURE.test(d.stateRef))) return false
    switch (d.type) {
      case "state": return exact(d, ["type", "state", "requestId", "commandId"]) && e.author === (d.state.version === 2 ? d.state.signer : owner) && d.state.id === e.conversationId && await validateCommunityState(d.state)
        && (d.requestId === undefined || ID_PATTERN.test(d.requestId)) && (d.commandId === undefined || ID_PATTERN.test(d.commandId))
        && d.state.members.every(x => x === e.author || e.recipients.includes(x))
      case "join": return exact(d, ["type", "invite"]) && d.invite.communityId === e.conversationId && e.author !== d.invite.owner && sameSet(e.recipients, [d.invite.owner]) && await validateCommunityInvite(d.invite, 0)
      case "decision": return exact(d, ["type", "requestId", "applicant", "status", "reason", "commandId", "stateRef", "transfers"])
        && (d.stateRef ? await validateCommunityTransfers(e.conversationId, d.transfers) && e.author === transferOwner(e.conversationId, d.transfers) : d.transfers === undefined && e.author === owner)
        && ID_PATTERN.test(d.requestId) && PUBLIC_KEY_PATTERN.test(d.applicant)
        && d.status === "rejected" && (d.reason === undefined || text(d.reason, 300)) && (d.commandId === undefined || ID_PATTERN.test(d.commandId)) && sameSet(e.recipients, [d.applicant])
      case "command": return exact(d, ["type", "epoch", "action", "target", "requestId", "stateRef", "changes"]) && positive(d.epoch) && ["approve", "reject", "remove", "ban", "unban", "promote", "demote", "update", "revoke-invites"].includes(d.action)
        && PUBLIC_KEY_PATTERN.test(d.target) && (d.requestId === undefined || ID_PATTERN.test(d.requestId)) && e.recipients.length === 1
        && (d.stateRef !== undefined || (d.target !== owner && sameSet(e.recipients, [owner]) && !["promote", "demote", "update", "revoke-invites"].includes(d.action)))
        && (d.action === "update" ? validChanges(d.changes) : d.changes === undefined)
      case "leave": return exact(d, ["type", "epoch", "stateRef"]) && positive(d.epoch)
      case "message": return exact(d, ["type", "epoch", "channelId", "content", "replyTo", "mentions", "stateRef"]) && positive(d.epoch) && ID_PATTERN.test(d.channelId) && text(d.content, MAX_MESSAGE_LENGTH)
        && (d.replyTo === undefined || ID_PATTERN.test(d.replyTo)) && (d.mentions === undefined || uniqueKeys(d.mentions, MAX_COMMUNITY_MEMBERS))
      case "attachment": return exact(d, ["type", "epoch", "channelId", "attachment", "content", "replyTo", "mentions", "stateRef"])
        && positive(d.epoch) && validId(d.channelId) && isAttachmentMeta(d.attachment) && exact(d.attachment, ["id", "name", "mime", "size", "chunks", "sha256", "kind", "duration"])
        && (d.content === undefined || text(d.content, MAX_MESSAGE_LENGTH, true)) && (d.replyTo === undefined || validId(d.replyTo))
        && (d.mentions === undefined || uniqueKeys(d.mentions, MAX_COMMUNITY_MEMBERS))
      case "attachment-chunk": return exact(d, ["type", "epoch", "channelId", "attachmentId", "index", "data", "stateRef"])
        && positive(d.epoch) && validId(d.channelId) && validId(d.attachmentId) && Number.isInteger(d.index) && d.index >= 0 && d.index < MAX_ATTACHMENT_CHUNKS
        && typeof d.data === "string" && d.data.length <= ATTACHMENT_CHUNK_BYTES * 4 / 3 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(d.data)
      case "edit": return exact(d, ["type", "epoch", "channelId", "targetId", "content", "stateRef"])
        && positive(d.epoch) && validId(d.channelId) && validId(d.targetId) && text(d.content, MAX_MESSAGE_LENGTH)
      case "pin": return exact(d, ["type", "epoch", "channelId", "targetId", "pinned", "stateRef"])
        && positive(d.epoch) && validId(d.channelId) && validId(d.targetId) && typeof d.pinned === "boolean"
      case "poll": return exact(d, ["type", "epoch", "channelId", "question", "options", "stateRef"])
        && positive(d.epoch) && validId(d.channelId) && text(d.question, 300) && Array.isArray(d.options) && d.options.length >= 2 && d.options.length <= 10
        && d.options.every(option => text(option, 120)) && new Set(d.options.map(option => option.trim().toLowerCase())).size === d.options.length
      case "vote": return exact(d, ["type", "epoch", "channelId", "targetId", "option", "stateRef"])
        && positive(d.epoch) && validId(d.channelId) && validId(d.targetId) && Number.isInteger(d.option) && d.option >= 0 && d.option < 10
      case "receipt": return exact(d, ["type", "epoch", "channelId", "targetId", "receipt", "stateRef"])
        && positive(d.epoch) && validId(d.channelId) && validId(d.targetId) && ["delivered", "read"].includes(d.receipt)
      case "hide": return exact(d, ["type", "epoch", "channelId", "targetId", "stateRef"]) && positive(d.epoch) && ID_PATTERN.test(d.channelId) && ID_PATTERN.test(d.targetId)
      case "report": return exact(d, ["type", "epoch", "channelId", "targetId", "reason", "stateRef"]) && positive(d.epoch) && ID_PATTERN.test(d.channelId) && ID_PATTERN.test(d.targetId) && text(d.reason, 1000)
      default: return false
    }
  } catch { return false }
}

/** Recheck immediately before encryption; an immutable stale event is cancelled, never rerouted. */
export function communityOutboxError(e: MessagingEvent, model: CommunityModel, owner: string): string | undefined {
  const d = e.payload.community
  if (!d || e.kind !== "community" || e.author !== owner) return "The outgoing community event is invalid."
  const state = model.communities.find(c => c.id === e.conversationId)
  const controller = state?.owner ?? communityOwner(e.conversationId)
  if (d.type === "state") {
    const signer = d.state.version === 2 ? d.state.signer : communityOwner(e.conversationId)
    if (owner !== signer) return "Only the authorized primary owner can publish membership decisions."
    // The retirement fence must still reach old clients after the atomic v2 upgrade.
    const fence = d.state.version !== 2 && d.state.owner === communityOwner(e.conversationId) && d.state.members.length === 1
      && d.state.members[0] === d.state.owner && d.state.joiningPaused && state?.version === 2 && d.state.epoch < state.epoch
    if (fence) return undefined
    if (state?.deleted) return d.state.deleted && d.state.signature === state.signature ? undefined : "This community was deleted."
    if (state && (!sameAuthority(d.state, state) || (d.state.signer !== d.state.owner && d.state.signature !== state.signature)))
      return "Community ownership changed. This old update was cancelled."
    return undefined
  }
  if (d.type === "decision") {
    const request = model.requests.find(item => item.id === d.requestId && item.communityId === e.conversationId && item.author === d.applicant)
    const issuer = d.stateRef ? transferOwner(e.conversationId, d.transfers) : communityOwner(e.conversationId)
    // Refusals queued before a transfer must still reach applicants. They can
    // only resolve invitations issued by that signing primary, never a successor's.
    return owner === issuer && (!request || request.invite.owner === owner) ? undefined : "You cannot decide this invitation request."
  }
  if (state?.deleted) return "This community was deleted."
  if (d.type === "join") return d.invite.expiresAt > Date.now() && (!state || (d.invite.owner === state.owner && d.invite.inviteGeneration === state.inviteGeneration))
    ? undefined : "This invitation expired or was revoked. Ask the current owner for a new link."
  if (!state || state.epoch !== d.epoch || !currentReference(state, d) || !state.members.includes(owner)) return "Community membership changed. Review the community and send again."
  // A locally queued leave already changes the reducer's effective membership.
  if (d.type === "leave") return sameSet(e.recipients, fanout(state.members, owner)) ? undefined : "The community recipients changed."
  if (!state.effectiveMembers.includes(owner) || !sameSet(state.effectiveMembers, state.members)) return "A member left. Wait for the owner to update membership before sending."
  if (d.type === "command") return canCommand(state, owner, d) && sameSet(e.recipients, [controller]) ? undefined : "You no longer have permission to perform this action."
  if (d.type === "report") {
    const staff = [controller, ...(state.coOwners ?? []), ...state.moderators].filter(x => x !== owner)
    return sameSet(e.recipients, staff.length ? staff : [controller]) ? undefined : "The community moderators changed. Send the report again."
  }
  if (!sameSet(e.recipients, fanout(state.members, owner))) return "The community recipients changed."
  if (d.type === "hide") return isCommunityModerator(state, owner) ? undefined : "You are no longer a community moderator."
  if ("channelId" in d && contentTypes.has(d.type)) {
    if (!state.channels.some(channel => channel.id === d.channelId && channel.kind !== "voice")) return "This text channel is no longer available."
    if (postingTypes.has(d.type) && !canPostToCommunityChannel(state, owner, d.channelId)) return "You cannot post in this channel."
    if ("targetId" in d) {
      const target = model.messages.find(message => message.conversationId === e.conversationId && message.channelId === d.channelId && message.id === d.targetId && !message.hidden)
      if (!target) return "This message is no longer available."
      if (d.type === "edit" && (target.senderPubKey !== owner || target.attachment || target.poll)) return "You can edit only your own text messages."
      if (d.type === "vote" && (!target.poll || d.option >= target.poll.options.length)) return "Choose an available poll option."
      if (d.type === "receipt" && target.senderPubKey === owner) return "You cannot acknowledge your own message."
    }
    return undefined
  }
  return "The outgoing community event is unsupported."
}
export function canSendCommunityEvent(e: MessagingEvent, model: CommunityModel, owner: string): boolean { return communityOutboxError(e, model, owner) === undefined }

/** Only cryptographically validated, immutable events may enter this reducer. */
export function buildCommunityModel(records: StoredEvent[], owner: string, preferences: MessagingPreferences): CommunityModel {
  const model: CommunityModel = { communities: [], messages: [], requests: [], reports: [], commands: [], processedIds: [], acceptedKeys: [] }
  const states = new Map<string, CommunityState>()
  const departed = new Map<string, Set<string>>()
  const messages = new Map<string, CommunityMessage>()
  const messageEvents = new Map<string, MessagingEvent>()
  const requests = new Map<string, CommunityModel["requests"][number]>()
  const processed = new Set<string>()
  const accepted = new Set<string>()
  const decisions = new Map<string, { communityId: string; applicant: string; author: string; reason?: string }>()
  const approvals = new Map<string, { communityId: string; members: string[] }>()
  const hidden = new Set<string>()
  const seen = new Set<string>()
  const deferred = new Map<string, Map<string, StoredEvent>>()
  const controls: StoredEvent[] = []
  const ordered = records.filter(r => r.event.kind === "community" && !r.legacy).sort((a, b) => a.receivedAt - b.receivedAt || (a.sequence && b.sequence ? a.sequence - b.sequence : 0) || a.event.timestamp - b.event.timestamp || a.key.localeCompare(b.key))
  const replay: StoredEvent[] = []
  let cursor = 0
  while (cursor < ordered.length || replay.length) {
    const record = replay.pop() ?? ordered[cursor++]
    const e = record.event, cid = e.conversationId, founder = communityOwner(cid), d = e.payload.community as CommunityEventData
    if (!founder || !d || seen.has(record.key) || (e.author !== owner && !e.recipients.includes(owner))) continue
    seen.add(record.key)
    const prior = states.get(cid), controller = prior?.owner ?? founder
    if (prior?.deleted && d.type !== "join" && d.type !== "decision") continue
    // Blocking hides content; it cannot revoke a member's right to leave or
    // override authenticated membership decisions and moderation permissions.
    if (preferences.blocked.includes(e.author) && (contentTypes.has(d.type) || d.type === "report")) continue
    if (d.type === "join") {
      if (d.invite.communityId !== cid || !sameSet(e.recipients, [d.invite.owner])) continue
      requests.set(e.id, { id: e.id, communityId: cid, author: e.author, timestamp: e.timestamp, invite: d.invite, status: "pending" })
      continue
    }
    if (d.type === "decision") {
      if (e.author !== (d.stateRef ? transferOwner(cid, d.transfers) : founder) || !sameSet(e.recipients, [d.applicant])) continue
      const request = requests.get(d.requestId)
      if (request && request.invite.owner !== e.author) continue
      if (request && request.communityId === cid && request.author === d.applicant) { request.status = "rejected"; request.reason = d.reason }
      decisions.set(d.requestId, { communityId: cid, applicant: d.applicant, author: e.author, reason: d.reason })
      processed.add(d.requestId); if (d.commandId && e.author === controller) processed.add(d.commandId)
      continue
    }
    if (d.type === "state") {
      if (e.author !== (d.state.version === 2 ? d.state.signer : founder) || d.state.id !== cid) continue
      const comparable = !prior || sameAuthority(d.state, prior)
      if (prior && comparable && !d.state.deleted && d.state.epoch === prior.epoch && stateText(d.state) !== stateText(prior)) continue
      // An older authenticated acknowledgement still resolves its request even
      // when a newer owner snapshot arrived first. It never rolls state back.
      if (d.requestId) {
        processed.add(d.requestId)
        approvals.set(d.requestId, { communityId: cid, members: d.state.members })
        const request = requests.get(d.requestId)
        if (request?.communityId === cid && d.state.members.includes(request.author)) request.status = "approved"
      }
      if (d.commandId) processed.add(d.commandId)
      if (prior && (!authorityExtends(d.state, prior) || (comparable && !d.state.deleted && d.state.epoch < prior.epoch))) continue
      if (!prior || !comparable || d.state.deleted || d.state.epoch > prior.epoch) { states.set(cid, d.state); departed.set(cid, new Set()) }
      const waiting = deferred.get(cid)
      if (waiting) {
        const ready: StoredEvent[] = []
        for (const [key, pending] of waiting) {
          const payload = pending.event.payload.community
          if (payload && "epoch" in payload && (payload.epoch <= d.state.epoch || payload.stateRef === d.state.signature)) {
            waiting.delete(key)
            if (payload.epoch === d.state.epoch && currentReference(d.state, payload)) { seen.delete(key); ready.push(pending) }
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
    if (!prior || d.epoch > prior.epoch || (d.stateRef && !currentReference(prior, d))) {
      const waiting = deferred.get(cid) ?? new Map<string, StoredEvent>()
      waiting.set(record.key, record)
      deferred.set(cid, waiting)
      continue
    }
    // Messages cannot introduce membership, reveal prior history, or roll it back.
    if (!prior || d.epoch !== prior.epoch || !currentReference(prior, d) || !prior.members.includes(e.author) || !prior.members.includes(owner) || prior.bans.includes(e.author)
      || departed.get(cid)?.has(e.author) || departed.get(cid)?.has(controller) || departed.get(cid)?.has(owner)) continue
    const audience = fanout(prior.members, e.author)
    if (d.type === "command") {
      if (!canCommand(prior, e.author, d) || !sameSet(e.recipients, [controller])) continue
      model.commands.push({ id: e.id, communityId: cid, author: e.author, timestamp: e.timestamp, epoch: d.epoch, action: d.action, target: d.target,
        requestId: d.requestId, changes: d.changes, stateRef: d.stateRef })
      continue
    }
    if (d.type === "report") {
      const staff = [controller, ...(prior.coOwners ?? []), ...prior.moderators].filter(x => x !== e.author)
      if (!sameSet(e.recipients, staff.length ? staff : [controller]) || !prior.channels.some(c => c.id === d.channelId)) continue
      model.reports.push({ id: e.id, communityId: cid, author: e.author, timestamp: e.timestamp, channelId: d.channelId, targetId: d.targetId, reason: d.reason })
      continue
    }
    if (!sameSet(e.recipients, audience)) continue
    if (d.type === "leave") {
      if (prior.version === 2 && e.author === controller) continue
      departed.get(cid)?.add(e.author)
      model.commands.push({ id: e.id, communityId: cid, author: e.author, timestamp: e.timestamp, epoch: d.epoch, action: "leave", target: e.author, stateRef: d.stateRef })
      continue
    }
    if (d.type === "hide") {
      if (isCommunityModerator(prior, e.author) && prior.channels.some(c => c.id === d.channelId)) hidden.add(`${cid}:${d.channelId}:${d.targetId}`)
      continue
    }
    if (!("channelId" in d) || !prior.channels.some(channel => channel.id === d.channelId && channel.kind !== "voice")) continue
    if (postingTypes.has(d.type) && !canPostToCommunityChannel(prior, e.author, d.channelId)) continue
    if (d.type === "attachment-chunk") { accepted.add(record.key); continue }
    if (d.type === "edit" || d.type === "pin" || d.type === "vote" || d.type === "receipt") { controls.push(record); continue }
    if (d.type === "message" || d.type === "attachment" || d.type === "poll") {
      const key = `${cid}:${e.id}`
      if (messages.has(key)) continue
      messages.set(key, { id: e.id, conversationId: cid, channelId: d.channelId, senderPubKey: e.author, content: d.type === "poll" ? "" : d.content ?? "", timestamp: e.timestamp,
        delivery: record.local ? e.recipients.every(x => record.delivered.includes(x)) ? "sent" : record.error ? "failed" : "pending" : "received",
        pinned: false, hidden: false, replyTo: "replyTo" in d ? d.replyTo : undefined, mentions: "mentions" in d ? d.mentions?.filter(address => prior.members.includes(address)) : undefined,
        attachment: d.type === "attachment" ? d.attachment : undefined, poll: d.type === "poll" ? { question: d.question, options: [...d.options], votes: {} } : undefined,
        error: record.error, deliveredTo: [], readBy: [] })
      messageEvents.set(key, e)
      accepted.add(record.key)
    }
  }
  // Effects can precede their target in relay fanout. Only events admitted under
  // their own membership epoch reach this pass; targets never grant authority.
  controls.sort((a, b) => a.event.timestamp - b.event.timestamp || a.event.id.localeCompare(b.event.id))
  for (const { event: e, key } of controls) {
    const d = e.payload.community!
    if (!("targetId" in d) || !("channelId" in d)) continue
    const target = messages.get(`${e.conversationId}:${d.targetId}`)
    if (!target || target.channelId !== d.channelId || hidden.has(`${target.conversationId}:${target.channelId}:${target.id}`)) continue
    const original = messageEvents.get(`${e.conversationId}:${d.targetId}`)!
    if (original.author !== e.author && !original.recipients.includes(e.author)) continue
    if (d.type === "edit" && target.senderPubKey === e.author && !target.attachment && !target.poll) { target.content = d.content; target.editedAt = e.timestamp }
    else if (d.type === "pin") target.pinned = d.pinned
    else if (d.type === "vote" && target.poll && d.option < target.poll.options.length) target.poll.votes[e.author] = d.option
    else if (d.type === "receipt" && target.senderPubKey !== e.author) {
      if (!target.deliveredTo.includes(e.author)) target.deliveredTo.push(e.author)
      if (d.receipt === "read" && !target.readBy.includes(e.author)) target.readBy.push(e.author)
      if (target.senderPubKey === owner) target.delivery = target.readBy.length ? "read" : "delivered"
    } else continue
    accepted.add(key)
  }
  model.messages = [...messages.values()].filter(m => !states.get(m.conversationId)?.deleted && !preferences.deletedMessages?.[m.conversationId]?.messageIds.includes(m.id))
    .map(m => {
      const replied = m.replyTo ? messages.get(`${m.conversationId}:${m.replyTo}`) : undefined
      const original = m.replyTo ? messageEvents.get(`${m.conversationId}:${m.replyTo}`) : undefined
      const visibleReply = replied?.channelId === m.channelId && original && (original.author === m.senderPubKey || original.recipients.includes(m.senderPubKey))
        && !hidden.has(`${m.conversationId}:${m.channelId}:${m.replyTo}`) && !preferences.deletedMessages?.[m.conversationId]?.messageIds.includes(m.replyTo!)
      return { ...m, replyTo: visibleReply ? m.replyTo : undefined, hidden: hidden.has(`${m.conversationId}:${m.channelId}:${m.id}`) }
    }).sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  model.requests = [...requests.values()].map(request => {
    const decision = decisions.get(request.id)
    if (decision?.communityId === request.communityId && decision.applicant === request.author && decision.author === request.invite.owner) return { ...request, status: "rejected", reason: decision.reason }
    const approval = approvals.get(request.id)
    if (approval?.communityId === request.communityId && approval.members.includes(request.author)) return { ...request, status: "approved" }
    return request
  })
  model.processedIds = [...processed]
  model.acceptedKeys = [...accepted]
  model.requests = model.requests.filter(request => !states.get(request.communityId)?.deleted || states.get(request.communityId)?.owner === owner)
  model.commands = model.commands.filter(c => !processed.has(c.id) && !states.get(c.communityId)?.deleted)
  model.reports = model.reports.filter(report => !states.get(report.communityId)?.deleted)
  for (const state of states.values()) {
    const left = departed.get(state.id) ?? new Set<string>()
    const effectiveMembers = state.deleted || left.has(state.owner) ? [] : state.members.filter(x => !left.has(x))
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
