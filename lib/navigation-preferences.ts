import { conversationHref, parseConversationAddress } from "./conversation-route"
import { isCommunityId } from "./community-protocol"
import { ID_PATTERN } from "./protocol"
import type { CommunityRecord } from "./community-types"
import type { ConversationRecord } from "./messaging-types"

export interface NavigationPreferences {
  version: 1
  lastView: { kind: "conversation" | "community"; id: string } | null
  opened: Record<string, number>
  channels: Record<string, string>
}

const CHANGE_EVENT = "serotine:navigation-preferences"
const storageKey = (owner: string) => `serotine_navigation:${owner}`
const emptyPreferences = (): NavigationPreferences => ({ version: 1, lastView: null, opened: {}, channels: {} })
const validId = (id: string) => parseConversationAddress(id) === id || isCommunityId(id)
const sessionFallback = new Map<string, string>()

export function parseNavigationPreferences(raw: string): NavigationPreferences {
  const result = emptyPreferences()
  try {
    const value = JSON.parse(raw)
    if (!value || value.version !== 1) return result
    for (const [id, timestamp] of Object.entries(value.opened || {}).slice(0, 500)) {
      if (validId(id) && typeof timestamp === "number" && Number.isSafeInteger(timestamp) && timestamp > 0) result.opened[id] = timestamp
    }
    for (const [id, channel] of Object.entries(value.channels || {}).slice(0, 500)) {
      if (isCommunityId(id) && typeof channel === "string" && ID_PATTERN.test(channel)) result.channels[id] = channel
    }
    const last = value.lastView
    if (last && typeof last.id === "string" && (last.kind === "conversation" ? parseConversationAddress(last.id) === last.id : last.kind === "community" && isCommunityId(last.id))) result.lastView = { kind: last.kind, id: last.id }
  } catch { /* A damaged browser preference must not block the inbox. */ }
  return result
}

export function navigationSnapshot(owner: string): string {
  if (!owner || typeof window === "undefined") return ""
  const key = storageKey(owner)
  if (sessionFallback.has(key)) return sessionFallback.get(key)!
  try { return window.localStorage.getItem(key) || "" } catch { return "" }
}

export function loadNavigationPreferences(owner: string): NavigationPreferences {
  return parseNavigationPreferences(navigationSnapshot(owner))
}

/** Visits are local UI preferences; they never change message timestamps or sync to peers. */
export function rememberNavigation(owner: string, view: NonNullable<NavigationPreferences["lastView"]>, channelId?: string, now = Date.now()): void {
  if (!owner || typeof window === "undefined" || !(view.kind === "conversation" ? parseConversationAddress(view.id) === view.id : isCommunityId(view.id))) return
  const value = loadNavigationPreferences(owner)
  const timestamp = Math.max(now, ...Object.values(value.opened).map(time => time + 1))
  value.lastView = view
  value.opened[view.id] = timestamp
  value.opened = Object.fromEntries(Object.entries(value.opened).sort((a, b) => b[1] - a[1]).slice(0, 500))
  if (view.kind === "community" && channelId && ID_PATTERN.test(channelId)) value.channels[view.id] = channelId
  value.channels = Object.fromEntries(Object.entries(value.channels).filter(([id]) => id in value.opened))
  const key = storageKey(owner)
  const raw = JSON.stringify(value)
  try { window.localStorage.setItem(key, raw); sessionFallback.delete(key) }
  catch { sessionFallback.set(key, raw) }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }))
}

export function subscribeNavigation(owner: string, onChange: () => void): () => void {
  if (!owner || typeof window === "undefined") return () => {}
  const key = storageKey(owner)
  const localChange = (event: Event) => { if ((event as CustomEvent<string>).detail === key) onChange() }
  const storageChange = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return
    try { if (event.storageArea && event.storageArea !== window.localStorage) return } catch { return }
    sessionFallback.delete(key)
    onChange()
  }
  window.addEventListener(CHANGE_EVENT, localChange)
  window.addEventListener("storage", storageChange)
  return () => { window.removeEventListener(CHANGE_EVENT, localChange); window.removeEventListener("storage", storageChange) }
}

export function sortByRecentActivity<T extends { id: string; name: string; updatedAt: number }>(items: T[], preferences: NavigationPreferences): T[] {
  return [...items].sort((a, b) => Math.max(b.updatedAt, preferences.opened[b.id] || 0) - Math.max(a.updatedAt, preferences.opened[a.id] || 0) || a.name.localeCompare(b.name))
}

export function restoredChatHref(preferences: NavigationPreferences, conversations: ConversationRecord[], communities: CommunityRecord[], owner: string, archived: string[] = []): string | null {
  const last = preferences.lastView
  if (!last) return null
  if (last.kind === "conversation") {
    const conversation = conversations.find(item => item.id === last.id)
    return conversation && !conversation.archived && !conversation.blocked && !conversation.request && (conversation.kind !== "group" || conversation.members.includes(owner)) ? conversationHref(last.id) : null
  }
  return !archived.includes(last.id) && communities.some(item => item.id === last.id && item.joined && !item.deleted) ? "/chat/communities" : null
}

export function preferredCommunity(communities: CommunityRecord[], preferences: NavigationPreferences, id?: string | null): CommunityRecord | undefined {
  const available = communities.filter(item => item.joined && !item.deleted)
  const lastOpened = [...available].filter(item => preferences.opened[item.id]).sort((a, b) => preferences.opened[b.id] - preferences.opened[a.id])[0]
  return available.find(item => item.id === id) || (preferences.lastView?.kind === "community" ? available.find(item => item.id === preferences.lastView?.id) : undefined) || lastOpened || sortByRecentActivity(available, preferences)[0]
}
