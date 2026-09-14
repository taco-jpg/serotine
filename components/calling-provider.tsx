"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react"
import { CallEngine } from "@/lib/call-engine"
import { CallRoomEngine } from "@/lib/call-room-engine"
import type { CallRoomController, CallRoomSnapshot } from "@/lib/call-room-types"
import type { CommunityRecord } from "@/lib/community-types"
import { currentCallRoomTarget, latestCallRoomProof } from "@/lib/call-room-access"
import { CallRoomGovernance } from "@/lib/call-room-governance"
import type { CallController, CallSettings, CallSnapshot, CompletedCall } from "@/lib/call-types"
import type { MessagingContextValue } from "@/lib/messaging-types"
import { shortAddress } from "@/lib/identity"
import { saveCallHistory } from "@/lib/messaging-store"
import { CallingSurface } from "@/components/calling/calling-surface"
import { RoomCallingSurface } from "@/components/calling/room-calling-surface"
import styles from "@/components/calling/calling-layout.module.css"

type CallingContextValue = {
  engine: CallController | null
  snapshot: CallSnapshot | null
  roomEngine: CallRoomController | null
  roomSnapshot: CallRoomSnapshot | null
  error: string | null
  run: (action: () => void | Promise<void>) => Promise<void>
  clearError: () => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
}
const CallingContext = createContext<CallingContextValue | null>(null)
const noSnapshot = () => null
const noSubscription = () => () => undefined

function loadSettings(owner: string): Partial<CallSettings> {
  try {
    const saved = JSON.parse(localStorage.getItem(`serotine_call_settings:${owner}`) || "{}")
    return { silenceIncoming: saved.silenceIncoming === true }
  } catch { return { silenceIncoming: false } }
}

