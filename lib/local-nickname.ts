export const MAX_LOCAL_NICKNAME_LENGTH = 60

const CHANGE_EVENT = "serotine:local-nickname"
const storageKey = (owner: string) => `serotine_local_nickname:${owner}`

export function normalizeLocalNickname(nickname: string): string {
  return nickname.replace(/\s+/g, " ").trim().slice(0, MAX_LOCAL_NICKNAME_LENGTH).trimEnd()
}

/** Device-local display preference: deliberately separate from identity, contacts, and backups. */
export function loadLocalNickname(owner: string): string {
  if (!owner || typeof window === "undefined") return ""
  try { return normalizeLocalNickname(window.localStorage.getItem(storageKey(owner)) ?? "") }
  catch { return "" }
}

/** A failed write must not pretend that the nickname was saved. */
export function saveLocalNickname(owner: string, nickname: string): string {
  if (!owner) throw new Error("Your identity is not ready yet.")
  const normalized = normalizeLocalNickname(nickname)
  const key = storageKey(owner)
  try {
    if (typeof window === "undefined") throw new Error("Browser storage unavailable")
    if (normalized) window.localStorage.setItem(key, normalized)
    else window.localStorage.removeItem(key)
  } catch {
    throw new Error("Could not save your private nickname in this browser. Check that browser storage is available and try again.")
  }
  // Notify this tab without including the private value in the event.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }))
  return normalized
}

export function subscribeLocalNickname(owner: string, onChange: () => void): () => void {
  if (!owner || typeof window === "undefined") return () => {}
  const key = storageKey(owner)
  const onLocalChange = (event: Event) => {
    if ((event as CustomEvent<string>).detail === key) onChange()
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== key && event.key !== null) return
    try {
      if (event.storageArea && event.storageArea !== window.localStorage) return
    } catch { return }
    onChange()
  }
  window.addEventListener(CHANGE_EVENT, onLocalChange)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocalChange)
    window.removeEventListener("storage", onStorage)
  }
}
