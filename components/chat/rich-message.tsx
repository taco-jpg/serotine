"use client"

import { Fragment, type ReactNode } from "react"
import katex from "katex"
import "katex/dist/katex.min.css"
import { MessageText } from "@/components/message-text"
import { GifMessage } from "@/components/chat/gif-message"
import { parseGiphyUrl } from "@/lib/giphy"
import { partitionMentionText, type MentionDisplayName } from "@/lib/mention-display"

function mentionedText(text: string, highlight: string, mentions: string[], displayName?: MentionDisplayName): ReactNode[] {
  return partitionMentionText(text, mentions, displayName).map((part, index) => part.publicKey
    ? <span key={index} className="rounded bg-primary/10 px-0.5 font-medium text-primary"><MessageText content={part.text} query={highlight} /></span>
    : <MessageText key={index} content={part.text} query={highlight} />)
}

function linkedText(text: string, highlight: string, mentions: string[], displayName?: MentionDisplayName): ReactNode[] {
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
    const gifId = parseGiphyUrl(href)
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

function inlineContent(text: string, highlight: string, mentions: string[], displayName?: MentionDisplayName): ReactNode[] {
  const nodes: ReactNode[] = []
  const pattern = /\$\$([\s\S]{1,2000}?)\$\$|\\\[([\s\S]{1,2000}?)\\\]|(?<!\\)\$([^\n$]{1,1000}?)\$(?!\$)|\\\(([\s\S]{1,1000}?)\\\)|`([^`\n]{1,2000})`/g
  let start = 0
  let renderedMath = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index!
    nodes.push(<Fragment key={`text-${index}`}>{linkedText(text.slice(start, index), highlight, mentions, displayName)}</Fragment>)
    if (match[5] !== undefined) {
      nodes.push(<code key={`code-${index}`} className="rounded bg-current/10 px-1 py-0.5 font-mono text-[0.9em]"><MessageText content={match[5]} query={highlight} /></code>)
    } else if (renderedMath++ < 64) {
      const expression = match[1] ?? match[2] ?? match[3] ?? match[4]
      const displayMode = match[1] !== undefined || match[2] !== undefined
      try {
        // KaTeX is the only HTML producer. User HTML is always rendered by React as text.
        const html = katex.renderToString(expression, {
          displayMode, throwOnError: true, trust: false, strict: "error", maxExpand: 100, maxSize: 20,
          output: "htmlAndMathml",
        })
        nodes.push(<span key={`math-${index}`} className={displayMode ? "block max-w-full overflow-x-auto py-1" : "inline-block max-w-full align-middle"} dangerouslySetInnerHTML={{ __html: html }} />)
      } catch {
        nodes.push(<MessageText key={`fallback-${index}`} content={match[0]} query={highlight} />)
      }
    } else nodes.push(<MessageText key={`limit-${index}`} content={match[0]} query={highlight} />)
    start = index + match[0].length
  }
  nodes.push(<Fragment key="remaining">{linkedText(text.slice(start), highlight, mentions, displayName)}</Fragment>)
  return nodes
}

export function RichMessage({ text, highlight = "", className = "", mentions = [], displayName }: { text: string; highlight?: string; className?: string; mentions?: string[]; displayName?: MentionDisplayName }) {
  const nodes: ReactNode[] = []
  const pattern = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g
  let start = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index!
    nodes.push(<Fragment key={`text-${index}`}>{inlineContent(text.slice(start, index), highlight, mentions, displayName)}</Fragment>)
    const language = /^[\w#+.-]{1,30}$/.test(match[1].trim()) ? match[1].trim() : "code"
    nodes.push(<div key={`fence-${index}`} className="my-2 min-w-0 overflow-hidden rounded-lg border border-current/15 bg-current/5">
      <div className="border-b border-current/10 px-3 py-1 font-sans text-xs opacity-70">{language}</div>
      <pre className="max-w-full overflow-x-auto p-3 text-xs leading-relaxed" tabIndex={0} aria-label={`${language} code`}><code><MessageText content={match[2].replace(/\n$/, "")} query={highlight} /></code></pre>
    </div>)
    start = index + match[0].length
  }
  nodes.push(<Fragment key="remaining">{inlineContent(text.slice(start), highlight, mentions, displayName)}</Fragment>)
  return <div className={`min-w-0 whitespace-pre-wrap break-words ${className}`}>{nodes}</div>
}
