/** First-party extensions only. Manifests never contain executable peer code. */
export const PRIVATE_CHAT_PLUGIN_ID = "serotine.private-chat"
export const AI_SUMMARY_PLUGIN_ID = "serotine.ai-summary"
export type PluginExtension = "conversation-tool" | "composer-action" | "command" | "outgoing-policy"
export interface PluginManifest {
  id: string; version: string; name: string; description: string; shared: boolean
  permissions: Array<{ id: string; label: string; description: string }>
  extensions: PluginExtension[]
  commands?: string[]
}
export interface PluginState { manifest: PluginManifest; installed: boolean; enabled: boolean }
export interface PluginAvailability { available: boolean; reason: string; peerStatus: "local" | "compatible" | "unknown" | "unavailable" }
export const FIRST_PARTY_PLUGINS: readonly PluginManifest[] = [
  { id: PRIVATE_CHAT_PLUGIN_ID, version: "1.0.0", name: "Private Chat", shared: true,
    description: "Expiring direct messages and access keys with a compatible contact.",
    permissions: [
      { id: "private-messages", label: "Private messages", description: "Create expiring messages and change private mode in a direct conversation." },
      { id: "capabilities", label: "Contact compatibility", description: "Exchange signed plugin versions with accepted contacts through the encrypted messenger." },
    ], extensions: ["conversation-tool", "composer-action", "outgoing-policy"] },
  { id: AI_SUMMARY_PLUGIN_ID, version: "1.0.0", name: "AI Summary", shared: false,
    description: "Review a bounded selection of ordinary conversation messages before requesting an AI summary.",
    permissions: [
      { id: "selected-history", label: "Selected message history", description: "Read only the ordinary message text you select and preview for each summary." },
      { id: "ai-provider", label: "AI provider requests", description: "Send the reviewed text to the configured AI provider only after your separate confirmation for each request." },
    ], extensions: ["conversation-tool", "command"], commands: ["/summarize"] },
]
/** Resolve reserved local commands even while disabled, so they cannot leak to a peer. */
export function resolvePluginCommand(text: string): string | undefined {
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase()
  return FIRST_PARTY_PLUGINS.find(manifest => manifest.extensions.includes("command") && manifest.commands?.includes(command))?.id
}
type Installation = { version: string; enabled: boolean; permissions: string[] }
type Installations = Record<string, Installation>

/** Consent belongs to this browser and identity; it is not transported in backups. */
export class PluginRegistry {
  private installations: Installations = {}
  private readonly storageKey: string
  constructor(owner: string) { this.storageKey = `serotine.plugins.v1:${owner}`; this.reload() }
  reload() {
    let value: Installations = {}
    try {
      const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(this.storageKey)
      const parsed: unknown = raw ? JSON.parse(raw) : {}
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Installations
    } catch { /* Missing or malformed consent disables extensions. */ }
    const changed = JSON.stringify(value) !== JSON.stringify(this.installations)
    this.installations = value
    return changed
  }
  get states(): PluginState[] {
    return FIRST_PARTY_PLUGINS.map(manifest => {
      const record = this.installations[manifest.id]
      const installed = record?.version === manifest.version && Array.isArray(record.permissions)
        && manifest.permissions.every(permission => record.permissions.includes(permission.id))
      return { manifest, installed, enabled: installed && record.enabled === true }
    })
  }
  enabled(id: string) { return this.states.some(state => state.manifest.id === id && state.enabled) }
  extensions(point: PluginExtension) { return this.states.filter(state => state.enabled && state.manifest.extensions.includes(point)).map(state => state.manifest) }
  setEnabled(id: string, enabled: boolean, grantPermissions = false) {
    this.reload()
    const state = this.states.find(item => item.manifest.id === id)
    if (!state) throw new Error("This first-party plugin is not available.")
    if (enabled && !state.installed && !grantPermissions) throw new Error("Review and approve this plugin's permissions before enabling it.")
    const next = { ...this.installations }
    if (enabled) next[id] = { version: state.manifest.version, enabled, permissions: state.manifest.permissions.map(permission => permission.id) }
    else if (state.installed) next[id] = { ...next[id], enabled: false }
    this.save(next)
  }
  remove(id: string) {
    this.reload()
    if (!FIRST_PARTY_PLUGINS.some(manifest => manifest.id === id)) throw new Error("This first-party plugin is not available.")
    const next = { ...this.installations }; delete next[id]; this.save(next)
  }
  private save(next: Installations) {
    // Persistence must succeed before permissions become active.
    if (typeof localStorage === "undefined") throw new Error("Plugin settings require browser storage.")
    localStorage.setItem(this.storageKey, JSON.stringify(next))
    this.installations = next
  }
  advertised(): PluginCapability[] { return this.states.filter(state => state.enabled && state.manifest.shared).map(({ manifest }) => ({ id: manifest.id, version: manifest.version })) }
}

