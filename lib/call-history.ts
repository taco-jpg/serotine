import type { CompletedCall } from "./call-types"
import { ID_PATTERN, PUBLIC_KEY_PATTERN } from "./protocol"

/** Display-only summaries. No signaling, device IDs, SDP, ICE, or credentials. */
export interface CallHistoryRecord {
  id: string
  peer: string
  mode: "audio" | "video"
  direction: "incoming" | "outgoing"
  outcome: "ended" | "declined" | "unanswered" | "busy" | "failed" | "cancelled"
  startedAt: number
  endedAt: number
  durationSeconds: number
}
export interface CallHistorySnapshot { version: 1; records: CallHistoryRecord[]; deleted: string[] }
export const emptyCallHistory = (): CallHistorySnapshot => ({ version: 1, records: [], deleted: [] })
const MAX_RECORDS = 10_000
const MAX_DATE = 8_640_000_000_000_000

function normalizeRecord(value: unknown, owner: string): CallHistoryRecord {
  if (!value || typeof value !== "object") throw new Error("The saved call history is invalid.")
  const row = value as CallHistoryRecord & { private?: boolean }
  if (typeof row.id !== "string" || !ID_PATTERN.test(row.id) || typeof row.peer !== "string" || !PUBLIC_KEY_PATTERN.test(row.peer) || row.peer === owner
    || !["audio", "video"].includes(row.mode) || !["incoming", "outgoing"].includes(row.direction)
    || !["ended", "declined", "unanswered", "busy", "failed", "cancelled"].includes(row.outcome)
    || !Number.isSafeInteger(row.startedAt) || row.startedAt <= 0 || !Number.isSafeInteger(row.endedAt) || row.endedAt < row.startedAt || row.endedAt > MAX_DATE
    || !Number.isSafeInteger(row.durationSeconds) || row.durationSeconds < 0 || row.durationSeconds > Math.ceil((row.endedAt - row.startedAt) / 1000)
    || row.private === true) throw new Error("The saved call history is invalid.")
  return { id: row.id, peer: row.peer, mode: row.mode, direction: row.direction, outcome: row.outcome,
    startedAt: row.startedAt, endedAt: row.endedAt, durationSeconds: row.durationSeconds }
}
export function validateCallHistory(value: unknown, owner: string): CallHistorySnapshot {
  if (value === undefined) return emptyCallHistory()
  const data = value as CallHistorySnapshot
  if (!data || data.version !== 1 || !Array.isArray(data.records) || data.records.length > MAX_RECORDS
    || !Array.isArray(data.deleted) || data.deleted.length > 250_000 || !data.deleted.every(id => typeof id === "string" && ID_PATTERN.test(id))) {
    throw new Error("The saved call history is invalid.")
  }
  const records = data.records.map(row => normalizeRecord(row, owner))
  if (new Set(records.map(row => row.id)).size !== records.length) throw new Error("The saved call history contains duplicate calls.")
  return { version: 1, records, deleted: [...new Set(data.deleted)] }
}
export function completedCallRecord(call: CompletedCall, owner: string): CallHistoryRecord | null {
  if (call.private) return null
  return normalizeRecord(call, owner)
}
export function mergeCallHistory(left: CallHistorySnapshot, right: CallHistorySnapshot, deletedConversations: Record<string, { deletedAt: number }> = {}): CallHistorySnapshot {
  const deleted = [...new Set([...left.deleted, ...right.deleted])]
  const tombstones = new Set(deleted)
  const records = new Map(left.records.map(row => [row.id, row]))
  for (const row of right.records) records.set(row.id, row)
  return { version: 1, deleted, records: [...records.values()]
    .filter(row => !tombstones.has(row.id) && row.startedAt > (deletedConversations[row.peer]?.deletedAt ?? 0))
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id)).slice(-MAX_RECORDS) }
}
