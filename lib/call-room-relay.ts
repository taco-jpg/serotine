import type { RequestProof } from "./protocol"
import type { GroupState } from "./messaging-types"
import type { CommunityState } from "./community-types"
import type { D1DatabaseBinding } from "./db"
import { authorize, CallRelayError } from "./call-relay"
import { validateGroup } from "./messaging"
import { canJoinCommunityVoiceChannel, validateCommunityState } from "./community-protocol"
import { CALL_PAGE_SIZE, CALL_SIGNAL_TTL_MS, isCallId, isCallObject } from "./call-protocol"
import { CALL_ROOM_LEASE_MS, CALL_ROOM_LIMIT, callRoomId, isCallRoomId, isEncryptedCallRoomSignal,
  type CallRoomTarget, type CallRoomState, type CallRoomParticipant, type EncryptedCallRoomSignal } from "./call-room-protocol"

const invalid = () => new CallRelayError("Invalid room calling request. Reload Serotine and retry.")
function shape(data: Record<string, unknown>, keys: string[]) {
  if (Object.keys(data).length !== keys.length || !keys.every(key => Object.hasOwn(data, key))) throw invalid()
}
type Authority = { scopeId: string; kind: string; signature: string; checkpointJson: string; stateJson: string | null }
type Checkpoint = { epoch: number; admin?: string; owner?: string; version?: 2; deleted?: boolean; transfers?: { signature: string }[] }
function authorityCheckpoint(state: GroupState | CommunityState): Checkpoint {
  return "admin" in state ? { epoch: state.epoch, admin: state.admin } : { epoch: state.epoch, owner: state.owner, version: state.version,
    deleted: !!state.deleted, transfers: state.transfers?.map(t => ({ signature: t.signature })) }
}
function authorizationState(state: GroupState | CommunityState): string {
  // Channel display names, community descriptions and ban lists are never kept.
  // Validated membership is disjoint from bans; only admitted members are needed.
  return JSON.stringify("admin" in state ? { members: state.members } : { members: state.members, owner: state.owner, deleted: !!state.deleted,
    moderators: state.moderators, coOwners: state.coOwners, channels: state.channels.map(c => ({ id: c.id, kind: c.kind, posting: c.posting })) })
}
/** Correlated with a CallRoomMember row named m. Always consult the newest checkpoint. */
const ALLOWED = `EXISTS(SELECT 1 FROM CallRoomAuthority a WHERE a.scopeId = m.scopeId
  AND EXISTS(SELECT 1 FROM json_each(a.stateJson, '$.members') WHERE value = m.publicKey)
  AND COALESCE(json_extract(a.stateJson, '$.deleted'), 0) = 0
  AND NOT EXISTS(SELECT 1 FROM json_each(a.stateJson, '$.bans') WHERE value = m.publicKey)
  AND (a.kind = 'group' OR EXISTS(SELECT 1 FROM json_each(a.stateJson, '$.channels') c
    WHERE json_extract(c.value, '$.id') = m.channelId AND json_extract(c.value, '$.kind') = 'voice'
    AND (json_extract(c.value, '$.posting') = 'members' OR json_extract(a.stateJson, '$.owner') = m.publicKey
      OR EXISTS(SELECT 1 FROM json_each(a.stateJson, '$.coOwners') WHERE value = m.publicKey)
      OR EXISTS(SELECT 1 FROM json_each(a.stateJson, '$.moderators') WHERE value = m.publicKey)))))
  AND NOT EXISTS(SELECT 1 FROM RetiredIdentity WHERE publicKey = m.publicKey)`

