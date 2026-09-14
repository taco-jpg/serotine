import { canJoinCommunityVoiceChannel, communityStateSnapshot } from "./community-protocol"
import type { CommunityRecord } from "./community-types"
import type { MessagingContextValue } from "./messaging-types"
import type { CallRoomTarget } from "./call-room-protocol"

/** Relay proofs contain signed state only, never derived local display fields. */
export const signedCommunityState = communityStateSnapshot

/** Advance a previously visited room's governance even when its latest state
 * closes that room. This grants no join access and contains no local UI data. */
export function latestCallRoomProof(target: CallRoomTarget, messaging: Pick<MessagingContextValue,
  "identity" | "conversations" | "preferences">, communities: CommunityRecord[]): CallRoomTarget | null {
  const self = messaging.identity?.publicKey
  if (!self) return null
  if (target.kind === "group") {
    const group = messaging.conversations.find(item => item.kind === "group" && item.id === target.group.id)?.group
    if (!group || group.admin !== target.group.admin || (!group.members.includes(self) && group.admin !== self)) return null
    return { kind: "group", group }
  }
  const community = communities.find(item => item.id === target.community.id)
  if (!community || (!community.members.includes(self) && community.owner !== self && community.signer !== self)) return null
  return { kind: "channel", community: signedCommunityState(community), channelId: target.channelId }
}

export function currentCallRoomTarget(target: CallRoomTarget, messaging: Pick<MessagingContextValue,
  "identity" | "conversations" | "preferences">, communities: CommunityRecord[]): CallRoomTarget | null {
  const self = messaging.identity?.publicKey
  if (!self) return null
  if (target.kind === "group") {
    const conversation = messaging.conversations.find(item => item.id === target.group.id && item.kind === "group")
    const group = conversation?.group
    if (!conversation || !group || group.admin !== target.group.admin || conversation.request || conversation.blocked
      || messaging.preferences.blocked.includes(conversation.id) || !conversation.members.includes(self)
      || !group.members.includes(self) || group.members.length !== conversation.members.length
      || group.members.some(member => !conversation.members.includes(member))) return null
    return { kind: "group", group }
  }
  const community = communities.find(item => item.id === target.community.id)
  if (!community?.joined || !community.effectiveMembers.includes(self)
    || community.members.length !== community.effectiveMembers.length
    || community.members.some(member => !community.effectiveMembers.includes(member))
    || !canJoinCommunityVoiceChannel(community, self, target.channelId)) return null
  return { kind: "channel", community: signedCommunityState(community), channelId: target.channelId }
}
