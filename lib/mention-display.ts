import { shortAddress } from "./identity"
import { PUBLIC_KEY_PATTERN } from "./protocol"

export interface MentionDisplayPart { text: string; publicKey?: string }
export type MentionDisplayName = (publicKey: string) => string

/** Resolve only address tokens backed by recipient metadata, using this viewer's labels. */
export function partitionMentionText(text: string, mentions: readonly string[] = [], displayName?: MentionDisplayName): MentionDisplayPart[] {
  if (!displayName || !mentions.length) return [{ text }]
  const recipients = new Map<string, string | null>()
  for (const key of mentions) {
    if (typeof key !== "string" || !PUBLIC_KEY_PATTERN.test(key.toLowerCase())) continue
    const publicKey = key.toLowerCase()
    const short = shortAddress(publicKey)
    for (const token of [`@${publicKey}`, `@${short}`, `@${short.replace("…", "...")}`]) {
      // Older messages used shortened addresses; a collision cannot identify a person.
      recipients.set(token, recipients.has(token) && recipients.get(token) !== publicKey ? null : publicKey)
    }
  }
  if (!recipients.size) return [{ text }]

  const parts: MentionDisplayPart[] = []
  // Skip code, math, and URLs as RichMessage does, including in plain-text previews.
  const pattern = /```[^\n`]*\n[\s\S]*?(?:```|$)|\$\$[\s\S]{1,2000}?\$\$|\\\[[\s\S]{1,2000}?\\\]|(?<!\\)\$[^\n$]{1,1000}?\$(?!\$)|\\\([\s\S]{1,1000}?\\\)|`[^`\n]{1,2000}`|https?:\/\/[^\s<>"`]+|(@(?:04[0-9a-f]{128}|04[0-9a-f]{6}(?:…|\.{3})[0-9a-f]{6}))/gi
  let start = 0
  for (const match of text.matchAll(pattern)) {
    if (!match[1]) continue
    const index = match.index!
    const end = index + match[0].length
    if (index > 0 && !/[\s()[\]{}'"“”‘’,!?:;]/.test(text[index - 1])) continue
    if (end < text.length && !/[\s.,!?;:(){}[\]'"“”‘’]/.test(text[end])) continue
    const publicKey = recipients.get(match[0].toLowerCase())
    if (!publicKey) continue
    const label = displayName(publicKey)
    if (!label) continue
    if (index > start) parts.push({ text: text.slice(start, index) })
    parts.push({ text: `@${label}`, publicKey })
    start = end
  }
  if (start < text.length || !parts.length) parts.push({ text: text.slice(start) })
  return parts
}

/** For local plain-text summaries only; never use display labels in outgoing content. */
export function formatMentionText(text: string, mentions: readonly string[] = [], displayName?: MentionDisplayName): string {
  return partitionMentionText(text, mentions, displayName).map(part => part.text).join("")
}
