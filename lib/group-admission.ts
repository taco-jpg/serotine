import { arrayBufferToHex, verifySignature } from "./crypto"
import type { Identity } from "./identity"
import { ID_PATTERN, PUBLIC_KEY_PATTERN } from "./protocol"

export const GROUP_INVITATION_MS = 7 * 24 * 60 * 60_000
export interface GroupInvitation {
  id: string; groupId: string; admin: string; invitee: string; createdAt: number; expiresAt: number; signature: string
}
export interface GroupAcceptance { invitation: GroupInvitation; acceptedAt: number; signature: string }
export interface GroupInvitationPreview { invitation: GroupInvitation; name: string; memberCount: number; migration?: boolean }
export type GroupInvitationStatus = "pending" | "accepted" | "declined" | "revoked"
export interface GroupAdmissionStatus {
  terminal: boolean
  invitations: Array<{ invitationId: string; invitee: string; expiresAt: number; status: GroupInvitationStatus; acceptance?: GroupAcceptance }>
}
export const isGroupAddress = (value: unknown): value is string => typeof value === "string" && value.startsWith("group:") && ID_PATTERN.test(value.slice(6))
const exact = (value: object, fields: string[]) => Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key))
const signature = (value: unknown) => typeof value === "string" && /^[0-9a-f]{128}$/.test(value)
const inviteText = (i: Omit<GroupInvitation, "signature"> | GroupInvitation) => JSON.stringify(["serotine:group-invitation:v1", i.id, i.groupId, i.admin, i.invitee, i.createdAt, i.expiresAt])
const acceptanceText = (a: Omit<GroupAcceptance, "signature"> | GroupAcceptance) => JSON.stringify(["serotine:group-acceptance:v1", inviteText(a.invitation), a.invitation.signature, a.acceptedAt])
async function sign(text: string, identity: Identity) {
  const key = await crypto.subtle.importKey("jwk", { ...identity.privateKey, key_ops: ["sign"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
  return arrayBufferToHex(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(text)))
}
export async function signGroupInvitation(invitation: Omit<GroupInvitation, "signature">, identity: Identity): Promise<GroupInvitation> {
  if (invitation.admin !== identity.publicKey) throw new Error("Only the administrator can invite group members.")
  return { ...invitation, signature: await sign(inviteText(invitation), identity) }
}
export async function validateGroupInvitation(value: unknown): Promise<boolean> {
  try {
    const i = value as GroupInvitation
    if (!i || typeof i !== "object" || !exact(i, ["id", "groupId", "admin", "invitee", "createdAt", "expiresAt", "signature"])
      || !ID_PATTERN.test(i.id) || !isGroupAddress(i.groupId) || !PUBLIC_KEY_PATTERN.test(i.admin) || !PUBLIC_KEY_PATTERN.test(i.invitee) || i.admin === i.invitee
      || !Number.isSafeInteger(i.createdAt) || i.createdAt < 1 || i.createdAt > Date.now() + 60_000 || !Number.isSafeInteger(i.expiresAt)
      || i.expiresAt <= i.createdAt || i.expiresAt - i.createdAt > GROUP_INVITATION_MS || !signature(i.signature)) return false
    return await verifySignature(inviteText(i), i.signature, i.admin)
  } catch { return false }
}
export async function signGroupAcceptance(invitation: GroupInvitation, identity: Identity): Promise<GroupAcceptance> {
  if (invitation.invitee !== identity.publicKey || !await validateGroupInvitation(invitation)) throw new Error("This group invitation is invalid.")
  const acceptedAt = Date.now()
  if (acceptedAt >= invitation.expiresAt) throw new Error("This invitation expired. Ask for a new invitation.")
  return { invitation, acceptedAt, signature: await sign(acceptanceText({ invitation, acceptedAt }), identity) }
}
export async function validateGroupAcceptance(value: unknown): Promise<boolean> {
  try {
    const a = value as GroupAcceptance
    return !!a && typeof a === "object" && exact(a, ["invitation", "acceptedAt", "signature"])
      && await validateGroupInvitation(a.invitation) && Number.isSafeInteger(a.acceptedAt) && a.acceptedAt >= a.invitation.createdAt - 60_000
      && a.acceptedAt < a.invitation.expiresAt && a.acceptedAt <= Date.now() + 60_000 && signature(a.signature)
      && await verifySignature(acceptanceText(a), a.signature, a.invitation.invitee)
  } catch { return false }
}
