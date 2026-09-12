"use client"

import { useEffect, useRef, useState } from "react"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"

interface Draft { key: string; content: string; saved: boolean; serialized: string | null; pending?: "read" | "clear"; clearRevision?: string | null }

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

function readDraft(key: string): Draft {
  try {
    const serialized = localStorage.getItem(key)
    const record = serialized ? JSON.parse(serialized) : null
    if (record && (typeof record.content !== "string" || typeof record.revision !== "string")) throw new Error("Invalid draft")
    return { key, content: record?.content.slice(0, MAX_MESSAGE_LENGTH) || "", saved: true, serialized }
  } catch { return { key, content: "", saved: false, serialized: null, pending: "read" } }
}

function clearRevision(key: string, revision: string | null): Draft {
  try {
    const current = localStorage.getItem(key)
    if (current === revision) localStorage.removeItem(key)
    else if (current !== null) return readDraft(key) // Preserve a newer edit from another tab.
    return { key, content: "", saved: true, serialized: null }
  } catch { return { key, content: "", saved: false, serialized: null, pending: "clear", clearRevision: revision } }
}

/** Drafts use the same device-local trust boundary as message history. */
export function useChatDraft(owner: string, peer: string, persistent = true) {
  const storageKey = owner ? `serotine_draft:${owner}:${peer}` : ""
  const key = storageKey ? persistent ? storageKey : `private:${storageKey}` : ""
  const activeKey = useRef(key)
  activeKey.current = key
  const mounted = useRef(true)
  const [draft, setDraft] = useState<Draft>({ key: "", content: "", saved: true, serialized: null })

  useEffect(() => {
    mounted.current = true
    if (key) {
      if (!persistent) {
        // Private text never enters either localStorage or the cross-route cache.
        try { localStorage.removeItem(storageKey) } catch { /* No private text has been written. */ }
        remember({ key: storageKey, content: "", saved: true, serialized: null })
        setDraft({ key, content: "", saved: true, serialized: null })
        return () => { mounted.current = false }
      }
      const unsaved = unsavedDrafts.get(key)
      const next = unsaved?.pending === "clear" ? clearRevision(key, unsaved.clearRevision ?? null) : unsaved ?? readDraft(key)
      remember(next)
      setDraft(next)
    }
    return () => { mounted.current = false }
  }, [key, storageKey, persistent])

  const setContent = (content: string) => {
    if (!key || draft.key !== key || activeKey.current !== key) return
    if (!persistent) {
      setDraft({ key, content, saved: true, serialized: crypto.randomUUID() })
      return
    }
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
    if (!persistent) {
      if (mounted.current) setDraft(current => current.key === key && current.serialized === draft.serialized
        ? { key, content: "", saved: true, serialized: null } : current)
      return
    }
    const next = clearRevision(key, draft.serialized)
    const unsaved = unsavedDrafts.get(key)
    if (!unsaved || unsaved.serialized === draft.serialized) remember(next)
    if (mounted.current) setDraft(current => current.key === key && current.serialized === draft.serialized
      ? next : current)
  }

  const retryDraftSave = () => {
    if (!key || draft.key !== key) return
    if (!persistent) return
    if (!draft.pending) { setContent(draft.content); return }
    const next = draft.pending === "read" ? readDraft(key) : clearRevision(key, draft.clearRevision ?? null)
    remember(next); setDraft(next)
  }
  return { content: draft.key === key ? draft.content : "", setContent, clearSubmittedDraft, retryDraftSave, draftReady: !!key && draft.key === key, draftSaved: draft.saved, draftIssue: draft.pending }
}
