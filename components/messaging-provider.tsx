"use client"

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { loadIdentity } from "@/lib/identity"
import { MessagingEngine } from "@/lib/messaging"
import { defaultMessagingPreferences } from "@/lib/messaging-store"
import type { CommunityService } from "@/lib/community-service"
import type { CommunityModel } from "@/lib/community-types"
import type { MessagingContextValue } from "@/lib/messaging-types"

type CommunityMethods = Pick<CommunityService, "createCommunity" | "createInvite" | "joinCommunity" | "retryJoinRequest" | "updateCommunity" | "moderate" | "approveRequest" | "rejectRequest" | "leave" | "sendMessage" | "reportMessage" | "hideMessage" | "revokeInvites" | "setCoOwner" | "transferOwnership" | "deleteCommunity">
export type CommunityContextValue = CommunityMethods & Pick<MessagingContextValue, "identity" | "contacts" | "ready" | "error" | "status" | "preferences" | "setNotificationMode" | "sync" | "retry"> & {
  model: CommunityModel
  deliveryIssues: Array<{ id: string; communityId: string; kind: string; error: string }>
  markRead: (communityId: string, channelId: string) => Promise<void>
}
const CommunityContext = createContext<CommunityContextValue | null>(null)
const emptyCommunityModel: CommunityModel = { communities: [], messages: [], requests: [], reports: [], commands: [], processedIds: [] }
const MessagingContext = createContext<MessagingContextValue | null>(null)
const unavailable = async (): Promise<never> => { throw new Error("Your identity is still loading. Try again in a moment.") }
const empty = {
  identity: null, contacts: [], ready: false, error: null, status: "connecting", conversations: [], messages: [], groups: [], requests: [], preferences: defaultMessagingPreferences(),
  sendText: unavailable, sendSecret: unavailable, setPrivateMode: unavailable, destroyPrivateHistory: unavailable, editMessage: unavailable, deleteMessage: unavailable, pinMessage: unavailable, createPoll: unavailable, vote: unavailable, createGroup: unavailable, updateGroup: unavailable, leaveGroup: unavailable,
  acceptRequest: unavailable, blockContact: unavailable, markRead: unavailable, archiveConversation: unavailable, deleteConversation: unavailable, setNotificationMode: unavailable, setReadReceipts: unavailable, requestNotifications: unavailable, retry: unavailable, sync: unavailable, sendEvent: unavailable, refresh: unavailable,
  getAttachmentChunks: () => [],
  getPrivateMode: () => 0,
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
    sendText: engine.sendText, editMessage: engine.editMessage, deleteMessage: engine.deleteMessage, pinMessage: engine.pinMessage, createPoll: engine.createPoll, vote: engine.vote, createGroup: engine.createGroup,
    sendSecret: engine.sendSecret, setPrivateMode: engine.setPrivateMode, destroyPrivateHistory: engine.destroyPrivateHistory,
    getPrivateMode: engine.getPrivateMode,
    updateGroup: engine.updateGroup, leaveGroup: engine.leaveGroup, acceptRequest: engine.acceptRequest, blockContact: engine.blockContact, markRead: engine.markRead,
    archiveConversation: engine.archiveConversation, deleteConversation: engine.deleteConversation,
    setNotificationMode: engine.setNotificationMode, setReadReceipts: engine.setReadReceipts, requestNotifications: engine.requestNotifications, retry: engine.retry, sync: engine.sync,
    sendEvent: engine.sendEvent, getAttachmentChunks: engine.getAttachmentChunks, refresh: engine.refresh,
  } : { ...empty, ready, error }, [engine, ready, error, revision])
  const communityValue = useMemo<CommunityContextValue>(() => ({
    identity: value.identity, contacts: value.contacts, ready, error: value.error, status: value.status, preferences: value.preferences,
    model: engine?.communities.model ?? emptyCommunityModel,
    deliveryIssues: engine?.records.filter(record => record.local && record.event.kind === "community" && record.error && record.event.recipients.some(peer => !record.delivered.includes(peer)))
      .map(record => {
        const data = record.event.payload.community!
        const kind = data.type === "state" && data.state.deleted ? "delete"
          : data.type === "state" && data.state.transfers?.at(-1)?.epoch === data.state.epoch ? "transfer" : data.type
        return { id: record.event.id, communityId: record.event.conversationId, kind, error: record.error! }
      }) ?? [],
    createCommunity: engine?.communities.createCommunity ?? unavailable,
    createInvite: engine?.communities.createInvite ?? unavailable,
    joinCommunity: engine?.communities.joinCommunity ?? unavailable,
    retryJoinRequest: engine?.communities.retryJoinRequest ?? unavailable,
    updateCommunity: engine?.communities.updateCommunity ?? unavailable,
    moderate: engine?.communities.moderate ?? unavailable,
    approveRequest: engine?.communities.approveRequest ?? unavailable,
    rejectRequest: engine?.communities.rejectRequest ?? unavailable,
    leave: engine?.communities.leave ?? unavailable,
    sendMessage: engine?.communities.sendMessage ?? unavailable,
    reportMessage: engine?.communities.reportMessage ?? unavailable,
    hideMessage: engine?.communities.hideMessage ?? unavailable,
    revokeInvites: engine?.communities.revokeInvites ?? unavailable,
    setCoOwner: engine?.communities.setCoOwner ?? unavailable,
    transferOwnership: engine?.communities.transferOwnership ?? unavailable,
    deleteCommunity: engine?.communities.deleteCommunity ?? unavailable,
    markRead: engine?.markCommunityRead ?? unavailable,
    setNotificationMode: value.setNotificationMode, sync: value.sync, retry: value.retry,
  }), [engine, ready, value])
  return <MessagingContext.Provider value={value}><CommunityContext.Provider value={communityValue}>{children}</CommunityContext.Provider></MessagingContext.Provider>
}
export function useMessaging(): MessagingContextValue {
  const value = useContext(MessagingContext)
  if (!value) throw new Error("useMessaging must be used within MessagingProvider.")
  return value
}

export function useCommunities(): CommunityContextValue {
  const value = useContext(CommunityContext)
  if (!value) throw new Error("useCommunities must be used within MessagingProvider.")
  return value
}
