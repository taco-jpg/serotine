"use client"

import { useEffect, useState } from "react"
import { validMentionSpans, type MentionSpan } from "@/lib/composer-mentions"
import { PUBLIC_KEY_PATTERN } from "@/lib/protocol"

interface MentionDraft { content: string; revision: string | null; spans: MentionSpan[] }
const memory = new Map<string, MentionDraft>()

function readRevision(draftKey: string, content: string): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) || "null")
    return saved?.content === content && typeof saved?.revision === "string" ? saved.revision : null
  } catch { return null }
}

function readSpans(value: unknown, content: string): MentionSpan[] {
  if (!Array.isArray(value) || value.length > 100) return []
  return validMentionSpans(content, value.filter((span): span is MentionSpan => !!span && typeof span === "object"
    && typeof span.publicKey === "string" && PUBLIC_KEY_PATTERN.test(span.publicKey)
    && Number.isSafeInteger(span.start) && Number.isSafeInteger(span.end)
    && span.start >= 0 && span.end > span.start && span.end <= content.length
    && typeof span.text === "string" && span.text.startsWith("@") && span.text.length > 1))
}

/** Restore only spans bound to this exact saved text and draft revision. */
export function useMentionDraft(owner: string, peer: string, content: string, draftReady: boolean) {
  const key = owner ? `serotine_mention_draft:${owner}:${peer}` : ""
  const draftKey = `serotine_draft:${owner}:${peer}`
  const revision = draftReady ? readRevision(draftKey, content) : null
  const [state, setState] = useState<{ key: string; draft: MentionDraft }>({ key: "", draft: { content: "", revision: null, spans: [] } })

  useEffect(() => {
    if (!key || !draftReady) return
    let draft: MentionDraft = { content, revision, spans: [] }
    const remembered = memory.get(key)
    if (content && remembered?.content === content && remembered.revision === revision) draft = remembered
    else if (content && revision !== null) {
      try {
        const saved = JSON.parse(localStorage.getItem(key) || "null")
        if (saved?.content === content && saved?.revision === revision) draft = { content, revision, spans: readSpans(saved.spans, content) }
      } catch { /* A malformed or unavailable sidecar must never invent recipients. */ }
    }
    if (draft.spans.length) memory.set(key, draft)
    else memory.delete(key)
    if (!content) {
      try { localStorage.removeItem(key) } catch { /* An old revision cannot reattach to a new draft. */ }
    }
    setState({ key, draft })
  }, [key, content, draftReady, revision])

  // Call after useChatDraft.setContent so the text revision exists before saving
  // its recipient bindings. Selection changes can still work with blocked storage.
  const saveMentionDraft = (nextContent: string, nextSpans: MentionSpan[]) => {
    if (!key || !draftReady) return
    const draft: MentionDraft = { content: nextContent, revision: readRevision(draftKey, nextContent), spans: readSpans(nextSpans, nextContent) }
    if (draft.spans.length) memory.set(key, draft)
    else memory.delete(key)
    try {
      if (draft.spans.length && draft.revision !== null) localStorage.setItem(key, JSON.stringify(draft))
      else localStorage.removeItem(key)
    } catch { /* The in-memory copy remains available for this tab. */ }
    setState({ key, draft })
  }

  return {
    mentionSpans: draftReady && state.key === key && state.draft.content === content && state.draft.revision === revision ? state.draft.spans : [],
    saveMentionDraft,
  }
}
