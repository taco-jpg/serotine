"use client"

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { loadIdentity } from "@/lib/identity"
import { MessagingEngine } from "@/lib/messaging"
import { defaultMessagingPreferences } from "@/lib/messaging-store"
import type { MessagingContextValue } from "@/lib/messaging-types"

const MessagingContext = createContext<MessagingContextValue | null>(null)
const unavailable = async (): Promise<never> => { throw new Error("Your identity is still loading. Try again in a moment.") }
const empty = {
  identity: null, contacts: [], ready: false, error: null, status: "connecting", conversations: [], messages: [], groups: [], requests: [], preferences: defaultMessagingPreferences(),
  sendText: unavailable, editMessage: unavailable, pinMessage: unavailable, createPoll: unavailable, vote: unavailable, createGroup: unavailable, updateGroup: unavailable, leaveGroup: unavailable,
  acceptRequest: unavailable, blockContact: unavailable, markRead: unavailable, archiveConversation: unavailable, deleteConversation: unavailable, setNotificationMode: unavailable, setReadReceipts: unavailable, requestNotifications: unavailable, retry: unavailable, sync: unavailable, sendEvent: unavailable, refresh: unavailable,
  getAttachmentChunks: () => [],
} satisfies MessagingContextValue

export function MessagingProvider({ children }: { children: ReactNode }) {
  const [engine, setEngine] = useState<MessagingEngine | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    let generation = 0
    let active: MessagingEngine | undefined
    let unsubscribe: (() => void) | undefined
    const stop = () => {
      generation++
      unsubscribe?.(); unsubscribe = undefined
      active?.dispose(); active = undefined
    }
    const start = async () => {
      stop()
      const current = generation
      setReady(false); setError(null)
      try {
        const identity = await loadIdentity()
        if (cancelled || current !== generation) return
        if (!identity) { setEngine(null); setReady(true); return }
        const next = new MessagingEngine(identity)
        active = next
        unsubscribe = next.subscribe(() => { if (!cancelled && current === generation) setRevision(value => value + 1) })
        setEngine(next)
        await next.start()
        if (!cancelled && current === generation) setReady(true)
      } catch (cause) {
        if (!cancelled && current === generation) {
          setError(cause instanceof Error ? cause.message : "Messages could not be loaded."); setReady(true)
        }
      }
    }
    // Stop synchronously before restore changes any data. Keep the account
    // dialog mounted so a failed restore can show its error and be retried.
    const changing = () => { stop(); setReady(false) }
    const changed = () => { void start() }
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== null && !["serotine_identity_v2", "serotine_identity_public_enc", "serotine_identity_private_enc"].includes(event.key)) return
      stop(); setReady(false); setEngine(null)
      void start()
    }
    window.addEventListener("serotine:identity-changing", changing)
    window.addEventListener("serotine:identity-changed", changed)
    window.addEventListener("storage", storageChanged)
    void start()
    return () => {
      cancelled = true; stop()
      window.removeEventListener("serotine:identity-changing", changing)
      window.removeEventListener("serotine:identity-changed", changed)
      window.removeEventListener("storage", storageChanged)
    }
  }, [])
  const value = useMemo<MessagingContextValue>(() => engine ? {
    identity: engine.identity, contacts: engine.contacts, ready, error: error ?? engine.error, status: engine.status, preferences: engine.preferences, ...engine.model,
    sendText: engine.sendText, editMessage: engine.editMessage, pinMessage: engine.pinMessage, createPoll: engine.createPoll, vote: engine.vote, createGroup: engine.createGroup,
    updateGroup: engine.updateGroup, leaveGroup: engine.leaveGroup, acceptRequest: engine.acceptRequest, blockContact: engine.blockContact, markRead: engine.markRead,
    archiveConversation: engine.archiveConversation, deleteConversation: engine.deleteConversation,
    setNotificationMode: engine.setNotificationMode, setReadReceipts: engine.setReadReceipts, requestNotifications: engine.requestNotifications, retry: engine.retry, sync: engine.sync,
    sendEvent: engine.sendEvent, getAttachmentChunks: engine.getAttachmentChunks, refresh: engine.refresh,
  } : { ...empty, ready, error }, [engine, ready, error, revision])
  return <MessagingContext.Provider value={value}>{children}</MessagingContext.Provider>
}
export function useMessaging(): MessagingContextValue {
  const value = useContext(MessagingContext)
  if (!value) throw new Error("useMessaging must be used within MessagingProvider.")
  return value
}
