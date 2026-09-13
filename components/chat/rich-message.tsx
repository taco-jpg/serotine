"use client"

import { Fragment, memo, useMemo, type ReactNode } from "react"
import katex from "katex"
import "katex/dist/katex.min.css"
import { MessageText } from "@/components/message-text"
import { GifMessage } from "@/components/chat/gif-message"
import { parseGiphyUrl } from "@/lib/giphy"
import { partitionMentionText, type MentionDisplayName } from "@/lib/mention-display"
import { MAX_DISPLAY_MATH_LENGTH, MAX_INLINE_MATH_LENGTH, messageFormattingIssue, parseMessageFormatting } from "@/lib/message-format"

function mentionedText(text: string, highlight: string, mentions: string[], displayName?: MentionDisplayName): ReactNode[] {
  return partitionMentionText(text, mentions, displayName).map((part, index) => part.publicKey
    ? <span key={index} className="rounded bg-primary/10 px-0.5 font-medium text-primary"><MessageText content={part.text} query={highlight} /></span>
    : <MessageText key={index} content={part.text} query={highlight} />)
}

function linkedText(text: string, highlight: string, mentions: string[], displayName?: MentionDisplayName, preview = false): ReactNode[] {
  const result: ReactNode[] = []
  const pattern = /https?:\/\/[^\s<>"`]+/gi
  let start = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index!
    result.push(<Fragment key={`before-${index}`}>{mentionedText(text.slice(start, index), highlight, mentions, displayName)}</Fragment>)
    const href = match[0].replace(/[.,!?:;]+$/, "").replace(/\)+$/, trailing => {
      const opens = (match[0].match(/\(/g) || []).length
      const closes = (match[0].match(/\)/g) || []).length
      return trailing.slice(0, Math.max(0, trailing.length - Math.max(0, closes - opens)))
    })
    let safe = false
    try { const parsed = new URL(href); safe = parsed.protocol === "https:" || parsed.protocol === "http:" } catch { /* Keep malformed URLs as text. */ }
    const gifId = preview ? null : parseGiphyUrl(href)
    result.push(gifId
      ? <GifMessage key={`gif-${index}-${gifId}`} id={gifId} />
      : safe
      ? <a key={`link-${index}`} href={href} target="_blank" rel="noopener noreferrer" className="break-all underline underline-offset-4"><MessageText content={href} query={highlight} /></a>
      : <MessageText key={`text-${index}`} content={href} query={highlight} />)
    result.push(<Fragment key={`tail-${index}`}>{match[0].slice(href.length)}</Fragment>)
    start = index + match[0].length
  }
  result.push(<Fragment key="remaining">{mentionedText(text.slice(start), highlight, mentions, displayName)}</Fragment>)
  return result
}

export const MathPreview = memo(function MathPreview({ expression, displayMode = true, source = expression, highlight = "", showErrors = true }: { expression: string; displayMode?: boolean; source?: string; highlight?: string; showErrors?: boolean }) {
  const result = useMemo(() => {
    try {
      if (expression.length > (displayMode ? MAX_DISPLAY_MATH_LENGTH : MAX_INLINE_MATH_LENGTH)) throw new Error("This formula is too long to preview.")
      // KaTeX is the only HTML producer. User HTML is always rendered by React as text.
      return { html: katex.renderToString(expression, {
        displayMode, throwOnError: true, trust: false, strict: "error", maxExpand: 100, maxSize: 20,
        output: "htmlAndMathml",
      }) }
    } catch (error) {
      return { error: error instanceof Error ? error.message.replace(/^KaTeX parse error:\s*/, "") : "Check your formula syntax." }
    }
  }, [expression, displayMode])
  if (result.error !== undefined) return <span className={showErrors ? "block rounded-md border border-destructive/30 bg-destructive/5 p-2" : undefined}>
    <MessageText content={source} query={highlight} />
    {showErrors && <span className="mt-1 block font-sans text-xs text-destructive" role="status">LaTeX error: {result.error}</span>}
  </span>
  return <span className={displayMode ? "block max-w-full overflow-x-auto py-1" : "inline-block max-w-full overflow-x-auto align-middle"} dangerouslySetInnerHTML={{ __html: result.html! }} />
})

export const CodePreview = memo(function CodePreview({ code, language = "code", highlight = "" }: { code: string; language?: string; highlight?: string }) {
  return <div className="my-2 min-w-0 overflow-hidden rounded-lg border border-current/15 bg-current/5">
    <div className="border-b border-current/10 px-3 py-1 font-sans text-xs opacity-70">{language || "code"}</div>
    <pre className="max-w-full overflow-x-auto p-3 text-xs leading-relaxed" tabIndex={0} aria-label={`${language || "code"} code`}><code><MessageText content={code} query={highlight} /></code></pre>
  </div>
})

export const RichMessage = memo(function RichMessage({ text, highlight = "", className = "", mentions = [], displayName, preview = false }: { text: string; highlight?: string; className?: string; mentions?: string[]; displayName?: MentionDisplayName; preview?: boolean }) {
  const parts = useMemo(() => parseMessageFormatting(text), [text])
  const issue = preview ? messageFormattingIssue(parts) : undefined
  let renderedMath = 0
  return <div className={`min-w-0 whitespace-pre-wrap break-words ${className}`}>{parts.map((part, index) => {
    if (part.kind === "text") return <Fragment key={index}>{linkedText(part.text, highlight, mentions, displayName, preview)}</Fragment>
    if (part.kind === "code") return part.block
      ? <CodePreview key={index} code={part.text} language={part.language} highlight={highlight} />
      : <code key={index} className="rounded bg-current/10 px-1 py-0.5 font-mono text-[0.9em]"><MessageText content={part.text} query={highlight} /></code>
    if (renderedMath++ >= 64) return <MessageText key={index} content={part.source} query={highlight} />
    return <MathPreview key={index} expression={part.text} displayMode={part.display} source={part.source} highlight={highlight} showErrors={preview} />
  })}{issue && <span className="mt-1 block font-sans text-xs text-destructive" role="status">{issue}</span>}</div>
})