export interface PluginCapability { id: string; version: string }
export interface PluginCapabilities {
  protocol: 1; session: string; sequence: number; plugins: PluginCapability[]
  request?: string; responseTo?: string
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export function validPluginCapabilities(value: unknown): value is PluginCapabilities {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const p = value as PluginCapabilities
  return p.protocol === 1 && typeof p.session === "string" && UUID.test(p.session)
    && Number.isSafeInteger(p.sequence) && p.sequence > 0
    && Array.isArray(p.plugins) && p.plugins.length <= 16
    && p.plugins.every(item => item && Object.keys(item).length === 2 && typeof item.id === "string" && /^[a-z][a-z0-9.-]{0,79}$/.test(item.id)
      && typeof item.version === "string" && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(item.version))
    && new Set(p.plugins.map(item => item.id)).size === p.plugins.length
    && (p.request === undefined || (typeof p.request === "string" && UUID.test(p.request)))
    && (p.responseTo === undefined || (typeof p.responseTo === "string" && UUID.test(p.responseTo)))
    && !(p.request && p.responseTo)
    && Object.keys(p).every(key => ["protocol", "session", "sequence", "plugins", "request", "responseTo"].includes(key))
}
export const PLUGIN_COMPATIBILITY_MS = 5 * 60_000
export const PLUGIN_CHALLENGE_MS = 60_000
interface PeerState { session: string; sequence: number; timestamp: number; plugins: PluginCapability[]; confirmedUntil: number }

/** Receives only authenticated advertisements. Fresh nonces fence restored history. */
export class PluginNegotiation {
  readonly session = crypto.randomUUID()
  private sequence = 0
  private peers = new Map<string, PeerState>()
  private pending = new Map<string, { nonce: string; requestedAt: number }>()
  private responded = new Set<string>()
  advertise(plugins: PluginCapability[], extra: Pick<PluginCapabilities, "request" | "responseTo"> = {}): PluginCapabilities {
    return { protocol: 1, session: this.session, sequence: ++this.sequence, plugins, ...extra }
  }
  challenge(peer: string, now = Date.now()): string | undefined {
    const prior = this.pending.get(peer)
    if (prior && now - prior.requestedAt < PLUGIN_CHALLENGE_MS) return undefined
    const nonce = crypto.randomUUID(); this.pending.set(peer, { nonce, requestedAt: now })
    this.peers.delete(peer)
    return nonce
  }
  observe(peer: string, advertisement: PluginCapabilities, timestamp: number, now = Date.now()) {
    const prior = this.peers.get(peer)
    // Sequence orders simultaneous events from a session without clock/UUID ties.
    if (prior && (prior.session === advertisement.session ? advertisement.sequence <= prior.sequence : timestamp < prior.timestamp)) return
    const pending = this.pending.get(peer)
    const confirmed = !!pending && advertisement.responseTo === pending.nonce && now - pending.requestedAt <= PLUGIN_CHALLENGE_MS
      && timestamp >= pending.requestedAt - 60_000 && timestamp <= now + 60_000
    const sameSession = prior?.session === advertisement.session && JSON.stringify(prior.plugins) === JSON.stringify(advertisement.plugins)
    this.peers.set(peer, { session: advertisement.session, sequence: advertisement.sequence, timestamp, plugins: advertisement.plugins,
      confirmedUntil: confirmed ? now + PLUGIN_COMPATIBILITY_MS : sameSession ? prior.confirmedUntil : 0 })
    if (confirmed) this.pending.delete(peer)
  }
  shouldRespond(peer: string, advertisement: PluginCapabilities, timestamp: number, now = Date.now()) {
    if (!advertisement.request || timestamp < now - PLUGIN_CHALLENGE_MS || timestamp > now + 60_000) return false
    const key = `${peer}:${advertisement.session}:${advertisement.request}`
    if (this.responded.has(key)) return false
    if (this.responded.size > 2000) this.responded.clear()
    this.responded.add(key); return true
  }
  availability(peer: string, manifest: PluginManifest, now = Date.now()): PluginAvailability {
    const state = this.peers.get(peer)
    if (!state || state.confirmedUntil <= now) return { available: false, peerStatus: "unknown", reason: "Check compatibility while your contact is online. Both participants must enable Private Chat." }
    const compatible = state.plugins.some(plugin => plugin.id === manifest.id && plugin.version === manifest.version)
    return compatible ? { available: true, peerStatus: "compatible", reason: "Your contact confirmed a compatible Private Chat plugin." }
      : { available: false, peerStatus: "unavailable", reason: "Your contact has not enabled a compatible Private Chat plugin." }
  }
  revoke(peer?: string) { if (peer) { this.peers.delete(peer); this.pending.delete(peer) } else { this.peers.clear(); this.pending.clear() } }
}
