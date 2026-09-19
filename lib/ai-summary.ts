import type { MessageRecord } from "./messaging-types"

export const SUMMARY_ACTION = "plugin:summary"
export const SUMMARY_MAX_MESSAGES = 80
export const SUMMARY_MAX_TEXT = 12_000
export const SUMMARY_MAX_MESSAGE_TEXT = 2_000
export const SUMMARY_MAX_OUTPUT = 4_000
export const SUMMARY_RECENT_WINDOW_MS = 24 * 60 * 60_000
export const SUMMARY_TIMEOUT_MS = 25_000
export type SummarySpeaker = "You" | `Participant ${number}`
export interface SummaryMessage { speaker: SummarySpeaker; text: string }
export interface SummaryRange {
  messages: SummaryMessage[]
  mode: "since-reply" | "recent"
  truncated: boolean
  excludedCount: number
  fromTimestamp?: number
  toTimestamp?: number
}

function ordinary(message: MessageRecord): boolean {
  return message.route !== "direct-only" && !message.private && !message.secret && message.expiresAt === undefined
    && !message.attachment && !message.poll && message.delivery !== "pending" && message.delivery !== "failed"
    && typeof message.content === "string" && message.content.trim().length > 0
}

/** The preview is the complete provider payload. No contact lookup or history
 * fetch happens here, and privacy-sensitive records cannot become AI input. */
export function selectSummaryRange(messages: readonly MessageRecord[], conversationId: string, selfPublicKey: string, now = Date.now()): SummaryRange {
  const ordered = messages.filter(message => message.conversationId === conversationId
    && Number.isSafeInteger(message.timestamp) && message.timestamp > 0 && message.timestamp <= now)
    .sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))
  let boundary = -1
  for (let index = ordered.length - 1; index >= 0; index--) {
    if (ordered[index].senderPubKey === selfPublicKey && ordinary(ordered[index])) { boundary = index; break }
  }
  const candidates = boundary >= 0 ? ordered.slice(boundary + 1) : ordered.filter(message => message.timestamp >= now - SUMMARY_RECENT_WINDOW_MS)
  const eligible = candidates.filter(ordinary)
  const selected: Array<{ record: MessageRecord; text: string }> = []
  let used = 0, truncated = false
  for (let index = eligible.length - 1; index >= 0; index--) {
    const record = eligible[index]
    if (selected.length === SUMMARY_MAX_MESSAGES || used === SUMMARY_MAX_TEXT) { truncated = true; break }
    // Generated mentions contain addresses. Strip those addresses, including
    // keys pasted into text, before previewing or exporting ordinary text.
    const text = record.content.trim().replace(/(?:@)?04[0-9a-f]{128}\b/gi, "[address]")
    const limit = Math.min(SUMMARY_MAX_MESSAGE_TEXT, SUMMARY_MAX_TEXT - used)
    let bounded = text.slice(0, limit)
    // Avoid exporting a half surrogate when a message is clipped.
    if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1)
    if (!bounded) { truncated = true; break }
    if (bounded.length < text.length) truncated = true
    selected.push({ record, text: bounded })
    used += bounded.length
  }
  selected.reverse()
  const speakers = new Map<string, SummarySpeaker>()
  const result = selected.map(({ record, text }) => {
    let speaker: SummarySpeaker = "You"
    if (record.senderPubKey !== selfPublicKey) {
      speaker = speakers.get(record.senderPubKey) ?? `Participant ${speakers.size + 1}`
      speakers.set(record.senderPubKey, speaker)
    }
    return { speaker, text }
  })
  return { messages: result, mode: boundary >= 0 ? "since-reply" : "recent", truncated,
    excludedCount: candidates.length - eligible.length,
    ...(selected.length ? { fromTimestamp: selected[0].record.timestamp, toTimestamp: selected.at(-1)!.record.timestamp } : {}) }
}

export function isSummaryMessages(value: unknown): value is SummaryMessage[] {
  if (!Array.isArray(value) || !value.length || value.length > SUMMARY_MAX_MESSAGES) return false
  let total = 0
  for (const message of value) {
    if (!message || typeof message !== "object" || Array.isArray(message)
      || Object.keys(message).length !== 2 || !Object.hasOwn(message, "speaker") || !Object.hasOwn(message, "text")
      || (message.speaker !== "You" && (typeof message.speaker !== "string" || !/^Participant ([1-9]|[1-7][0-9]|80)$/.test(message.speaker)))
      || typeof message.text !== "string" || !message.text.trim() || message.text.length > SUMMARY_MAX_MESSAGE_TEXT) return false
    total += message.text.length
    if (total > SUMMARY_MAX_TEXT) return false
  }
  return true
}
