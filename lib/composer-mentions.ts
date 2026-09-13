export interface MentionSpan { publicKey: string; start: number; end: number; text: string }
export interface MentionQuery { start: number; end: number; query: string }
export interface MentionEditRange { start: number; end: number }

/** Only a standalone @ at the caret opens completion; email addresses are ordinary text. */
export function findMentionQuery(text: string, start: number, end = start): MentionQuery | null {
  if (start !== end) return null
  const match = /(?:^|\s)@([^\s@]{0,80})$/.exec(text.slice(0, start))
  return match ? { start: start - match[1].length - 1, end: start, query: match[1] } : null
}

export function validMentionSpans(text: string, spans: MentionSpan[]): MentionSpan[] {
  return spans.filter(span => text.slice(span.start, span.end) === span.text
    && (span.start === 0 || /\s/.test(text[span.start - 1]))
    && (span.end === text.length || /[\s.,!?;:)}\]]/.test(text[span.end])))
}

/** Shift untouched tokens after an edit, and stop mentioning anyone whose token was edited. */
export function updateMentionSpans(before: string, after: string, spans: MentionSpan[], editRange?: MentionEditRange): MentionSpan[] {
  const move = (span: MentionSpan, start: number, oldEnd: number, newEnd: number): MentionSpan | null => {
    if (span.end <= start) return span
    if (span.start >= oldEnd) return { ...span, start: span.start + newEnd - oldEnd, end: span.end + newEnd - oldEnd }
    return null
  }
  if (editRange && Number.isInteger(editRange.start) && Number.isInteger(editRange.end)
    && editRange.start >= 0 && editRange.end >= editRange.start && editRange.end <= before.length) {
    const newEnd = editRange.end + after.length - before.length
    if (newEnd >= editRange.start && before.slice(0, editRange.start) === after.slice(0, editRange.start)
      && before.slice(editRange.end) === after.slice(newEnd)) {
      return validMentionSpans(after, spans.flatMap(span => {
        const moved = move(span, editRange.start, editRange.end, newEnd)
        return moved ? [moved] : []
      }))
    }
  }
  if (before === after) return validMentionSpans(after, spans)
  let prefix = 0, suffix = 0
  const shortest = Math.min(before.length, after.length)
  while (prefix < shortest && before[prefix] === after[prefix]) prefix++
  while (suffix < shortest && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++
  // Repeated text can describe several equally valid edits. Keep a recipient
  // only when both the earliest and latest possible edit preserve the same token.
  // Otherwise deleting one of two @Alice tokens could notify the wrong Alice.
  const earlyStart = Math.min(prefix, shortest - suffix)
  const lateSuffix = Math.min(suffix, shortest - prefix)
  return validMentionSpans(after, spans.flatMap(span => {
    const early = move(span, earlyStart, before.length - suffix, after.length - suffix)
    const late = move(span, prefix, before.length - lateSuffix, after.length - lateSuffix)
    return early && late && early.start === late.start && early.end === late.end ? [early] : []
  }))
}

export function insertMention(text: string, range: { start: number; end: number }, publicKey: string, label: string) {
  const prefix = range.start > 0 && !/\s/.test(text[range.start - 1]) ? " " : ""
  const token = `@${label.replace(/\s+/g, " ").trim()}`
  const start = range.start + prefix.length
  const replacement = `${prefix}${token} `
  return {
    content: text.slice(0, range.start) + replacement + text.slice(range.end),
    span: { publicKey, start, end: start + token.length, text: token },
    caret: range.start + replacement.length,
  }
}

/** Resolve local composer labels to addresses before text leaves this browser. */
export function serializeMentionDraft(text: string, spans: MentionSpan[]) {
  const valid = validMentionSpans(text, spans).sort((a, b) => a.start - b.start)
  let content = "", cursor = 0
  const mentions = new Set<string>()
  for (const span of valid) {
    if (span.start < cursor) continue
    content += text.slice(cursor, span.start) + `@${span.publicKey}`
    mentions.add(span.publicKey)
    cursor = span.end
  }
  return { content: content + text.slice(cursor), mentions: [...mentions] }
}
