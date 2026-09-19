import { retentionDescriptor } from "./retention-protocol"
import { requestRetention } from "./retention-client"
import type { Identity } from "./identity"
import type { EventKind, EventPayload, MessagingEvent, MessagingPreferences, StoredEvent } from "./messaging-types"
import { ATTACHMENT_CHUNK_BYTES } from "./attachments"
import type { CommunityAdmission, CommunityChannel, CommunityCommand, CommunityEventData, CommunityJoinRequest, CommunityMessage, CommunityModel, CommunityRecord, CommunityState } from "./community-types"
import { buildCommunityInviteUrl, buildCommunityModel, canPostToCommunityChannel, communityStateReference, isCommunityAdmin, isCommunityCoOwner, isCommunityId, isCommunityModerator, parseCommunityInvite, signCommunityInvite, signCommunityState, signCommunityTransfer, validateCommunityEvent, validateCommunityInvite, validateCommunityState } from "./community-protocol"

export interface CommunityServiceHost {
  identity: Identity
  // Replace these snapshots when their contents change; the model is memoized.
  records: () => StoredEvent[]
  preferences: () => MessagingPreferences
  refresh: () => Promise<void>
  queue: (event: MessagingEvent) => Promise<void>
  queueBatch?: (events: MessagingEvent[]) => Promise<void>
  sign: (event: Omit<MessagingEvent, "signature">) => Promise<MessagingEvent>
  assertActive?: () => void
}
export interface CommunityChanges {
  name?: string; description?: string; admission?: CommunityAdmission; joiningPaused?: boolean; channels?: CommunityChannel[]
}
export type CommunityModerationAction = "remove" | "ban" | "unban" | "promote" | "demote"
type CommunityAttachment = Extract<CommunityEventData, { type: "attachment" }>
type AttachmentPieces = Array<{ index: number; data: string }>
const NO_ATTACHMENT_PIECES: AttachmentPieces = []
const messageKey = (id: string, channelId: string, messageId: string) => JSON.stringify([id, channelId, messageId])
const attachmentKey = (id: string, channelId: string, sender: string, attachmentId: string, epoch: number, stateRef?: string) =>
  JSON.stringify([id, channelId, sender, attachmentId, epoch, stateRef])

// The browser lock coordinates tabs; the promise chain also serializes calls in
// runtimes without Web Locks. Only the owner publishes membership snapshots.
const mutations = new Map<string, Promise<unknown>>()
const MAX_MEMBERS = 20
function mutate<T>(key: string, action: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => typeof navigator !== "undefined" && navigator.locks
    ? await navigator.locks.request(key, async () => await action()) : await action()
  const result = (mutations.get(key) ?? Promise.resolve()).then(run, run)
  mutations.set(key, result)
  void result.finally(() => { if (mutations.get(key) === result) mutations.delete(key) }).catch(() => {})
  return result
}
function snapshot(record: CommunityRecord): CommunityState {
  return { id: record.id, owner: record.owner, name: record.name, description: record.description,
    epoch: record.epoch, updatedAt: record.updatedAt, members: [...record.members], moderators: [...record.moderators],
    bans: [...record.bans], channels: record.channels.map(channel => ({ ...channel })), admission: record.admission,
    joiningPaused: record.joiningPaused, inviteGeneration: record.inviteGeneration, signature: record.signature,
    ...(record.version === 2 ? { version: 2, coOwners: [...(record.coOwners ?? [])], transfers: (record.transfers ?? []).map(transfer => ({ ...transfer })), signer: record.signer, deleted: record.deleted ?? false } : {}) }
}

