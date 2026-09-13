export const MAX_DISPLAY_MATH_LENGTH = 2000
export const MAX_INLINE_MATH_LENGTH = 1000

export type MessageFormatPart =
  | { kind: "text"; text: string; source: string }
  | { kind: "code"; text: string; source: string; language: string; block: boolean; closed: boolean }
  | { kind: "math"; text: string; source: string; display: boolean }

/** Buttons produce deliberate delimiters; dollar amounts are always ordinary text. */
export function serializeMath(content: string, display = true): string {
  const limit = display ? MAX_DISPLAY_MATH_LENGTH : MAX_INLINE_MATH_LENGTH
  if (content.length > limit) throw new Error(`Keep this formula under ${limit + 1} characters.`)
  if (content.includes(display ? "\\]" : "\\)")) throw new Error("Enter the formula without its surrounding math delimiters.")
  return display ? `\\[${content}\\]` : `\\(${content}\\)`
}

/** A pasted code fence cannot end the surrounding code block. */
export function serializeCode(content: string, language = ""): string {
  let longestRun = 2
  for (const match of content.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length)
  const fence = "`".repeat(longestRun + 1)
  const label = /^[\w#+.-]{1,30}$/.test(language.trim()) ? language.trim() : ""
  return `${fence}${label}\n${content}\n${fence}`
}

function inlineParts(text: string): MessageFormatPart[] {
  const parts: MessageFormatPart[] = []
  // Double-dollar math is retained for existing messages; single dollars never opt in.
  const pattern = /\$\$([\s\S]{1,2000}?)\$\$|(?<!\\)\\\[([\s\S]{1,2000}?)\\\]|(?<!\\)\\\(([\s\S]{1,1000}?)\\\)|(?<!`)`([^`\n]{1,2000})`(?!`)/g
  let start = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index!
    if (index > start) parts.push({ kind: "text", text: text.slice(start, index), source: text.slice(start, index) })
    if (match[4] !== undefined) parts.push({ kind: "code", text: match[4], source: match[0], language: "", block: false, closed: true })
    else parts.push({ kind: "math", text: match[1] ?? match[2] ?? match[3], source: match[0], display: match[3] === undefined })
    start = index + match[0].length
  }
  if (start < text.length) parts.push({ kind: "text", text: text.slice(start), source: text.slice(start) })
  return parts
}

/** One grammar shared by received messages, the editor preview, and mention labels. */
export function parseMessageFormatting(text: string): MessageFormatPart[] {
  const parts: MessageFormatPart[] = []
  const opening = /(?<!`)(`{3,})([^\n`]*)\n/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = opening.exec(text))) {
    const index = match.index
    parts.push(...inlineParts(text.slice(start, index)))
    const contentStart = opening.lastIndex
    // Match the complete fence, never a shorter run embedded in pasted code.
    const closing = new RegExp("(?<!\\x60)" + match[1] + "(?!\\x60)", "g")
    closing.lastIndex = contentStart
    const end = closing.exec(text)
    const contentEnd = end?.index ?? text.length
    const sourceEnd = end ? closing.lastIndex : text.length
    const language = /^[\w#+.-]{1,30}$/.test(match[2].trim()) ? match[2].trim() : "code"
    parts.push({ kind: "code", text: text.slice(contentStart, contentEnd).replace(/\n$/, ""), source: text.slice(index, sourceEnd), language, block: true, closed: Boolean(end) })
    start = sourceEnd
    opening.lastIndex = sourceEnd
  }
  parts.push(...inlineParts(text.slice(start)))
  return parts
}

export function hasRichFormatting(text: string): boolean {
  const parts = parseMessageFormatting(text)
  return parts.some(part => part.kind !== "text") || messageFormattingIssue(parts) !== undefined
}

export function messageFormattingIssue(parts: readonly MessageFormatPart[]): string | undefined {
  for (const part of parts) {
    if (part.kind === "code" && !part.closed) return "Code block is missing its closing fence."
    if (part.kind !== "text") continue
    if (/(?<!\\)\\[()[\]]/.test(part.text)) return "Math formatting is incomplete or too long. Use the Math button to check your formula."
    if (/(?<!`)`{3,}/.test(part.text)) return "Code block is incomplete. Use the Code button to check it."
  }
}
