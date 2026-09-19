import "server-only"
import { ensureEventRelaySchema } from "./event-relay-schema"
import { registerRetention, closeRetentionScope, purgeRetentionScope } from "./retention-server"
import { getDB, type D1DatabaseBinding } from "./db"
import { verifyRequestProofResult, requestProofFailureMessage } from "./request-auth"
import { AUTH_WINDOW_MS, PUBLIC_KEY_PATTERN, ID_PATTERN, type RequestProof } from "./protocol"
import { isGroupAddress, validateGroupInvitation, validateGroupAcceptance, type GroupAdmissionStatus, type GroupAcceptance, type GroupInvitation, type GroupInvitationStatus } from "./group-admission"

const initialized = new WeakSet<D1DatabaseBinding>()
export async function ensureGroupAdmissionSchema(db: D1DatabaseBinding) {
  if (initialized.has(db)) return
  await db.prepare("CREATE TABLE IF NOT EXISTS GroupAuthority (groupId TEXT NOT NULL, admin TEXT NOT NULL, terminalAt INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, PRIMARY KEY(groupId, admin))").run()
  await db.prepare("CREATE TABLE IF NOT EXISTS GroupInvitationStatus (groupId TEXT NOT NULL, admin TEXT NOT NULL, invitationId TEXT NOT NULL, invitee TEXT NOT NULL, expiresAt INTEGER NOT NULL, status TEXT NOT NULL, acceptance TEXT, PRIMARY KEY(groupId, admin, invitationId))").run()
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_group_invitation_target ON GroupInvitationStatus(groupId, admin, invitee)").run()
  initialized.add(db)
}
export class GroupAdmissionError extends Error { constructor(message: string, public status = 400) { super(message) } }
interface AdmissionData { groupId: string; admin: string; invitation?: GroupInvitation; acceptance?: GroupAcceptance; invitationId?: string }
export async function readGroupAdmissionStatus(db: D1DatabaseBinding, groupId: string, admin: string, viewer: string): Promise<GroupAdmissionStatus> {
  const group = await db.prepare("SELECT terminalAt FROM GroupAuthority WHERE groupId = ? AND admin = ?").bind(groupId, admin).first<{ terminalAt: number }>()
  if (!group) throw new GroupAdmissionError("This group has not been registered. Ask its administrator to resend the invitation.", 404)
  const { results } = await db.prepare(`SELECT invitationId, invitee, expiresAt, status, acceptance FROM GroupInvitationStatus WHERE groupId = ? AND admin = ?${viewer === admin ? "" : " AND invitee = ?"}`)
    .bind(groupId, admin, ...(viewer === admin ? [] : [viewer])).all<{ invitationId: string; invitee: string; expiresAt: number; status: GroupInvitationStatus; acceptance: string | null }>()
  return { terminal: group.terminalAt > 0, invitations: results.map(row => ({ invitationId: row.invitationId, invitee: row.invitee, expiresAt: row.expiresAt, status: row.status, ...(row.acceptance ? { acceptance: JSON.parse(row.acceptance) as GroupAcceptance } : {}) })) }
}
export async function handleGroupAdmission(action: string, value: unknown, proof: RequestProof): Promise<GroupAdmissionStatus> {
  const data = value as AdmissionData
  const fields = action === "invite" ? ["groupId", "admin", "invitation"] : action === "accept" ? ["groupId", "admin", "acceptance"] : ["decline", "revoke"].includes(action) ? ["groupId", "admin", "invitationId"] : ["groupId", "admin"]
  if (!["create", "status", "invite", "accept", "decline", "revoke", "dissolve"].includes(action) || !data || typeof data !== "object" || Array.isArray(data)
    || Object.keys(data).length !== fields.length || !fields.every(field => Object.hasOwn(data, field)) || !isGroupAddress(data.groupId) || !PUBLIC_KEY_PATTERN.test(data.admin)) throw new GroupAdmissionError("Invalid group membership request.")
  const verified = await verifyRequestProofResult(`group:${action}`, data, proof)
  if (!verified.valid) throw new GroupAdmissionError(requestProofFailureMessage(verified), 401)
  const db = await getDB(); await ensureGroupAdmissionSchema(db)
  if (await db.prepare("SELECT 1 FROM RetiredIdentity WHERE publicKey = ?").bind(proof.publicKey).first()) throw new GroupAdmissionError("This identity has been retired.", 403)
  const now = Date.now()
  const nonce = await db.prepare("INSERT OR IGNORE INTO RequestNonce(publicKey,nonce,action,expiresAt) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM RequestNonce WHERE publicKey = ? AND action LIKE 'group:%' AND expiresAt > ?) < 240")
    .bind(proof.publicKey, proof.nonce, `group:${action}`, Math.max(now, proof.timestamp) + AUTH_WINDOW_MS, proof.publicKey, now).run()
  if (!nonce.meta.changes) throw new GroupAdmissionError("This request was already used or too many group requests were made. Retry shortly.", 429)
  if (["create", "invite", "revoke", "dissolve"].includes(action) && proof.publicKey !== data.admin) throw new GroupAdmissionError("Only the group administrator can do that.", 403)
  if (action === "create") await db.prepare("INSERT OR IGNORE INTO GroupAuthority(groupId,admin,terminalAt,createdAt) VALUES(?,?,0,?)").bind(data.groupId, data.admin, now).run()
  else if (action === "invite") {
    const invitation = data.invitation!
    if (!await validateGroupInvitation(invitation) || invitation.groupId !== data.groupId || invitation.admin !== data.admin || invitation.expiresAt <= now) throw new GroupAdmissionError("This invitation is invalid or expired.")
    const result = await db.prepare("INSERT OR IGNORE INTO GroupInvitationStatus(groupId,admin,invitationId,invitee,expiresAt,status) SELECT ?,?,?,?,?,'pending' WHERE EXISTS(SELECT 1 FROM GroupAuthority WHERE groupId = ? AND admin = ? AND terminalAt = 0) AND (SELECT COUNT(*) FROM GroupInvitationStatus WHERE groupId = ? AND admin = ? AND status IN ('pending','accepted') AND expiresAt > ?) < 40")
      .bind(data.groupId, data.admin, invitation.id, invitation.invitee, invitation.expiresAt, data.groupId, data.admin, data.groupId, data.admin, now).run()
    if (!result.meta.changes && !await db.prepare("SELECT 1 FROM GroupInvitationStatus WHERE groupId=? AND admin=? AND invitationId=? AND invitee=?").bind(data.groupId,data.admin,invitation.id,invitation.invitee).first()) throw new GroupAdmissionError("Group no longer exists or has too many outstanding invitations.", 409)
  } else if (action === "accept") {
    const acceptance = data.acceptance!, invitation = acceptance?.invitation
    if (!await validateGroupAcceptance(acceptance) || invitation.groupId !== data.groupId || invitation.admin !== data.admin || invitation.invitee !== proof.publicKey) throw new GroupAdmissionError("Invalid signed invitation acceptance.", 403)
    const result = await db.prepare("UPDATE GroupInvitationStatus SET status='accepted', acceptance=? WHERE groupId=? AND admin=? AND invitationId=? AND invitee=? AND expiresAt=? AND expiresAt>? AND status='pending' AND EXISTS(SELECT 1 FROM GroupAuthority WHERE groupId=? AND admin=? AND terminalAt=0)")
      .bind(JSON.stringify(acceptance),data.groupId,data.admin,invitation.id,proof.publicKey,invitation.expiresAt,now,data.groupId,data.admin).run()
    if (!result.meta.changes) {
      const accepted = await db.prepare("SELECT 1 FROM GroupInvitationStatus WHERE groupId=? AND admin=? AND invitationId=? AND invitee=? AND status='accepted' AND EXISTS(SELECT 1 FROM GroupAuthority WHERE groupId=? AND admin=? AND terminalAt=0)")
        .bind(data.groupId,data.admin,invitation.id,proof.publicKey,data.groupId,data.admin).first()
      if (!accepted) throw new GroupAdmissionError("Group no longer exists, or this invitation expired, was declined, or was revoked.", 409)
    }
  } else if (action === "decline" || action === "revoke") {
    if (!data.invitationId || !ID_PATTERN.test(data.invitationId)) throw new GroupAdmissionError("Invalid invitation identifier.")
    const result = await db.prepare(`UPDATE GroupInvitationStatus SET status=? WHERE groupId=? AND admin=? AND invitationId=? AND status='pending'${action === "decline" ? " AND invitee=?" : ""}`)
      .bind(action === "decline" ? "declined" : "revoked",data.groupId,data.admin,data.invitationId,...(action === "decline" ? [proof.publicKey] : [])).run()
    if (!result.meta.changes) {
      const row = await db.prepare("SELECT invitee,status FROM GroupInvitationStatus WHERE groupId=? AND admin=? AND invitationId=?").bind(data.groupId,data.admin,data.invitationId).first<{ invitee:string;status:string }>()
      if (!row || (action === "decline" && row.invitee !== proof.publicKey) || row.status === "accepted") throw new GroupAdmissionError("This invitation was already resolved. Refresh the group.",409)
    }
  } else if (action === "dissolve") {
    await db.prepare("UPDATE GroupAuthority SET terminalAt=? WHERE groupId=? AND admin=? AND terminalAt=0").bind(now,data.groupId,data.admin).run()
    // The terminal marker fences every insert/accept before membership metadata is removed.
    await db.prepare("DELETE FROM GroupInvitationStatus WHERE groupId=? AND admin=?").bind(data.groupId,data.admin).run()
    const terminal = await db.prepare("SELECT terminalAt FROM GroupAuthority WHERE groupId=? AND admin=?").bind(data.groupId,data.admin).first<{ terminalAt: number }>()
    if (!terminal?.terminalAt) throw new GroupAdmissionError("This group has not been registered.", 404)
    try {
      await ensureEventRelaySchema(db)
      const scopeId = await registerRetention(db, { kind: "group", founder: data.admin, key: data.groupId.slice(6), timestamp: now }, data.admin)
      await closeRetentionScope(db, scopeId, data.admin)
      await purgeRetentionScope(db, scopeId)
    } catch {
      // Authority is already terminal. A fresh proof or bounded maintenance can
      // retry physical deletion without ever reopening invitations or traffic.
      throw new GroupAdmissionError("The group is dissolved, but server cleanup is pending. Retry dissolution; the group stays closed.", 503)
    }
  }
  const state = await readGroupAdmissionStatus(db,data.groupId,data.admin,proof.publicKey)
  if (action === "create" && state.terminal) throw new GroupAdmissionError("Group no longer exists. Create a new group instead.",409)
  return state
}