export class CommunityService {
  private cachedModel?: { records: StoredEvent[]; preferences: MessagingPreferences; value: CommunityModel }
  private cachedIndex?: { model: CommunityModel; messages: Map<string, CommunityMessage>; originals: Map<string, MessagingEvent>; chunks: Map<string, MessagingEvent[]> }
  private validatedPieces = new WeakMap<MessagingEvent, { encoded: string; expected: number; valid: boolean }>()
  private attachmentResults = new WeakMap<CommunityAttachment, { events: MessagingEvent[]; value: AttachmentPieces }>()
  constructor(private readonly host: CommunityServiceHost) {}
  get model() {
    const records = this.host.records(), preferences = this.host.preferences()
    // The engine replaces both snapshots on refresh. Reuse the reducer result
    // across permission checks and renders until either snapshot changes.
    if (this.cachedModel?.records !== records || this.cachedModel.preferences !== preferences)
      this.cachedModel = { records, preferences, value: buildCommunityModel(records, this.address, preferences) }
    return this.cachedModel.value
  }
  private get index() {
    const model = this.model
    if (this.cachedIndex?.model === model) return this.cachedIndex
    const messages = new Map<string, CommunityMessage>(), originals = new Map<string, MessagingEvent>(), chunks = new Map<string, MessagingEvent[]>()
    const accepted = new Set(model.acceptedKeys)
    for (const message of model.messages) if (!message.hidden) messages.set(messageKey(message.conversationId, message.channelId, message.id), message)
    // Rebuild only the small envelope index when history or visibility changes.
    // The immutable event objects keep their validated bytes across receipt,
    // text-message and notification updates; no large file is decoded here.
    for (const { event, key } of this.host.records()) {
      const data = event.payload.community
      if (event.kind !== "community" || !accepted.has(key) || !data || !("channelId" in data)) continue
      if (data.type === "attachment-chunk") {
        const key = attachmentKey(event.conversationId, data.channelId, event.author, data.attachmentId, data.epoch, data.stateRef)
        const pieces = chunks.get(key) ?? []
        pieces.push(event); chunks.set(key, pieces)
      } else if (data.type === "message" || data.type === "attachment" || data.type === "poll") {
        const key = messageKey(event.conversationId, data.channelId, event.id)
        if (messages.get(key)?.senderPubKey === event.author) originals.set(key, event)
      }
    }
    return this.cachedIndex = { model, messages, originals, chunks }
  }
  private get address() { return this.host.identity.publicKey }
  private assertActive() { this.host.assertActive?.() }
  private async locked<T>(id: string, action: () => Promise<T>, refresh = true): Promise<T> {
    if (!isCommunityId(id)) throw new Error("This community address is invalid.")
    return mutate(`serotine:community:${this.address}:${id}`, async () => {
      this.assertActive()
      if (refresh) await this.host.refresh()
      this.assertActive()
      return action()
    })
  }
  private community(id: string, requireJoined = true): CommunityRecord {
    const community = this.model.communities.find(item => item.id === id)
    if (!community) throw new Error("This community has not synchronized yet.")
    if (requireJoined && community.deleted) throw new Error("This community has been deleted.")
    if (requireJoined && !community.joined) throw new Error("You are no longer a member of this community.")
    return community
  }
  private owner(id: string) {
    const community = this.community(id)
    if (community.owner !== this.address) throw new Error("Only the owner can change these community settings.")
    return community
  }
  private moderator(id: string) {
    const community = this.community(id)
    if (!isCommunityModerator(community, this.address)) throw new Error("Only community moderators can do this.")
    return community
  }
  private admin(id: string) {
    const community = this.community(id)
    if (!isCommunityAdmin(community, this.address)) throw new Error("Only the owner or a co-owner can change these community settings.")
    return community
  }
  private recipients(members: string[]) {
    const peers = [...new Set(members)].filter(address => address !== this.address)
    return peers.length ? peers : [this.address]
  }
  private async prepare(id: string, data: CommunityEventData, recipients: string[]): Promise<MessagingEvent> {
    const eventId = data.type === "attachment" ? data.attachment.remote?.messageId ?? crypto.randomUUID() : crypto.randomUUID()
    const timestamp = Date.now()
    if (data.type === "attachment" && data.attachment.remote) {
      const { registerAttachmentDelivery } = await import("./file-upload-client")
      data = { ...data, attachment: await registerAttachmentDelivery(this.host.identity, data.attachment, eventId, [...new Set(recipients)],
        retentionDescriptor(id, this.address, timestamp, undefined, this.community(id).transfers)) }
      this.assertActive()
    }
    const event = await this.host.sign({ version: 3, id: eventId, author: this.address,
      conversationId: id, recipients: [...new Set(recipients)], timestamp, kind: "community", payload: { community: data } })
    if (!await validateCommunityEvent(event)) throw new Error("This community update is invalid or too large.")
    return event
  }
  private async recheck(prior: CommunityRecord, data: CommunityEventData) {
    // File pieces have no visible message yet. Avoid rereading the entire
    // history per piece; metadata still refreshes, and delivery always checks
    // each immutable piece's epoch again before encryption and transmission.
    if (data.type !== "attachment-chunk") await this.host.refresh()
    this.assertActive()
    const current = this.community(prior.id, false)
    if (current.epoch !== prior.epoch || current.signature !== prior.signature ||
      current.effectiveMembers.length !== prior.effectiveMembers.length || current.effectiveMembers.some(address => !prior.effectiveMembers.includes(address)))
      throw new Error("The community changed while this action was being prepared. Review it and try again.")
    if (!current.joined && !(data.type === "decision" && current.owner === this.address)) throw new Error("You are no longer a member of this community.")
    if (["message", "attachment", "attachment-chunk", "edit", "pin", "poll"].includes(data.type) && "channelId" in data && !canPostToCommunityChannel(current, this.address, data.channelId))
      throw new Error("You cannot post in this channel.")
    if (["edit", "pin", "vote", "receipt"].includes(data.type) && "targetId" in data && "channelId" in data)
      this.actionTarget(prior.id, data.channelId, data.type as EventKind, data)
    if ("replyTo" in data && data.replyTo && !this.model.messages.some(message => message.id === data.replyTo && message.conversationId === prior.id && message.channelId === data.channelId && !message.hidden))
      throw new Error("The message you are replying to is no longer available.")
    if (data.type === "attachment" && !data.attachment.remote && this.attachmentChunks(prior.id, data.channelId, this.address, data).length !== data.attachment.chunks)
      throw new Error("The community changed or this upload is incomplete. Attach the file again to restart the transfer.")
    if (data.type === "state" && data.state.owner !== prior.owner && this.model.requests.some(request => request.communityId === prior.id && request.status === "pending"))
      throw new Error("A new join request arrived. Try transferring ownership again so it can be resolved first.")
  }
  private async publish(id: string, data: CommunityEventData, recipients: string[], prior?: CommunityRecord): Promise<string> {
    this.assertActive()
    if (prior && !["state", "decision", "leave"].includes(data.type) && prior.members.length !== prior.effectiveMembers.length)
      throw new Error("A member left. Wait for the owner to update membership before sending.")
    if (prior && data.type !== "state" && data.type !== "join") data = { ...data, ...communityStateReference(prior),
      ...(data.type === "decision" && prior.version === 2 ? { transfers: prior.transfers ?? [] } : {}) }
    const event = await this.prepare(id, data, recipients)
    // Signing can yield long enough for another device's newer owner snapshot to
    // arrive. A stale send must not reinstate a removed member or stale settings.
    if (prior) await this.recheck(prior, data)
    else { await this.host.refresh(); this.assertActive() }
    await this.host.queue(event)
    return event.id
  }
  private async publishState(prior: CommunityRecord, next: CommunityState, context: { requestId?: string; commandId?: string } = {}, transferTo?: string) {
    const upgrading = prior.version !== 2
    if (upgrading && !this.host.queueBatch) throw new Error("Update Serotine before changing this community; its upgrade needs atomic storage.")
    const unsigned = { ...next, version: 2 as const, coOwners: next.coOwners ?? [], transfers: next.transfers ?? [], signer: this.address,
      deleted: next.deleted ?? false, epoch: prior.epoch + (upgrading ? 2 : 1), updatedAt: Math.max(Date.now(), prior.updatedAt + 1) }
    const state = transferTo ? await signCommunityTransfer(unsigned, transferTo, this.host.identity) : await signCommunityState(unsigned, this.host.identity)
    if (!await validateCommunityState(state)) throw new Error("These community settings are invalid or exceed the community limits.")
    const data: CommunityEventData = { type: "state", state, ...context }
    if (upgrading) {
      // Old clients cannot understand v2 ownership, so retire their founder-only
      // view at the same durable boundary as the first upgraded snapshot.
      const legacy = snapshot(prior)
      const fence = await signCommunityState({ ...legacy, epoch: prior.epoch + 1, updatedAt: unsigned.updatedAt,
        members: [prior.owner], moderators: [], joiningPaused: true, inviteGeneration: prior.inviteGeneration + 1 }, this.host.identity)
      const events = [await this.prepare(prior.id, { type: "state", state: fence }, this.recipients(prior.members)),
        await this.prepare(prior.id, data, this.recipients([...prior.members, ...state.members]))]
      await this.recheck(prior, data)
      await this.host.queueBatch!(events)
    } else await this.publish(prior.id, data, this.recipients([...prior.members, ...state.members]), prior)
  }
  private nextState(prior: CommunityRecord) {
    const next = snapshot(prior)
    next.members = [...prior.effectiveMembers]
    next.moderators = next.moderators.filter(address => next.members.includes(address))
    if (next.version === 2) next.coOwners = (next.coOwners ?? []).filter(address => next.members.includes(address))
    return next
  }