async function clean(db: D1DatabaseBinding, now: number) {
  await db.prepare(`DELETE FROM CallRoomMember WHERE publicKey IN (SELECT m.publicKey FROM CallRoomMember m WHERE m.expiresAt <= ? OR NOT (${ALLOWED}) LIMIT 256)`).bind(now).run()
  await db.prepare(`DELETE FROM CallRoomSignal WHERE sequence IN (SELECT s.sequence FROM CallRoomSignal s WHERE s.expiresAt <= ?
    OR NOT EXISTS(SELECT 1 FROM CallRoomMember m WHERE m.publicKey = s.sender AND m.sessionId = s.senderSession AND m.roomId = s.roomId AND m.expiresAt > ? AND ${ALLOWED})
    OR NOT EXISTS(SELECT 1 FROM CallRoomMember m WHERE m.publicKey = s.recipient AND m.sessionId = s.targetSession AND m.roomId = s.roomId AND m.expiresAt > ? AND ${ALLOWED}) LIMIT 512)`).bind(now, now, now).run()
  await db.prepare(`UPDATE CallRoomAuthority SET stateJson = NULL WHERE stateJson IS NOT NULL
    AND scopeId IN (SELECT a.scopeId FROM CallRoomAuthority a WHERE a.stateJson IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM CallRoomMember WHERE scopeId = a.scopeId AND expiresAt > ?) LIMIT 128)`).bind(now).run()
}
function advances(next: GroupState | CommunityState, prior: Checkpoint, kind: string) {
  if (kind === "group") return (next as GroupState).admin === prior.admin && next.epoch > prior.epoch
  const n = next as CommunityState, p = prior
  if (p.deleted || (p.version === 2 && n.version !== 2)
    || !(p.transfers ?? []).every((t, i) => t.signature === n.transfers?.[i]?.signature)) return false
  const extended = (n.transfers?.length ?? 0) > (p.transfers?.length ?? 0) || (n.version === 2 && p.version !== 2)
  return extended || n.epoch > p.epoch
}
async function checkpoint(db: D1DatabaseBinding, value: unknown, self: string, publishingOnly: boolean): Promise<{ target: CallRoomTarget; scopeId: string; state: GroupState | CommunityState }> {
  if (!isCallObject(value)) throw invalid()
  let target: CallRoomTarget, scopeId: string, state: GroupState | CommunityState
  if (value.kind === "group") {
    shape(value, ["kind", "group"])
    if (!isCallObject(value.group)) throw invalid()
    shape(value.group, ["id", "name", "admin", "members", "epoch", "updatedAt", "signature"])
    if (!await validateGroup(value.group as unknown as GroupState)) throw new CallRelayError("The group membership proof could not be verified.", 403)
    target = value as unknown as CallRoomTarget; state = (target as Extract<CallRoomTarget, { kind: "group" }>).group; scopeId = callRoomId(target)
  } else if (value.kind === "channel") {
    shape(value, ["kind", "community", "channelId"])
    if (!isCallId(value.channelId) || !await validateCommunityState(value.community)) throw new CallRelayError("The community membership proof could not be verified.", 403)
    target = value as unknown as CallRoomTarget; state = (target as Extract<CallRoomTarget, { kind: "channel" }>).community; scopeId = state.id
  } else throw invalid()
  const authorizedPublisher = publishingOnly && "owner" in state && (state.owner === self || state.signer === self)
  if ((!state.members.includes(self) || ("bans" in state && state.bans.includes(self))) && !authorizedPublisher) throw new CallRelayError("You are no longer a member of this conversation.", 403)
  // The conditional UPDATE is an authority compare-and-swap, not a read/write
  // membership lock. A concurrent newer checkpoint cannot be overwritten.
  for (let retry = 0; retry < 4; retry++) {
    const prior = await db.prepare("SELECT scopeId, kind, signature, checkpointJson, stateJson FROM CallRoomAuthority WHERE scopeId = ?").bind(scopeId).first<Authority>()
    if (prior?.signature === state.signature) return { target, scopeId, state }
    if (prior) {
      if (prior.kind !== target.kind || !advances(state, JSON.parse(prior.checkpointJson), target.kind)) throw new CallRelayError("This membership proof is out of date. Wait for the conversation to sync and retry.", 409)
      const updated = await db.prepare("UPDATE CallRoomAuthority SET signature = ?, checkpointJson = ?, stateJson = ? WHERE scopeId = ? AND signature = ?")
        .bind(state.signature, JSON.stringify(authorityCheckpoint(state)), authorizationState(state), scopeId, prior.signature).run()
      if (updated.meta.changes === 1) return { target, scopeId, state }
    } else {
      const inserted = await db.prepare("INSERT OR IGNORE INTO CallRoomAuthority(scopeId, kind, signature, checkpointJson, stateJson) VALUES (?, ?, ?, ?, ?)")
        .bind(scopeId, target.kind, state.signature, JSON.stringify(authorityCheckpoint(state)), authorizationState(state)).run()
      if (inserted.meta.changes === 1) return { target, scopeId, state }
    }
  }
  throw new CallRelayError("The conversation membership changed. Retry joining the call.", 409)
}
async function snapshot(db: D1DatabaseBinding, roomId: string, now: number): Promise<CallRoomState> {
  const { results } = await db.prepare(`SELECT m.publicKey, m.sessionId, m.mode, m.policy, m.joinedAt, m.expiresAt FROM CallRoomMember m
    WHERE m.roomId = ? AND m.expiresAt > ? AND ${ALLOWED} ORDER BY m.joinedAt, m.publicKey LIMIT ?`).bind(roomId, now, CALL_ROOM_LIMIT).all<CallRoomParticipant>()
  return { roomId, participants: results, limit: CALL_ROOM_LIMIT }
}
export async function handleCallRoomRequest(action: string, data: unknown, proof: RequestProof): Promise<Record<string, unknown>> {
  if (!isCallObject(data) || !["room:join", "room:status", "room:poll", "room:send", "room:leave"].includes(action) || !isCallId(data.sessionId)) throw invalid()
  const db = await authorize(action, data, proof), self = proof.publicKey, device = data.sessionId, now = Date.now()
  await clean(db, now)
  if (action === "room:leave") {
    shape(data, ["sessionId", "roomId"])
    if (!isCallRoomId(data.roomId)) throw invalid()
    await db.prepare("DELETE FROM CallRoomMember WHERE publicKey = ? AND sessionId = ? AND roomId = ?").bind(self, device, data.roomId).run()
    await clean(db, now)
    return { success: true }
  }
  if (action === "room:send") {
    shape(data, ["sessionId", "signal"])
    if (!isEncryptedCallRoomSignal(data.signal) || data.signal.sender !== self || data.signal.senderSession !== device
      || data.signal.expiresAt <= now || data.signal.expiresAt > now + CALL_SIGNAL_TTL_MS) throw invalid()
    const s = data.signal
    const inserted = await db.prepare(`INSERT INTO CallRoomSignal(id, roomId, sender, recipient, senderSession, targetSession, expiresAt, encryptedData)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS(SELECT 1 FROM CallRoomMember m WHERE m.publicKey = ? AND m.sessionId = ? AND m.roomId = ? AND m.expiresAt > ? AND ${ALLOWED})
      AND EXISTS(SELECT 1 FROM CallRoomMember m WHERE m.publicKey = ? AND m.sessionId = ? AND m.roomId = ? AND m.expiresAt > ? AND ${ALLOWED})
      AND (SELECT COUNT(*) FROM CallRoomSignal WHERE roomId = ? AND expiresAt > ?) < 2048
      ON CONFLICT(id) DO NOTHING`).bind(s.id, s.roomId, s.sender, s.recipient, s.senderSession, s.targetSession, s.expiresAt, s.encryptedData,
        self, device, s.roomId, now, s.recipient, s.targetSession, s.roomId, now, s.roomId, now).run()
    if (inserted.meta.changes !== 1) throw new CallRelayError("This room signal is stale, already used, or belongs to another device or membership.", 409)
    return { success: true }
  }
  shape(data, action === "room:join" ? ["sessionId", "target", "mode", "policy"] : action === "room:poll" ? ["sessionId", "target", "after"] : ["sessionId", "target"])
  if (action === "room:join" && (!["voice", "video"].includes(String(data.mode)) || !["all", "relay"].includes(String(data.policy)))) throw invalid()
  if (action === "room:poll" && (!Number.isSafeInteger(data.after) || Number(data.after) < 0)) throw invalid()
  const { target, scopeId, state } = await checkpoint(db, data.target, self, action === "room:status")
  const roomId = callRoomId(target)
  // A current member may publish signed channel removal/restriction through
  // status, even though the removed channel no longer admits joins.
  await clean(db, now)
  if (action === "room:join" && target.kind === "channel" && data.mode !== "voice") throw new CallRelayError("Voice channels support microphone audio. Start a group video call to use a camera.")
  if (action === "room:status") return { success: true, room: target.kind === "channel" && !canJoinCommunityVoiceChannel(target.community, self, target.channelId)
    ? { roomId, participants: [], limit: CALL_ROOM_LIMIT } : await snapshot(db, roomId, now) }
  if (target.kind === "channel" && !canJoinCommunityVoiceChannel(target.community, self, target.channelId)) throw new CallRelayError("This voice channel is no longer available to you.", 403)
  if (action === "room:join") {
    // A single SQLite statement arbitrates capacity, identity/device ownership,
    // direct-call reservations, authority changes, and the room privacy policy.
    const hydrate = db.prepare("UPDATE CallRoomAuthority SET stateJson = ? WHERE scopeId = ? AND signature = ?")
      .bind(authorizationState(state), scopeId, state.signature)
    const admission = db.prepare(`INSERT INTO CallRoomMember(publicKey, roomId, scopeId, channelId, sessionId, mode, policy, joinedAt, expiresAt)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS(SELECT 1 FROM CallRoomAuthority WHERE scopeId = ? AND signature = ? AND stateJson IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM RetiredIdentity WHERE publicKey = ?)
      AND NOT EXISTS(SELECT 1 FROM CallSession WHERE (caller = ? OR recipient = ?) AND status != 'ended' AND expiresAt > ?)
      AND NOT EXISTS(SELECT 1 FROM CallRoomMember WHERE publicKey = ? AND expiresAt > ? AND (roomId != ? OR sessionId != ?))
      AND NOT EXISTS(SELECT 1 FROM CallRoomMember WHERE roomId = ? AND expiresAt > ? AND policy != ?)
      AND ((SELECT COUNT(*) FROM CallRoomMember WHERE roomId = ? AND expiresAt > ?) < ?
        OR EXISTS(SELECT 1 FROM CallRoomMember WHERE publicKey = ? AND roomId = ? AND sessionId = ? AND expiresAt > ?))
      ON CONFLICT(publicKey) DO UPDATE SET roomId = excluded.roomId, scopeId = excluded.scopeId, channelId = excluded.channelId,
        sessionId = excluded.sessionId, mode = excluded.mode, policy = excluded.policy, joinedAt = CASE WHEN CallRoomMember.sessionId = excluded.sessionId THEN CallRoomMember.joinedAt ELSE excluded.joinedAt END, expiresAt = excluded.expiresAt`)
      .bind(self, roomId, scopeId, target.kind === "channel" ? target.channelId : null, device, data.mode, data.policy, now, now + CALL_ROOM_LEASE_MS,
        scopeId, state.signature, self, self, self, now, self, now, roomId, device, roomId, now, data.policy,
        roomId, now, CALL_ROOM_LIMIT, self, roomId, device, now)
    // D1 batches run transactionally, so idle metadata pruning cannot race
    // between rehydrating authorization and establishing a live membership.
    const writes = db.batch ? await db.batch([hydrate, admission]) : [await hydrate.run(), await admission.run()]
    if (writes[1].meta.changes !== 1) {
      await clean(db, now)
      throw new CallRelayError("The room is full, your identity is already in a call, or its connection setting differs. Calls allow up to 8 people using the same connection setting.", 409)
    }
    return { success: true, room: await snapshot(db, roomId, now) }
  }
  const touched = await db.prepare(`UPDATE CallRoomMember SET expiresAt = ? WHERE publicKey = ? AND sessionId = ? AND roomId = ? AND expiresAt > ?
    AND EXISTS(SELECT 1 FROM CallRoomAuthority WHERE scopeId = ? AND signature = ?)`)
    .bind(now + CALL_ROOM_LEASE_MS, self, device, roomId, now, scopeId, state.signature).run()
  if (touched.meta.changes !== 1) throw new CallRelayError("Your room session expired or is active on another device. Join the call again.", 409)
  const { results: signals } = await db.prepare(`SELECT s.* FROM CallRoomSignal s WHERE s.roomId = ? AND s.recipient = ? AND s.targetSession = ? AND s.sequence > ? AND s.expiresAt > ?
    AND EXISTS(SELECT 1 FROM CallRoomMember m WHERE m.publicKey = s.sender AND m.sessionId = s.senderSession AND m.roomId = s.roomId AND m.expiresAt > ? AND ${ALLOWED})
    AND EXISTS(SELECT 1 FROM CallRoomMember m WHERE m.publicKey = s.recipient AND m.sessionId = s.targetSession AND m.roomId = s.roomId AND m.expiresAt > ? AND ${ALLOWED})
    ORDER BY s.sequence LIMIT ?`).bind(roomId, self, device, data.after, now, now, now, CALL_PAGE_SIZE).all<EncryptedCallRoomSignal>()
  return { success: true, room: await snapshot(db, roomId, now), signals, nextCursor: signals.at(-1)?.sequence ?? data.after }
}
