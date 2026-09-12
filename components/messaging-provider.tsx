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
  acceptRequest: unavailable, blockContact: unavailable, markRead: unavailable, setNotificationMode: unavailable, setReadReceipts: unavailable, requestNotifications: unavailable, retry: unavailable, sync: unavailable, sendEvent: unavailable, refresh: unavailable,
  getAttachmentChunks: () => [],
} satisfies MessagingContextValue

export function MessagingProvider({ children }: { children: ReactNode }) {
  const [engine, setEngine] = useState<MessagingEngine | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    let active: MessagingEngine | undefined
    let unsubscribe: (() => void) | undefined
    void (async () => {
      try {
        const identity = await loadIdentity()
        if (cancelled) return
        if (!identity) { setReady(true); return }
        active = new MessagingEngine(identity)
        unsubscribe = active.subscribe(() => { if (!cancelled) setRevision(value => value + 1) })
        setEngine(active)
        await active.start()
        if (!cancelled) setReady(true)
      } catch (cause) { if (!cancelled) { setError(cause instanceof Error ? cause.message : "Messages could not be loaded."); setReady(true) } }
    })()
    return () => { cancelled = true; unsubscribe?.(); active?.dispose() }
  }, [])
  const value = useMemo<MessagingContextValue>(() => engine ? {
    identity: engine.identity, contacts: engine.contacts, ready, error: error ?? engine.error, status: engine.status, preferences: engine.preferences, ...engine.model,
    sendText: engine.sendText, editMessage: engine.editMessage, pinMessage: engine.pinMessage, createPoll: engine.createPoll, vote: engine.vote, createGroup: engine.createGroup,
    updateGroup: engine.updateGroup, leaveGroup: engine.leaveGroup, acceptRequest: engine.acceptRequest, blockContact: engine.blockContact, markRead: engine.markRead,
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
