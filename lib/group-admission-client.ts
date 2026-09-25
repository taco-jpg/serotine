import { apiFetch } from "../native/shared/transport"
import type { Identity } from "./identity"
import { createRequestProof } from "./request-auth"
import type { GroupAdmissionStatus, GroupAcceptance, GroupInvitation } from "./group-admission"

export type GroupAdmissionAction = "create" | "status" | "invite" | "accept" | "decline" | "revoke" | "dissolve"
export async function groupAdmissionRequest(identity: Identity, action: GroupAdmissionAction, data: { groupId: string; admin: string; invitation?: GroupInvitation; acceptance?: GroupAcceptance; invitationId?: string }): Promise<GroupAdmissionStatus> {
  const proof = await createRequestProof(`group:${action}`, data, identity.privateKey, identity.publicKey)
  const response = await apiFetch("/api/groups", { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
    referrerPolicy: "strict-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: 1, action, data, proof }) })
  const result = await response.json() as { success?: boolean; error?: string; state?: GroupAdmissionStatus }
  if (!response.ok || result.success !== true || !result.state || !Array.isArray(result.state.invitations) || typeof result.state.terminal !== "boolean")
    throw new Error(result.error || "Group membership could not be checked. Reconnect and try again.")
  return result.state
}
