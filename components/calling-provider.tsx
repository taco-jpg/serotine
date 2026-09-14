"use client"

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react"
import { CallEngine } from "@/lib/call-engine"
import type { CallController, CallSettings, CallSnapshot, CompletedCall } from "@/lib/call-types"
import type { MessagingContextValue } from "@/lib/messaging-types"
import { shortAddress } from "@/lib/identity"
import { saveCallHistory } from "@/lib/messaging-store"
import { CallingSurface } from "@/components/calling/calling-surface"
import styles from "@/components/calling/calling-layout.module.css"

type CallingContextValue = {
  engine: CallController | null
  snapshot: CallSnapshot | null
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
    return { silenceIncoming: saved.silenceIncoming === true, relayOnly: saved.relayOnly !== false }
  } catch { return { silenceIncoming: false, relayOnly: true } }
}

export function CallingProvider({ messaging, children, onCompleted }: { messaging: MessagingContextValue; children: ReactNode; onCompleted?: (call: CompletedCall) => void | Promise<void> }) {
  const current = useRef(messaging)
  const completed = useRef(onCompleted)
  current.current = messaging
  completed.current = onCompleted
  const [engine, setEngine] = useState<CallController | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [barHeight, setBarHeight] = useState(0)
  const bar = useRef<HTMLDivElement>(null)
  const owner = messaging.identity?.publicKey

  useEffect(() => {
    const identity = current.current.identity
    if (!identity || !messaging.ready) { setEngine(null); return }
    let alive = true
    const next = new CallEngine({
      identity,
      settings: loadSettings(identity.publicKey),
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
        try { localStorage.setItem(`serotine_call_settings:${identity.publicKey}`, JSON.stringify(settings)) }
        catch { if (alive) setError("Call preferences could not be saved. They apply until you leave this page.") }
      },
    })
    setEngine(next); setError(null)
    void next.start().catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "Calling could not connect. Your messages are still available.") })
    const stop = () => next.dispose()
    const settingsChanged = (event: StorageEvent) => {
      if (event.key === `serotine_call_settings:${identity.publicKey}`) next.updateSettings(loadSettings(identity.publicKey))
    }
    window.addEventListener("serotine:identity-changing", stop)
    window.addEventListener("storage", settingsChanged)
    return () => { alive = false; next.dispose(); window.removeEventListener("serotine:identity-changing", stop); window.removeEventListener("storage", settingsChanged) }
  }, [owner, messaging.ready])

  const snapshot = useSyncExternalStore(engine?.subscribe ?? noSubscription, engine?.getSnapshot ?? noSnapshot, engine?.getServerSnapshot ?? noSnapshot)
  const run = useCallback(async (action: () => void | Promise<void>) => {
    setError(null)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : "That call action could not finish. Try again.") }
  }, [])
  const clearError = useCallback(() => setError(null), [])
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
  const value = useMemo(() => ({ engine, snapshot, error, run, clearError, settingsOpen, setSettingsOpen }), [engine, snapshot, error, run, clearError, settingsOpen])
  return <CallingContext.Provider value={value}>
    <div style={{ "--call-bar-height": `${barHeight}px` } as CSSProperties} className={styles.layout}>
      <div ref={bar} className="relative z-40"><CallingSurface /></div>
      {children}
    </div>
  </CallingContext.Provider>
}

export function useCalling(): CallingContextValue {
  const context = useContext(CallingContext)
  if (!context) throw new Error("useCalling must be used within CallingProvider.")
  return context
}
