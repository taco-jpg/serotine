import { ID_PATTERN, PUBLIC_KEY_PATTERN } from "./protocol"
import type { CommunityTransfer } from "./community-types"
import { validateCommunityTransfers } from "./community-protocol"

export type RetentionDescriptor =
  | { kind: "direct"; first: string; second: string; timestamp: number }
  | { kind: "group" | "community"; founder: string; key: string; timestamp: number; transfers?: CommunityTransfer[] }
export function retentionDescriptor(conversationId: string, owner: string, timestamp: number, admin?: string, transfers?: CommunityTransfer[]): RetentionDescriptor {
  if (conversationId.startsWith("group:")) {
    if (!admin) throw new Error("Group authority is unavailable.")
    return { kind: "group", founder: admin, key: conversationId.slice(6), timestamp }
  }
  if (conversationId.startsWith("community:")) return { kind: "community", founder: conversationId.slice(10, 140), key: conversationId.slice(141), timestamp, transfers: transfers ?? [] }
  const [first, second] = [owner, conversationId].sort()
  return { kind: "direct", first, second, timestamp }
}
export async function retentionScopeId(descriptor: RetentionDescriptor): Promise<string> {
  const value = descriptor.kind === "direct" ? ["direct", descriptor.first, descriptor.second] : [descriptor.kind, descriptor.founder, descriptor.key]
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(["serotine-retention-v1", ...value])))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")
}
export async function validRetentionDescriptor(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as RetentionDescriptor
  if (!Number.isSafeInteger(item.timestamp) || item.timestamp <= 0 || item.timestamp > Date.now() + 60_000) return false
  if (item.kind === "direct") return Object.keys(item).length === 4 && PUBLIC_KEY_PATTERN.test(item.first) && PUBLIC_KEY_PATTERN.test(item.second) && item.first <= item.second
  if (item.kind !== "group" && item.kind !== "community") return false
  if (!Object.keys(item).every(key => ["kind", "founder", "key", "timestamp", "transfers"].includes(key)) || !PUBLIC_KEY_PATTERN.test(item.founder) || !ID_PATTERN.test(item.key)) return false
  if (item.kind === "group") return item.transfers === undefined
  return await validateCommunityTransfers(`community:${item.founder}:${item.key}`, item.transfers ?? [])
}