export function CallingProvider({ messaging, communities, children, onCompleted }: { messaging: MessagingContextValue; communities: CommunityRecord[]; children: ReactNode; onCompleted?: (call: CompletedCall) => void | Promise<void> }) {
  const current = useRef(messaging)
  const currentCommunities = useRef(communities)
  const completed = useRef(onCompleted)
  current.current = messaging
  currentCommunities.current = communities
  completed.current = onCompleted
  const [engine, setEngine] = useState<CallController | null>(null)
  const [roomEngine, setRoomEngine] = useState<CallRoomController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [barHeight, setBarHeight] = useState(0)
  const bar = useRef<HTMLDivElement>(null)
  const governance = useRef<CallRoomGovernance | null>(null)
  const owner = messaging.identity?.publicKey

  useEffect(() => {
    const identity = current.current.identity
    if (!identity || !messaging.ready) { setEngine(null); setRoomEngine(null); return }
    let alive = true
    const saveSettings = (settings: CallSettings) => {
      try { localStorage.setItem(`serotine_call_settings:${identity.publicKey}`, JSON.stringify(settings)) }
      catch { if (alive) setError("Call preferences could not be saved. They apply until you leave this page.") }
    }
    const next: CallEngine = new CallEngine({
      identity,
      settings: loadSettings(identity.publicKey),
      isBusy: () => !!room && !["idle", "ended", "failed"].includes(room.getSnapshot().phase),
      getPeers: () => [...new Set([...current.current.contacts.map(contact => contact.pub), ...current.current.preferences.accepted])].filter(peer => peer !== identity.publicKey && !peer.startsWith("group:")),
      getPeerPolicy(peer) {
        const state = current.current
        const conversation = state.conversations.find(item => item.id === peer)
        const contact = state.contacts.find(item => item.pub === peer)
        return {
          accepted: peer !== identity.publicKey && !peer.startsWith("group:") && !!(contact || state.preferences.accepted.includes(peer)),
          blocked: state.preferences.blocked.includes(peer) || conversation?.blocked,
          archived: state.preferences.archived.includes(peer) || conversation?.archived,
          muted: (state.preferences.notifications[peer] || "all") !== "all",
          private: state.getPrivateMode(peer) > 0,
          label: contact?.alias || conversation?.name || shortAddress(peer),
        }
      },
      async onCompleted(call) {
        try {
          await saveCallHistory(identity.publicKey, call)
          await completed.current?.(call)
        } catch { if (alive) setError("The call finished, but its history could not be saved on this device.") }
      },
      onSettingsChange(settings) {
        saveSettings(settings)
        if (room && room.getSnapshot().settings.silenceIncoming !== settings.silenceIncoming) room.updateSettings(settings)
      },
    })
    const room: CallRoomEngine = new CallRoomEngine({
      identity,
      settings: loadSettings(identity.publicKey),
      isBusy: () => !["idle", "ended", "declined", "unanswered", "busy", "failed"].includes(next.getSnapshot().phase),
      getTarget: target => currentCallRoomTarget(target, current.current, currentCommunities.current),
      getPeerLabel: peer => current.current.contacts.find(contact => contact.pub === peer)?.alias || shortAddress(peer),
      onSettingsChange(settings) {
        saveSettings(settings)
        if (next.getSnapshot().settings.silenceIncoming !== settings.silenceIncoming) next.updateSettings(settings)
      },
    })
    const roomGovernance = new CallRoomGovernance({ identity,
      getTarget: target => latestCallRoomProof(target, current.current, currentCommunities.current) })
    governance.current = roomGovernance
    // Remember the successful join synchronously, before a membership update
    // can stop media or React can batch away the joined snapshot.
    const observeRoom = room.subscribe(() => {
      const state = room.getSnapshot()
      if (state.phase === "joined" && state.target) roomGovernance.observeJoined(state.target)
    })
    setEngine(next); setRoomEngine(room); setError(null)
    void next.start().catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "Calling could not connect. Your messages are still available.") })
    const stop = () => { observeRoom(); roomGovernance.dispose(); if (governance.current === roomGovernance) governance.current = null; next.dispose(); room.dispose() }
    const settingsChanged = (event: StorageEvent) => {
      if (event.key === `serotine_call_settings:${identity.publicKey}`) {
        const settings = loadSettings(identity.publicKey)
        next.updateSettings(settings); room?.updateSettings(settings)
      }
    }
    window.addEventListener("serotine:identity-changing", stop)
    window.addEventListener("storage", settingsChanged)
    return () => { alive = false; stop(); window.removeEventListener("serotine:identity-changing", stop); window.removeEventListener("storage", settingsChanged) }
  }, [owner, messaging.ready])

  const snapshot = useSyncExternalStore(engine?.subscribe ?? noSubscription, engine?.getSnapshot ?? noSnapshot, engine?.getServerSnapshot ?? noSnapshot)
  const roomSnapshot = useSyncExternalStore(roomEngine?.subscribe ?? noSubscription, roomEngine?.getSnapshot ?? noSnapshot, roomEngine?.getServerSnapshot ?? noSnapshot)
  const run = useCallback(async (action: () => void | Promise<void>) => {
    setError(null)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That call action could not finish. Try again.") }
  }, [])
  const clearError = useCallback(() => setError(null), [])
  useEffect(() => { governance.current?.refresh() }, [messaging, communities])
  useEffect(() => {
    const node = bar.current
    if (!node) return
    const measure = () => setBarHeight(Math.ceil(node.getBoundingClientRect().height))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    const peer = snapshot?.peer
    if (!engine || !peer || !snapshot || ["idle", "ended", "declined", "unanswered", "busy", "failed"].includes(snapshot.phase)) return
    const accepted = messaging.contacts.some(contact => contact.pub === peer) || messaging.preferences.accepted.includes(peer)
    if (!accepted || messaging.preferences.blocked.includes(peer)) void run(() => engine.end())
  }, [engine, snapshot?.peer, snapshot?.phase, messaging.contacts, messaging.preferences.accepted, messaging.preferences.blocked, run])
  useEffect(() => {
    const target = roomSnapshot?.target
    if (!roomEngine || !target || !roomSnapshot || ["idle", "ended", "failed"].includes(roomSnapshot.phase)) return
    if (!currentCallRoomTarget(target, messaging, communities)) void run(() => roomEngine.leave())
  }, [roomEngine, roomSnapshot?.target, roomSnapshot?.phase, messaging, communities, run])
  useEffect(() => {
    const directActive = !!snapshot && !["idle", "ended", "declined", "unanswered", "busy", "failed"].includes(snapshot.phase)
    const roomActive = !!roomSnapshot && !["idle", "ended", "failed"].includes(roomSnapshot.phase)
    if (directActive && roomSnapshot?.phase !== "idle") roomEngine?.dismiss()
    if (roomActive && snapshot?.phase !== "idle") engine?.dismiss()
  }, [engine, roomEngine, snapshot?.phase, roomSnapshot?.phase])
  const value = useMemo(() => ({ engine, snapshot, roomEngine, roomSnapshot, error, run, clearError, settingsOpen, setSettingsOpen }), [engine, snapshot, roomEngine, roomSnapshot, error, run, clearError, settingsOpen])
  return <CallingContext.Provider value={value}>
    <div style={{ "--call-bar-height": `${barHeight}px` } as CSSProperties} className={styles.layout}>
      <div ref={bar} className="relative z-40"><CallingSurface /><RoomCallingSurface /></div>
      {children}
    </div>
  </CallingContext.Provider>
}

export function useCalling(): CallingContextValue {
  const context = useContext(CallingContext)
  if (!context) throw new Error("useCalling must be used within CallingProvider.")
  return context
}
