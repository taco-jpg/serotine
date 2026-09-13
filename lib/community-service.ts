import type { Identity } from "./identity"
import type { MessagingEvent, MessagingPreferences, StoredEvent } from "./messaging-types"
import type { CommunityAdmission, CommunityChannel, CommunityCommand, CommunityEventData, CommunityJoinRequest, CommunityRecord, CommunityState } from "./community-types"
import { buildCommunityInviteUrl, buildCommunityModel, canPostToCommunityChannel, isCommunityId, isCommunityModerator, parseCommunityInvite, signCommunityInvite, signCommunityState, validateCommunityEvent, validateCommunityInvite, validateCommunityState } from "./community-protocol"

export interface CommunityServiceHost {
  identity: Identity
  records: () => StoredEvent[]
  preferences: () => MessagingPreferences
  refresh: () => Promise<void>
  queue: (event: MessagingEvent) => Promise<void>
  sign: (event: Omit<MessagingEvent, "signature">) => Promise<MessagingEvent>
  assertActive?: () => void
}
export interface CommunityChanges {
  name?: string; description?: string; admission?: CommunityAdmission; joiningPaused?: boolean; channels?: CommunityChannel[]
}
export type CommunityModerationAction = "remove" | "ban" | "unban" | "promote" | "demote"

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
    joiningPaused: record.joiningPaused, inviteGeneration: record.inviteGeneration, signature: record.signature }
}