  createCommunity = async (options: { name: string; description: string; admission: CommunityAdmission }): Promise<string> => {
    const id = `community:${this.address}:${crypto.randomUUID()}`
    return this.locked(id, async () => {
      const state = await signCommunityState({ id, owner: this.address, name: options.name.trim(), description: options.description.trim(),
        version: 2, coOwners: [], transfers: [], signer: this.address, deleted: false,
        epoch: 1, updatedAt: Date.now(), members: [this.address], moderators: [], bans: [], admission: options.admission,
        joiningPaused: false, inviteGeneration: 1, channels: [
          { id: crypto.randomUUID(), name: "general", posting: "members" },
          { id: crypto.randomUUID(), name: "announcements", posting: "moderators" },
          { id: crypto.randomUUID(), name: "help", posting: "members" },
        ] }, this.host.identity)
      if (!await validateCommunityState(state)) throw new Error("Choose a community name of 1–80 characters and a description of at most 500 characters.")
      await this.publish(id, { type: "state", state }, [this.address])
      return id
    })
  }
  createInvite = async (id: string): Promise<string> => this.locked(id, async () => {
    const community = this.owner(id)
    if (community.joiningPaused) throw new Error("Resume joining before creating an invitation.")
    const invite = await signCommunityInvite({ version: community.version === 2 ? 2 : 1,
      ...(community.version === 2 ? { transfers: community.transfers ?? [] } : {}), communityId: id, owner: community.owner, name: community.name,
      description: community.description, admission: community.admission, history: "after-join", inviteGeneration: community.inviteGeneration,
      token: crypto.randomUUID(), expiresAt: Date.now() + 7 * 86400_000 }, this.host.identity)
    await this.host.refresh()
    const current = this.owner(id)
    if (current.joiningPaused || current.inviteGeneration !== invite.inviteGeneration || current.signature !== community.signature)
      throw new Error("The community changed while this invitation was being prepared. Create another invitation.")
    return buildCommunityInviteUrl(invite, typeof window !== "undefined" ? window.location.origin : "https://serotine.chat")
  })
  joinCommunity = async (input: string): Promise<string> => {
    const invite = await parseCommunityInvite(input)
    return this.locked(invite.communityId, async () => {
      if (this.host.preferences().blocked.includes(invite.owner)) throw new Error("Unblock this community's owner before requesting to join.")
      const known = this.model.communities.find(item => item.id === invite.communityId)
      if (known?.deleted) throw new Error("This community has been deleted.")
      if (known && (known.owner !== invite.owner || known.inviteGeneration !== invite.inviteGeneration))
        throw new Error("This invitation was revoked. Ask the current owner for a new one.")
      if (known?.joined) throw new Error("You have already joined this community.")
      if (this.model.requests.some(request => request.communityId === invite.communityId && request.author === this.address && request.status === "pending"))
        throw new Error("Your join request is already waiting for the owner to synchronize.")
      if (!await validateCommunityInvite(invite)) throw new Error("This invitation has expired or is invalid.")
      await this.publish(invite.communityId, { type: "join", invite }, [invite.owner])
      return invite.communityId
    })
  }
  retryJoinRequest = async (id: string, requestId: string): Promise<string> => this.locked(id, async () => {
    const model = this.model, known = model.communities.find(item => item.id === id)
    if (known?.deleted) throw new Error("This community has been deleted.")
    if (known?.joined) return id
    const request = model.requests.find(item => item.id === requestId && item.communityId === id && item.author === this.address && item.status === "pending")
    if (!request) throw new Error("This join request is no longer pending.")
    if (this.host.preferences().blocked.includes(request.invite.owner)) throw new Error("Unblock this community's owner before retrying.")
    if (known && (known.owner !== request.invite.owner || known.inviteGeneration !== request.invite.inviteGeneration))
      throw new Error("This invitation was revoked. Ask the current owner for a new one.")
    if (!await validateCommunityInvite(request.invite)) throw new Error("This invitation has expired. Ask the owner for a new one.")
    // A new signed envelope reaches an owner who already processed the first
    // request; replaying its old event ID would be deduplicated by the relay.
    await this.publish(id, { type: "join", invite: request.invite }, [request.invite.owner])
    return id
  })
  updateCommunity = async (id: string, changes: CommunityChanges): Promise<void> => this.locked(id, async () => {
    const prior = this.admin(id), next = this.nextState(prior)
    this.applyChanges(next, changes)
    if (this.address !== prior.owner) {
      // Retain only allowed settings fields. Authority fields never cross this
      // API, and the signed command validator checks the settings themselves.
      await this.publish(id, { type: "command", epoch: prior.epoch, action: "update", target: this.address,
        changes: this.settingsChanges(changes) }, [prior.owner], prior)
      return
    }
    await this.publishState(prior, next)
  })
  private settingsChanges(changes: CommunityChanges): CommunityChanges {
    return { ...(changes.name !== undefined ? { name: changes.name.trim() } : {}),
      ...(changes.description !== undefined ? { description: changes.description.trim() } : {}),
      ...(changes.admission !== undefined ? { admission: changes.admission } : {}),
      ...(changes.joiningPaused !== undefined ? { joiningPaused: changes.joiningPaused } : {}),
      ...(changes.channels !== undefined ? { channels: changes.channels.map(channel => ({ id: channel.id, name: channel.name.trim(), posting: channel.posting,
        ...(channel.kind !== undefined ? { kind: channel.kind } : {}) })) } : {}) }
  }
  private applyChanges(next: CommunityState, changes: CommunityChanges) {
    if (changes.name !== undefined) next.name = changes.name.trim()
    if (changes.description !== undefined) next.description = changes.description.trim()
    if (changes.admission !== undefined) next.admission = changes.admission
    if (changes.joiningPaused !== undefined) next.joiningPaused = changes.joiningPaused
    if (changes.channels !== undefined) next.channels = changes.channels.map(channel => ({ ...channel, name: channel.name.trim() }))
  }
  revokeInvites = async (id: string): Promise<void> => this.locked(id, async () => {
    const prior = this.admin(id), next = this.nextState(prior)
    if (this.address !== prior.owner) {
      await this.publish(id, { type: "command", epoch: prior.epoch, action: "revoke-invites", target: this.address }, [prior.owner], prior)
      return
    }
    next.inviteGeneration++
    await this.publishState(prior, next)
  })
  setCoOwner = async (id: string, target: string, enabled: boolean): Promise<void> => this.locked(id, async () => {
    const prior = this.owner(id), next = this.nextState(prior)
    if (target === prior.owner) throw new Error("The primary owner already has full control.")
    if (!prior.effectiveMembers.includes(target)) throw new Error("Only a current member can be made a co-owner.")
    next.coOwners = enabled ? [...new Set([...(next.coOwners ?? []), target])] : (next.coOwners ?? []).filter(address => address !== target)
    if (enabled) next.moderators = next.moderators.filter(address => address !== target)
    await this.publishState(prior, next)
  })
  transferOwnership = async (id: string, target: string, keepAsCoOwner = false): Promise<void> => this.locked(id, async () => {
    let prior = this.owner(id)
    if (target === prior.owner) throw new Error("This person already owns the community.")
    if (!prior.effectiveMembers.includes(target)) throw new Error("Ownership can only be transferred to a current member.")
    // Applicants only know the inviting owner. Resolve their outstanding
    // requests before changing that authority, then revoke all existing links.
    await this.rejectPending(prior, "Ownership changed. Ask the new owner for a fresh invitation.")
    prior = this.owner(id)
    if (!prior.effectiveMembers.includes(target)) throw new Error("The new owner is no longer a member.")
    const next = this.nextState(prior)
    next.inviteGeneration++
    next.coOwners = (next.coOwners ?? []).filter(address => address !== target && address !== this.address)
    if (keepAsCoOwner) next.coOwners.push(this.address)
    next.moderators = next.moderators.filter(address => address !== this.address && address !== target)
    await this.publishState(prior, next, {}, target)
  })
  deleteCommunity = async (id: string): Promise<void> => this.locked(id, async () => {
    let prior = this.owner(id)
    await this.rejectPending(prior, "This community has been deleted.")
    prior = this.owner(id)
    const next = this.nextState(prior)
    await requestRetention(this.host.identity, "retention:close", retentionDescriptor(id, this.address, Date.now(), undefined, prior.transfers))
    this.assertActive()
    next.deleted = true
    next.coOwners = []
    next.moderators = []
    next.joiningPaused = true
    next.inviteGeneration++
    await this.publishState(prior, next)
  })
  private async rejectPending(prior: CommunityRecord, reason: string) {
    const pending = this.model.requests.filter(request => request.communityId === prior.id && request.status === "pending")
    for (const request of pending) if (this.model.requests.some(item => item.id === request.id && item.status === "pending"))
      await this.resolveRequest(prior, request, false, undefined, reason)
  }
  moderate = async (id: string, action: CommunityModerationAction, target: string): Promise<void> => this.locked(id, async () => {
    const prior = this.moderator(id)
    if (target === prior.owner) throw new Error("The community owner cannot be removed or demoted.")
    if (isCommunityCoOwner(prior, target)) throw new Error("The owner must remove this person's co-owner role before moderating them.")
    if (target === this.address) throw new Error("Use Leave community to leave, or ask the owner to change your role.")
    if ((action === "promote" || action === "demote") && !isCommunityAdmin(prior, this.address))
      throw new Error("Only the owner or a co-owner can change moderator roles.")
    if (!isCommunityAdmin(prior, this.address) && prior.moderators.includes(target)) throw new Error("Only the owner or a co-owner can moderate another moderator.")
    if (action !== "unban" && !prior.effectiveMembers.includes(target)) throw new Error("This person is no longer a member.")
    if (action === "unban" && !prior.bans.includes(target)) throw new Error("This person is not banned.")
    if (this.address !== prior.owner) {
      await this.publish(id, { type: "command", epoch: prior.epoch, action, target }, [prior.owner], prior)
      return
    }
    const next = this.nextState(prior)
    if (action === "promote") next.moderators = [...new Set([...next.moderators, target])]
    else if (action === "demote") next.moderators = next.moderators.filter(address => address !== target)
    else this.applyModeration(next, action, target)
    await this.publishState(prior, next)
  })
  private applyModeration(state: CommunityState, action: "remove" | "ban" | "unban", target: string) {
    if (action === "unban") state.bans = state.bans.filter(address => address !== target)
    else {
      state.members = state.members.filter(address => address !== target)
      state.moderators = state.moderators.filter(address => address !== target)
      if (state.version === 2) state.coOwners = (state.coOwners ?? []).filter(address => address !== target)
      if (action === "ban") state.bans = [...new Set([...state.bans, target])]
    }
  }
  approveRequest = (id: string, requestId: string): Promise<void> => this.decide(id, requestId, true)
  rejectRequest = (id: string, requestId: string): Promise<void> => this.decide(id, requestId, false)
  private async decide(id: string, requestId: string, approve: boolean) {
    return this.locked(id, async () => {
      const prior = this.moderator(id)
      const request = this.model.requests.find(item => item.id === requestId && item.communityId === id && item.status === "pending")
      if (!request) throw new Error("This join request has already been resolved.")
      if (this.address !== prior.owner) {
        await this.publish(id, { type: "command", epoch: prior.epoch, action: approve ? "approve" : "reject", target: request.author, requestId }, [prior.owner], prior)
      } else await this.resolveRequest(prior, request, approve)
    })
  }
  private async resolveRequest(prior: CommunityRecord, request: CommunityJoinRequest, approve: boolean, commandId?: string, rejectionReason?: string) {
    if (approve && !prior.deleted && request.invite.owner === prior.owner && prior.effectiveMembers.includes(request.author) && !prior.bans.includes(request.author)) {
      const context = { requestId: request.id, ...(commandId ? { commandId } : {}) }
      // The owner may have saved admission before its relay delivery failed.
      // A member can recover that acknowledgement even after joining is paused
      // or invites are revoked. This never grants membership or replays history.
      if (prior.members.length !== prior.effectiveMembers.length || (prior.version === 2 && prior.signer !== this.address))
        await this.publishState(prior, this.nextState(prior), context)
      else await this.publish(prior.id, { type: "state", state: snapshot(prior), ...context }, this.recipients(prior.members), prior)
      return
    }
    let reason = approve ? "" : rejectionReason ?? "A moderator declined your request."
    if (approve) {
      if (prior.deleted) reason = "This community has been deleted."
      else if (request.invite.owner !== prior.owner) reason = "Ownership changed. Ask the new owner for a fresh invitation."
      else if (!await validateCommunityInvite(request.invite)) reason = "This invitation has expired or is invalid."
      else if (request.invite.inviteGeneration !== prior.inviteGeneration) reason = "This invitation was revoked. Ask for a new one."
      else if (prior.joiningPaused) reason = "Joining is currently paused."
      else if (prior.bans.includes(request.author) || this.host.preferences().blocked.includes(request.author)) reason = "This community is not accepting this request."
      else if (!prior.effectiveMembers.includes(request.author) && prior.effectiveMembers.length >= MAX_MEMBERS) reason = "This community is full (20 members)."
    }
    if (reason) {
      // Explicit rejection also resolves retries shown as one applicant in the
      // UI. Resolve siblings first so a failed write leaves the chosen request
      // and any moderator command pending until all refusals are durable.
      const retries = approve ? [] : this.model.requests.filter(item => item.communityId === prior.id && item.author === request.author && item.status === "pending" && item.id !== request.id)
      for (const pending of [...retries, request]) await this.publish(prior.id, { type: "decision", requestId: pending.id, applicant: pending.author, status: "rejected", reason,
        ...(commandId && pending.id === request.id ? { commandId } : {}) }, [pending.author], prior)
      return
    }
    const next = this.nextState(prior)
    next.members = [...new Set([...next.members, request.author])]
    await this.publishState(prior, next, { requestId: request.id, ...(commandId ? { commandId } : {}) })
  }
  leave = async (id: string): Promise<void> => this.locked(id, async () => {
    const community = this.community(id)
    if (community.owner === this.address) throw new Error("Transfer ownership or delete the community before leaving.")
    await this.publish(id, { type: "leave", epoch: community.epoch }, this.recipients(community.members), community)
  })
  private actionTarget(id: string, channelId: string, kind: EventKind, payload: EventPayload) {
    const key = messageKey(id, channelId, payload.targetId ?? ""), index = this.index
    const target = index.messages.get(key)
    if (!target) throw new Error("This message is no longer available in this channel.")
    const original = index.originals.get(key)
    if (!original || (original.author !== this.address && !original.recipients.includes(this.address))) throw new Error("This message is not part of your community history.")
    if (kind === "edit" && (target.senderPubKey !== this.address || target.attachment || target.poll || target.shared)) throw new Error("You can edit your own ordinary text messages.")
    if (kind === "vote" && (!target.poll || !Number.isInteger(payload.option) || payload.option! < 0 || payload.option! >= target.poll.options.length)) throw new Error("Choose an available poll option.")
    if (kind === "receipt" && target.senderPubKey === this.address) throw new Error("You cannot acknowledge your own message.")
    return target
  }
  sendEvent = async (id: string, channelId: string, kind: EventKind, payload: EventPayload): Promise<string> => this.locked(id, async () => {
    if (kind === "receipt") throw new Error("Channel reads remain on this device; receipts are not sent.")
    const community = this.community(id)
    if (!["message", "attachment", "attachment-chunk", "edit", "pin", "poll", "vote", "receipt"].includes(kind)) throw new Error("This feature is not available in community channels.")
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || ["type", "epoch", "channelId", "stateRef"].some(key => key in payload)) throw new Error("This community message is invalid.")
    if (!community.channels.some(channel => channel.id === channelId && channel.kind !== "voice")) throw new Error("This text channel is no longer available.")
    if (!["vote", "receipt"].includes(kind) && !canPostToCommunityChannel(community, this.address, channelId)) throw new Error("Only moderators can post in this channel, or it is no longer available.")
    if (["edit", "pin", "vote", "receipt"].includes(kind)) this.actionTarget(id, channelId, kind, payload)
    if (payload.replyTo && !this.model.messages.some(message => message.id === payload.replyTo && message.conversationId === id && message.channelId === channelId && !message.hidden))
      throw new Error("The message you are replying to is no longer available.")
    const data = { ...payload, type: kind, epoch: community.epoch, channelId } as CommunityEventData
    if ("content" in data && typeof data.content === "string") data.content = data.content.trim()
    if ("mentions" in data && Array.isArray(data.mentions)) data.mentions = [...new Set(data.mentions.filter(address => community.effectiveMembers.includes(address)))]
    // Routine chat sends use the current snapshot initially. publish() always
    // refreshes and checks the signed epoch immediately before durable queueing.
    return this.publish(id, data, this.recipients(community.effectiveMembers), community)
  }, false)
  sendMessage = (id: string, channelId: string, text: string, replyTo?: string, mentions?: string[]): Promise<string> =>
    this.sendEvent(id, channelId, "message", { content: text, ...(replyTo ? { replyTo } : {}), ...(mentions?.length ? { mentions } : {}) })
  editMessage = async (id: string, channelId: string, messageId: string, text: string): Promise<void> => { await this.sendEvent(id, channelId, "edit", { targetId: messageId, content: text }) }
  pinMessage = async (id: string, channelId: string, messageId: string, pinned: boolean): Promise<void> => { await this.sendEvent(id, channelId, "pin", { targetId: messageId, pinned }) }
  createPoll = (id: string, channelId: string, question: string, options: string[]): Promise<string> => this.sendEvent(id, channelId, "poll", { question: question.trim(), options: options.map(option => option.trim()) })
  vote = async (id: string, channelId: string, messageId: string, option: number): Promise<void> => { await this.sendEvent(id, channelId, "vote", { targetId: messageId, option }) }
  receipt = async (id: string, channelId: string, messageId: string, receipt: "delivered" | "read"): Promise<void> => { await this.sendEvent(id, channelId, "receipt", { targetId: messageId, receipt }) }
  getAttachmentChunks = (id: string, channelId: string, messageId: string): Array<{ index: number; data: string }> => {
    const key = messageKey(id, channelId, messageId), index = this.index
    const message = index.messages.get(key)
    if (!message?.attachment || message.attachment.remote) return NO_ATTACHMENT_PIECES
    const metadata = index.originals.get(key)?.payload.community
    if (metadata?.type !== "attachment") return NO_ATTACHMENT_PIECES
    return this.attachmentChunks(id, channelId, message.senderPubKey, metadata)
  }
  private attachmentChunks(id: string, channelId: string, sender: string, metadata: CommunityAttachment): AttachmentPieces {
    const events = this.index.chunks.get(attachmentKey(id, channelId, sender, metadata.attachment.id, metadata.epoch, metadata.stateRef)) ?? []
    const prior = this.attachmentResults.get(metadata)
    if (prior && prior.events.length === events.length && prior.events.every((event, index) => event === events[index])) return prior.value
    const chunks = new Map<number, string>()
    let conflict = false
    for (const event of events) {
      const data = event.payload.community!
      if (data.type !== "attachment-chunk" || data.index >= metadata.attachment.chunks) continue
      const expected = Math.min(ATTACHMENT_CHUNK_BYTES, metadata.attachment.size - data.index * ATTACHMENT_CHUNK_BYTES)
      let checked = this.validatedPieces.get(event)
      if (!checked || checked.encoded !== data.data || checked.expected !== expected) {
        let valid: boolean
        try { const binary = atob(data.data); valid = binary.length === expected && btoa(binary) === data.data } catch { valid = false }
        checked = { encoded: data.data, expected, valid }; this.validatedPieces.set(event, checked)
      }
      if (!checked.valid) continue
      if (chunks.has(data.index) && chunks.get(data.index) !== data.data) { conflict = true; break }
      chunks.set(data.index, data.data)
    }
    const next = conflict ? NO_ATTACHMENT_PIECES : [...chunks].map(([index, data]) => ({ index, data })).sort((a, b) => a.index - b.index)
    // Duplicate delivery or fresh record wrappers must not force media viewers
    // to recreate an unchanged Blob and restart a GIF/video preview.
    const value = prior && prior.value.length === next.length && prior.value.every((chunk, index) => chunk.index === next[index].index && chunk.data === next[index].data) ? prior.value : next
    this.attachmentResults.set(metadata, { events, value })
    return value
  }
  hideMessage = async (id: string, messageId: string): Promise<void> => this.locked(id, async () => {
    const community = this.moderator(id)
    const message = this.model.messages.find(item => item.id === messageId && item.conversationId === id)
    if (!message) throw new Error("This message is no longer available.")
    if (message.hidden) return
    await this.publish(id, { type: "hide", epoch: community.epoch, channelId: message.channelId, targetId: message.id }, this.recipients(community.effectiveMembers), community)
  })
  reportMessage = async (id: string, messageId: string, reason: string): Promise<void> => this.locked(id, async () => {
    const community = this.community(id)
    const message = this.model.messages.find(item => item.id === messageId && item.conversationId === id)
    if (!message || message.hidden) throw new Error("This message is no longer available.")
    if (!reason.trim()) throw new Error("Add a short reason for the report.")
    await this.publish(id, { type: "report", epoch: community.epoch, channelId: message.channelId, targetId: message.id, reason: reason.trim() },
      this.recipients([community.owner, ...(community.coOwners ?? []), ...community.moderators.filter(address => community.effectiveMembers.includes(address))]), community)
  })

  // Called after incoming sync. Direct admission still requires the owner's
  // signed membership acknowledgement; applicants never grant themselves access.
  reconcile = async (): Promise<void> => {
    this.assertActive()
    const owned = this.model.communities.filter(community => community.owner === this.address && (community.joined || community.deleted))
    for (const initial of owned) await this.locked(initial.id, async () => {
      while (true) {
        const community = this.community(initial.id, false), model = this.model
        // Another device may have completed a handoff while this loop refreshed.
        if (community.owner !== this.address) break
        if (community.deleted) {
          const request = model.requests.find(item => item.communityId === initial.id && item.status === "pending")
          if (!request) break
          await this.resolveRequest(community, request, false, undefined, "This community has been deleted.")
          continue
        }
        if (!community.joined) break
        const command = model.commands.find(item => item.communityId === initial.id && !model.processedIds.includes(item.id))
        if (command) { await this.resolveCommand(community, command); continue }
        const request = model.requests.find(item => item.communityId === initial.id && item.status === "pending" &&
          (community.effectiveMembers.includes(item.author) || community.admission === "direct" || community.joiningPaused || item.invite.owner !== community.owner || item.invite.inviteGeneration !== community.inviteGeneration ||
            item.invite.expiresAt <= Date.now() || community.bans.includes(item.author)))
        if (!request) break
        await this.resolveRequest(community, request, true)
      }
    })
  }
  private async resolveCommand(prior: CommunityRecord, command: CommunityCommand) {
    const next = this.nextState(prior)
    const authorized = command.action === "leave"
      ? command.target === command.author && command.target !== prior.owner
      : isCommunityModerator(prior, command.author) && prior.effectiveMembers.includes(command.author)
    if (authorized && (command.action === "approve" || command.action === "reject")) {
      const request = this.model.requests.find(item => item.communityId === prior.id && item.id === command.requestId && item.author === command.target && item.status === "pending")
      if (request) { await this.resolveRequest(prior, request, command.action === "approve", command.id); return }
    }
    if (authorized && isCommunityAdmin(prior, command.author)) {
      if (command.action === "update" && command.changes) this.applyChanges(next, command.changes)
      else if (command.action === "revoke-invites") next.inviteGeneration++
    }
    if (authorized && command.target !== prior.owner && (command.action === "leave" ||
      (!isCommunityCoOwner(prior, command.target) && (!prior.moderators.includes(command.target) || isCommunityAdmin(prior, command.author))))) {
      if (command.action === "leave" || command.action === "remove" || command.action === "ban")
        this.applyModeration(next, command.action === "ban" ? "ban" : "remove", command.target)
      else if (command.action === "unban") this.applyModeration(next, "unban", command.target)
      else if (isCommunityAdmin(prior, command.author) && next.members.includes(command.target)) {
        if (command.action === "promote") next.moderators = [...new Set([...next.moderators, command.target])]
        else if (command.action === "demote") next.moderators = next.moderators.filter(address => address !== command.target)
      }
    }
    // Consuming an obsolete command with an unchanged signed snapshot prevents
    // retries from unexpectedly applying it after a later role/membership change.
    await this.publishState(prior, next, { commandId: command.id })
  }
}
