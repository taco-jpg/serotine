const CHANNEL = "serotine-history-v2"
const EVENT = "serotine:history"
interface Change { owner: string; peer: string; source: string }
const source = globalThis.crypto?.randomUUID?.() ?? String(Math.random())

/** Only routing metadata is broadcast; readers load content from IndexedDB. */
export function notifyHistoryChanged(owner: string, peer: string) {
  if (typeof window === "undefined") return
  const change: Change = { owner, peer, source }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: change }))
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(CHANNEL)
      channel.postMessage(change)
      channel.close()
    }
  } catch { /* Focus refresh remains available when cross-tab messaging is blocked. */ }
}

export function subscribeToHistory(owner: string, peer: string, refresh: () => void) {
  const accept = (value: Change | undefined) => { if (value?.owner === owner && value.peer === peer) refresh() }
  const local = (event: Event) => accept((event as CustomEvent<Change>).detail)
  window.addEventListener(EVENT, local)
  let channel: BroadcastChannel | undefined
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL)
      channel.onmessage = event => { if (event.data?.source !== source) accept(event.data) }
    }
  } catch { /* Focus refresh is the fallback. */ }
  return () => { window.removeEventListener(EVENT, local); channel?.close() }
}
