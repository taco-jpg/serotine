"use client"

import { useEffect, useRef, useState } from "react"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"

interface Draft { key: string; content: string; saved: boolean; serialized: string | null }

// Keep the only copy alive across keyed route remounts in this tab.
const unsavedDrafts = new Map<string, Draft>()
const warnBeforeUnload = (event: BeforeUnloadEvent) => {
  if ([...unsavedDrafts.values()].some(draft => draft.content)) { event.preventDefault(); event.returnValue = "" }
}
function remember(draft: Draft) {
  if (draft.saved) unsavedDrafts.delete(draft.key)
  else unsavedDrafts.set(draft.key, draft)
  if (typeof window !== "undefined") {
    window.removeEventListener("beforeunload", warnBeforeUnload)
    if (unsavedDrafts.size) window.addEventListener("beforeunload", warnBeforeUnload)
  }
}

/** Drafts use the same device-local trust boundary as message history. */
export function useChatDraft(owner: string, peer: string) {
  const key = owner ? `serotine_draft:${owner}:${peer}` : ""
  const mounted = useRef(true)
  const [draft, setDraft] = useState<Draft>({ key: "", content: "", saved: true, serialized: null })

  useEffect(() => {
    mounted.current = true
    if (key) {
      const unsaved = unsavedDrafts.get(key)
      if (unsaved) { setDraft(unsaved); return () => { mounted.current = false } }
      try {
        const serialized = localStorage.getItem(key)
        const record = serialized ? JSON.parse(serialized) : null
        if (record && (typeof record.content !== "string" || typeof record.revision !== "string")) throw new Error("Invalid draft")
        setDraft({ key, content: record?.content.slice(0, MAX_MESSAGE_LENGTH) || "", saved: true, serialized })
      } catch {
        setDraft({ key, content: "", saved: false, serialized: null })
      }
    }
    return () => { mounted.current = false }
  }, [key])

  const setContent = (content: string) => {
    if (!key || draft.key !== key) return
    let saved = true
    const serialized = content ? JSON.stringify({ content, revision: crypto.randomUUID() }) : null
    try {
      if (serialized) localStorage.setItem(key, serialized)
      else localStorage.removeItem(key)
    } catch { saved = false }
    // A failed disk write must never discard text from the composer.
    const next = { key, content, saved, serialized }
    remember(next)
    setDraft(next)
  }

  // This closure belongs to one submitted revision. A slow send must not erase
  // a newer edit made after navigation, or in another tab, even if its text matches.
  const clearSubmittedDraft = () => {
    if (!key || draft.key !== key) return
    let saved = true
    try {
      if (localStorage.getItem(key) === draft.serialized) localStorage.removeItem(key)
    } catch { saved = false }
    if (unsavedDrafts.get(key)?.serialized === draft.serialized) remember({ key, content: "", saved, serialized: null })
    if (mounted.current) setDraft(current => current.key === key && current.serialized === draft.serialized
      ? { key, content: "", saved, serialized: null } : current)
  }

  const retryDraftSave = () => setContent(draft.content)
  return { content: draft.key === key ? draft.content : "", setContent, clearSubmittedDraft, retryDraftSave, draftReady: !!key && draft.key === key, draftSaved: draft.saved }
}
