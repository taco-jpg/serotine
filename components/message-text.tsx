import { Fragment } from "react"

export function literalSearch(query: string) {
  const term = query.trim()
  return term ? new RegExp("(" + term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "iu") : null
}

export function MessageText({ content, query }: { content: string; query: string }) {
  const pattern = literalSearch(query)
  if (!pattern) return <>{content}</>
  return <>{content.split(pattern).map((part, index) => index % 2
    ? <mark key={index} className="rounded-[2px] bg-primary/25 text-foreground ring-1 ring-primary/40">{part}</mark>
    : <Fragment key={index}>{part}</Fragment>)}</>
}