export class CommunityService {
  constructor(private readonly host: CommunityServiceHost) {}
  get model() { return buildCommunityModel(this.host.records(), this.host.identity.publicKey, this.host.preferences()) }
  private get address() { return this.host.identity.publicKey }
  private assertActive() { this.host.assertActive?.() }
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (!isCommunityId(id)) throw new Error("This community address is invalid.")
    return mutate(`serotine:community:${this.address}:${id}`, async () => {
      this.assertActive()
      await this.host.refresh()
      this.assertActive()
      return action()
    })
  }
  private community(id: string, requireJoined = true): CommunityRecord {
    const community = this.model.communities.find(item => item.id === id)
    if (!community) throw new Error("This community has not synchronized yet.")
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
  private recipients(members: string[]) {
    const peers = [...new Set(members)].filter(address => address !== this.address)
    return peers.length ? peers : [this.address]
  }
  private async publish(id: string, data: CommunityEventData, recipients: string[], prior?: CommunityRecord): Promise<string> {
    this.assertActive()
    if (prior && !["state", "decision", "leave"].includes(data.type) && prior.members.length !== prior.effectiveMembers.length)
      throw new Error("A member left. Wait for the owner to update membership before sending.")
    const event = await this.host.sign({ version: 3, id: crypto.randomUUID(), author: this.address,
      conversationId: id, recipients: [...new Set(recipients)], timestamp: Date.now(), kind: "community", payload: { community: data } })
    if (!await validateCommunityEvent(event)) throw new Error("This community update is invalid or too large.")
    // Signing can yield long enough for another device's newer owner snapshot to
    // arrive. A stale send must not reinstate a removed member or stale settings.
    await this.host.refresh()
    this.assertActive()
    if (prior) {
      const current = this.community(id, false)
      if (current.epoch !== prior.epoch || current.signature !== prior.signature ||
        current.effectiveMembers.length !== prior.effectiveMembers.length || current.effectiveMembers.some(address => !prior.effectiveMembers.includes(address)))
        throw new Error("The community changed while this action was being prepared. Review it and try again.")
      if (!current.joined) throw new Error("You are no longer a member of this community.")
      if (data.type === "message" && !canPostToCommunityChannel(current, this.address, data.channelId))
        throw new Error("You cannot post in this channel.")
    }
    await this.host.queue(event)
    return event.id
  }
  private async publishState(prior: CommunityRecord, next: CommunityState, context: { requestId?: string; commandId?: string } = {}) {
    const unsigned = { ...next, epoch: prior.epoch + 1, updatedAt: Math.max(Date.now(), prior.updatedAt + 1) }
    const state = await signCommunityState(unsigned, this.host.identity)
    if (!await validateCommunityState(state)) throw new Error("These community settings are invalid or exceed the community limits.")
    await this.publish(prior.id, { type: "state", state, ...context }, this.recipients([...prior.members, ...state.members]), prior)
  }
  private nextState(prior: CommunityRecord) {
    const next = snapshot(prior)
    next.members = [...prior.effectiveMembers]
    next.moderators = next.moderators.filter(address => next.members.includes(address))
    return next
  }

  createCommunity = async (options: { name: string; description: string; admission: CommunityAdmission }): Promise<string> => {
    const id = `community:${this.address}:${crypto.randomUUID()}`
    return this.locked(id, async () => {
      const state = await signCommunityState({ id, owner: this.address, name: options.name.trim(), description: options.description.trim(),
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
    const invite = await signCommunityInvite({ version: 1, communityId: id, owner: community.owner, name: community.name,
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
      if (known?.joined) throw new Error("You have already joined this community.")
      if (this.model.requests.some(request => request.communityId === invite.communityId && request.author === this.address && request.status === "pending"))
        throw new Error("Your join request is already waiting for the owner to synchronize.")
      if (!await validateCommunityInvite(invite)) throw new Error("This invitation has expired or is invalid.")
      await this.publish(invite.communityId, { type: "join", invite }, [invite.owner])
      return invite.communityId
    })
  }
  updateCommunity = async (id: string, changes: CommunityChanges): Promise<void> => this.locked(id, async () => {
    const prior = this.owner(id), next = this.nextState(prior)
    if (changes.name !== undefined) next.name = changes.name.trim()
    if (changes.description !== undefined) next.description = changes.description.trim()
    if (changes.admission !== undefined) next.admission = changes.admission
    if (changes.joiningPaused !== undefined) next.joiningPaused = changes.joiningPaused
    if (changes.channels !== undefined) next.channels = changes.channels.map(channel => ({ ...channel, name: channel.name.trim() }))
    await this.publishState(prior, next)
  })
  revokeInvites = async (id: string): Promise<void> => this.locked(id, async () => {
    const prior = this.owner(id), next = this.nextState(prior)
    next.inviteGeneration++
    await this.publishState(prior, next)
  })
  moderate = async (id: string, action: CommunityModerationAction, target: string): Promise<void> => this.locked(id, async () => {
    const prior = this.moderator(id)
    if (target === prior.owner) throw new Error("The community owner cannot be removed or demoted.")
    if (target === this.address) throw new Error("Use Leave community to leave, or ask the owner to change your role.")
    if ((action === "promote" || action === "demote") && this.address !== prior.owner)
      throw new Error("Only the owner can change moderator roles.")
    if (this.address !== prior.owner && prior.moderators.includes(target)) throw new Error("Only the owner can moderate another moderator.")
    if (action !== "unban" && !prior.effectiveMembers.includes(target)) throw new Error("This person is no longer a member.")
    if (action === "unban" && !prior.bans.includes(target)) throw new Error("This person is not banned.")
    if (this.address !== prior.owner) {
      await this.publish(id, { type: "command", epoch: prior.epoch, action: action as "remove" | "ban" | "unban", target }, [prior.owner], prior)
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
  private async resolveRequest(prior: CommunityRecord, request: CommunityJoinRequest, approve: boolean, commandId?: string) {
    let reason = approve ? "" : "A moderator declined your request."
    if (approve) {
      if (!await validateCommunityInvite(request.invite)) reason = "This invitation has expired or is invalid."
      else if (request.invite.inviteGeneration !== prior.inviteGeneration) reason = "This invitation was revoked. Ask for a new one."
      else if (prior.joiningPaused) reason = "Joining is currently paused."
      else if (prior.bans.includes(request.author) || this.host.preferences().blocked.includes(request.author)) reason = "This community is not accepting this request."
      else if (!prior.effectiveMembers.includes(request.author) && prior.effectiveMembers.length >= MAX_MEMBERS) reason = "This community is full (20 members)."
    }
    if (reason) {
      await this.publish(prior.id, { type: "decision", requestId: request.id, applicant: request.author, status: "rejected", reason,
        ...(commandId ? { commandId } : {}) }, [request.author], prior)
      return
    }
    const next = this.nextState(prior)
    next.members = [...new Set([...next.members, request.author])]
    await this.publishState(prior, next, { requestId: request.id, ...(commandId ? { commandId } : {}) })
  }
  leave = async (id: string): Promise<void> => this.locked(id, async () => {
    const community = this.community(id)
    if (community.owner === this.address) throw new Error("The owner must keep this community open. Pause joining instead.")
    await this.publish(id, { type: "leave", epoch: community.epoch }, this.recipients(community.members), community)
  })
  sendMessage = async (id: string, channelId: string, text: string, replyTo?: string, mentions?: string[]): Promise<string> => this.locked(id, async () => {
    const community = this.community(id)
    if (!canPostToCommunityChannel(community, this.address, channelId)) throw new Error("Only moderators can post in this channel, or it is no longer available.")
    const content = text.trim()
    if (!content) throw new Error("Write a message before sending.")
    if (replyTo && !this.model.messages.some(message => message.id === replyTo && message.conversationId === id && message.channelId === channelId && !message.hidden))
      throw new Error("The message you are replying to is no longer available.")
    const activeMentions = mentions?.filter(address => community.effectiveMembers.includes(address))
    return this.publish(id, { type: "message", epoch: community.epoch, channelId, content,
      ...(replyTo ? { replyTo } : {}), ...(activeMentions?.length ? { mentions: [...new Set(activeMentions)] } : {}) }, this.recipients(community.effectiveMembers), community)
  })
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
      this.recipients([community.owner, ...community.moderators.filter(address => community.effectiveMembers.includes(address))]), community)
  })

  // Called after incoming sync. Direct admission still requires the owner's
  // signed membership acknowledgement; applicants never grant themselves access.
  reconcile = async (): Promise<void> => {
    this.assertActive()
    const owned = this.model.communities.filter(community => community.owner === this.address && community.joined)
    for (const initial of owned) await this.locked(initial.id, async () => {
      while (true) {
        const community = this.owner(initial.id), model = this.model
        const command = model.commands.find(item => item.communityId === initial.id && !model.processedIds.includes(item.id))
        if (command) { await this.resolveCommand(community, command); continue }
        const request = model.requests.find(item => item.communityId === initial.id && item.status === "pending" &&
          (community.admission === "direct" || community.joiningPaused || item.invite.inviteGeneration !== community.inviteGeneration ||
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
    if (authorized && command.target !== prior.owner && (command.action === "leave" || !prior.moderators.includes(command.target) || command.author === prior.owner)) {
      if (command.action === "leave" || command.action === "remove" || command.action === "ban")
        this.applyModeration(next, command.action === "ban" ? "ban" : "remove", command.target)
      else if (command.action === "unban") this.applyModeration(next, "unban", command.target)
    }
    // Consuming an obsolete command with an unchanged signed snapshot prevents
    // retries from unexpectedly applying it after a later role/membership change.
    await this.publishState(prior, next, { commandId: command.id })
  }
}
