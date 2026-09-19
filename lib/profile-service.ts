import type { MessagingEvent, StoredEvent } from "./messaging-types"
import { verifyProfileMedia } from "./profile-media"
import { freshProfileGrant, loadProfileState, newerProfile, PROFILE_CHUNK, PROFILE_MAX_TRANSFER, profileCacheKey, profileStorageKey, selectProfileFields, validProfileFields, validProfileState, validProfileValues, validProfileVersion, type ProfileField, type ProfileState, type ProfileValues, type ProfileWire, type ReceivedProfile } from "./profiles"

type Host = { relationshipBoundary?: (peer: string) => number; canSend?: (peer: string) => boolean; owner: string; trusted: (peer: string) => boolean; peers: () => string[]; send: (peer: string, wire: ProfileWire) => Promise<unknown>; changed: () => void; assertActive: () => void }
type Transfer = { header: Extract<ProfileWire, { type: "data" | "sync" }>; parts: Map<number, string>; at: number }
/** All remote optional fields arrive through signed, recipient-encrypted events.
 * Requests establish exact-version support and a fresh receiver-owned token.
 * No media endpoint or shared reusable image key exists. */
export class ProfileService {
  state: ProfileState
  private cache: Record<string, ReceivedProfile> = {}
  // Evicted versions must not reappear from an older disk snapshot after quota failure.
  private cacheMinimumRevision = 0
  private requests = new Map<string, { token: string; at: number }>()
  private audiences = new Map<string, Array<{ token: string; at: number }>>()
  private transfers = new Map<string, Transfer>()
  private seen = new Set<string>()
  private pending: Array<{ peer: string; wire: ProfileWire }> = []
  private flushing = false
  private suppressedPeers = new Set<string>()
  private lastSave = 0
  private storageListener = (event: StorageEvent) => {
    if (event.key !== null && event.key !== profileStorageKey(this.host.owner) && event.key !== profileCacheKey(this.host.owner)) return
    const revision = this.state.revision, device = this.state.device
    this.reload()
    if (revision !== this.state.revision || device !== this.state.device) this.queueAudienceUpdates()
    this.host.changed()
  }
  constructor(private host: Host) {
    this.state = loadProfileState(host.owner)
    this.expireGrants()
    this.loadCache()
    if (typeof window !== "undefined") window.addEventListener("storage", this.storageListener)
  }
  dispose() { if (typeof window !== "undefined") window.removeEventListener("storage", this.storageListener); this.requests.clear(); this.audiences.clear(); this.transfers.clear(); this.pending = [] }
  reload() {
    let latest: ProfileState | undefined
    try {
      const text = localStorage.getItem(profileStorageKey(this.host.owner))
      if (text && text.length <= PROFILE_MAX_TRANSFER) {
        const parsed: unknown = JSON.parse(text)
        if (validProfileState(parsed)) latest = parsed
      }
    } catch { /* Missing or unreadable authority is handled below, never reused. */ }
    if (latest) {
      const newerValues = newerProfile(latest.valuesVersion, this.state.valuesVersion)
      const changedGrants = Object.keys(latest.grantVersions).filter(peer => newerProfile(latest!.grantVersions[peer], this.state.grantVersions[peer]))
      const grants = { ...this.state.grants }, grantVersions = { ...this.state.grantVersions }, grantConfirmedAt = { ...this.state.grantConfirmedAt }
      for (const peer of changedGrants) { grants[peer] = latest.grants[peer] || []; grantVersions[peer] = latest.grantVersions[peer]; delete grantConfirmedAt[peer]; if (latest.grantConfirmedAt?.[peer]) grantConfirmedAt[peer] = latest.grantConfirmedAt[peer] }
      const storageNewer = newerProfile(latest, this.state)
      const mergingOlderSnapshot = !storageNewer && (newerValues || changedGrants.length > 0)
      const version = storageNewer ? latest : mergingOlderSnapshot
        ? { revision: Math.max(Date.now() * 1000, this.state.revision + 1, latest.valuesVersion.revision + 1, ...Object.values(grantVersions).map(item => item.revision + 1)), device: crypto.randomUUID() } : this.state
      this.state = { ...this.state, revision: version.revision, device: version.device,
        values: newerValues ? latest.values : this.state.values, valuesVersion: newerValues ? latest.valuesVersion : this.state.valuesVersion, grants, grantVersions, grantConfirmedAt }
      if (mergingOlderSnapshot) {
        // The field merge changes send authority even when its envelope is older.
        try { localStorage.setItem(profileStorageKey(this.host.owner), JSON.stringify(this.state)) } catch { /* Keep the newer in-memory fence. */ }
      }
    } else if (this.state.revision > 1 && (Object.values(this.state.grants).some(fields => fields.length)
      || this.audiences.size || this.pending.some(item => item.wire.type === "data" || item.wire.type === "sync"))) {
      const sharedPeers = Object.keys(this.state.grants).filter(peer => this.state.grants[peer].length)
      const version = { revision: Math.max(Date.now() * 1000, this.state.revision + 1, this.state.valuesVersion.revision + 1, ...Object.values(this.state.grantVersions).map(item => item.revision + 1)), device: crypto.randomUUID() }
      const grants = Object.fromEntries(Object.keys(this.state.grants).map(peer => [peer, []]))
      const grantVersions = Object.fromEntries(Object.keys(this.state.grantVersions).map(peer => [peer, version]))
      this.state = { ...this.state, ...version, grants, grantVersions }
      this.audiences.clear(); this.requests.clear(); this.transfers.clear()
      this.pending = this.pending.filter(item => item.wire.type === "revoke")
      for (const peer of sharedPeers) this.pending.push({ peer, wire: { version: 1, type: "revoke", ...version } })
      try {
        localStorage.setItem(profileStorageKey(this.host.owner), JSON.stringify(this.state))
        this.queueSync()
      } catch { /* In-memory revocations and invalidated queues remain effective. */ }
      this.host.changed()
    }
    this.expireGrants()
    this.loadCache()
  }
  private expireGrants() {
    const expired = Object.keys(this.state.grants).filter(peer => this.state.grants[peer].length && (!freshProfileGrant(this.state, peer) || (this.state.grantConfirmedAt?.[peer] ?? 0) <= (this.host.relationshipBoundary?.(peer) ?? 0)))
    if (!expired.length) return
    const version = { revision: Math.max(Date.now() * 1000, this.state.revision + 1, this.state.valuesVersion.revision + 1, ...Object.values(this.state.grantVersions).map(item => item.revision + 1)), device: crypto.randomUUID() }
    const grants = { ...this.state.grants }, grantVersions = { ...this.state.grantVersions }
    for (const peer of expired) { grants[peer] = []; grantVersions[peer] = version }
    this.state = { ...this.state, ...version, grants, grantVersions }
    try { localStorage.setItem(profileStorageKey(this.host.owner), JSON.stringify(this.state)) } catch { /* Expiry still revokes in memory and cancels queued old snapshots. */ }
    for (const peer of expired) this.pending.push({ peer, wire: { version: 1, type: "revoke", ...version } })
    this.queueSync(); this.queueAudienceUpdates(); this.host.changed()
  }
  private loadCache() {
    try {
      const text = localStorage.getItem(profileCacheKey(this.host.owner))
      if (!text || text.length > 2_000_000) return
      const values: unknown = JSON.parse(text)
      if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 200) return
      for (const [peer, value] of Object.entries(values)) {
        if (!this.host.trusted(peer) || !value || typeof value !== "object") continue
        const entry = value as ReceivedProfile
        if ((entry.sentAt !== undefined && (!Number.isSafeInteger(entry.sentAt) || entry.sentAt < 0 || entry.sentAt > Date.now() + 60000)) || !validProfileVersion(entry) || entry.revision < this.cacheMinimumRevision || !validProfileValues(entry.values)
          || !Number.isSafeInteger(entry.receivedAt) || entry.receivedAt < 0 || entry.receivedAt > Date.now() + 60000) continue
        // A stale tab or failed write cannot replace a newer in-memory revoke.
        if (newerProfile(entry, this.cache[peer]) && (this.cache[peer] || Object.keys(this.cache).length < 200)) this.cache[peer] = entry
      }
    } catch { /* Preserve known versions and revocations when storage fails. */ }
  }
  getProfile = (peer: string): ProfileValues => peer === this.host.owner ? this.state.values : this.host.trusted(peer) ? (!(this.host.relationshipBoundary?.(peer) ?? 0) || (this.cache[peer]?.sentAt ?? 0) > (this.host.relationshipBoundary?.(peer) ?? 0) ? this.cache[peer]?.values ?? {} : {}) : {}
  getSharing = (peer: string): ProfileField[] => freshProfileGrant(this.state, peer) && (this.state.grantConfirmedAt?.[peer] ?? 0) > (this.host.relationshipBoundary?.(peer) ?? 0) ? [...(this.state.grants[peer] ?? [])] : []
  private write(state: ProfileState) { localStorage.setItem(profileStorageKey(this.host.owner), JSON.stringify(state)); this.state = state; this.host.changed() }
  private persistCache() {
    this.loadCache()
    // Cache eviction never grants access. Keep revocation version tombstones.
    const entries = Object.entries(this.cache).sort(([, a], [, b]) => Number(!!Object.keys(a.values).length) - Number(!!Object.keys(b.values).length) || b.receivedAt - a.receivedAt)
    for (const [peer, value] of entries.slice(200)) {
      this.cacheMinimumRevision = Math.max(this.cacheMinimumRevision, value.revision + 1)
      this.requests.delete(peer)
      for (const [key, transfer] of this.transfers) if (key.startsWith(`${peer}:`) && transfer.header.type === "data") this.transfers.delete(key)
    }
    this.cache = Object.fromEntries(entries.slice(0, 200))
    let text = JSON.stringify(this.cache)
    for (const [peer, value] of Object.entries(this.cache).sort(([, a], [, b]) => a.receivedAt - b.receivedAt)) {
      if (text.length <= 2_000_000) break
      this.cache[peer] = { ...value, values: {} }; text = JSON.stringify(this.cache)
    }
    try { localStorage.setItem(profileCacheKey(this.host.owner), text) } catch { /* In-memory authorized rendering still works when the cache is full. */ }
    this.host.changed()
  }
  private nextState(): ProfileState {
    this.reload()
    return { ...this.state, revision: Math.max(Date.now() * 1000, this.state.revision + 1, this.state.valuesVersion.revision + 1, ...Object.values(this.state.grantVersions).map(version => version.revision + 1)), device: crypto.randomUUID() }
  }
  private async verify(values: ProfileValues) {
    if (!validProfileValues(values)) throw new Error("The profile contains unsupported or oversized fields.")
    if (values.avatar) await verifyProfileMedia(values.avatar)
    if (values.banner) await verifyProfileMedia(values.banner)
  }
  saveProfile = async (values: ProfileValues) => {
    this.host.assertActive()
    if (Date.now() - this.lastSave < 1500) throw new Error("Wait a moment before saving another profile update.")
    await this.verify(values); this.host.assertActive()
    const state = this.nextState(); this.write({ ...state, values: structuredClone(values), valuesVersion: { revision: state.revision, device: state.device } }); this.lastSave = Date.now()
    this.queueSync(); this.queueAudienceUpdates(); await this.flush()
  }
  setSharing = async (peer: string, fields: ProfileField[]) => {
    this.host.assertActive()
    if (!validProfileFields(fields) || peer === this.host.owner || !this.host.peers().includes(peer)) throw new Error("Add or accept this friend before choosing profile sharing.")
    const state = this.nextState()
    if (!fields.length && !state.grants[peer]?.length) { this.request(peer); await this.flush(); return }
    const grants = { ...state.grants, [peer]: [...fields] }
    if (Object.keys(grants).length > 100) throw new Error("Profile sharing supports up to 100 selected friends.")
    this.write({ ...state, grants, grantVersions: { ...state.grantVersions, [peer]: { revision: state.revision, device: state.device } }, grantConfirmedAt: { ...state.grantConfirmedAt, [peer]: Date.now() } })
    // A revocation fence travels before a narrowed replacement snapshot.
    this.pending.push({ peer, wire: { version: 1, type: "revoke", revision: state.revision, device: state.device } })
    this.queueSync(); this.queueAudienceUpdates(peer); this.request(peer); await this.flush()
  }
  revoke = async (peer: string) => {
    this.host.assertActive()
    if (!this.state.grantVersions[peer] && !this.cache[peer] && !this.audiences.has(peer) && !this.requests.has(peer)) return
    const state = this.nextState(), grants = { ...state.grants, [peer]: [] }
    this.write({ ...state, grants, grantVersions: { ...state.grantVersions, [peer]: { revision: state.revision, device: state.device } } }); delete this.cache[peer]; this.persistCache()
    this.requests.delete(peer); this.audiences.delete(peer)
    this.pending = this.pending.filter(item => item.peer !== peer)
    this.pending.push({ peer, wire: { version: 1, type: "revoke", revision: state.revision, device: state.device } })
    this.queueSync(); await this.flush()
  }
  request(peer: string, force = false) {
    if (!this.host.trusted(peer) || peer === this.host.owner || this.host.canSend?.(peer) === false) return
    const prior = this.requests.get(peer)
    if (!force && prior && prior.at > (this.host.relationshipBoundary?.(peer) ?? 0) && Date.now() - prior.at < 10 * 60000) return
    const token = crypto.randomUUID(); this.requests.set(peer, { token, at: Date.now() })
    this.pending.push({ peer, wire: { version: 1, type: "request", token } })
  }
  private queueChunks(peer: string, type: "data" | "sync", token: string, value: unknown) {
    const text = JSON.stringify(value)
    if (text.length > PROFILE_MAX_TRANSFER) throw new Error("This profile is too large. Choose smaller images.")
    const transfer = crypto.randomUUID(), total = Math.ceil(text.length / PROFILE_CHUNK)
    for (let index = 0; index < total; index++) this.pending.push({ peer, wire: { version: 1, type, token, transfer, index, total, revision: this.state.revision, device: this.state.device, data: text.slice(index * PROFILE_CHUNK, (index + 1) * PROFILE_CHUNK) } })
  }
  private queueSync() { this.queueChunks(this.host.owner, "sync", crypto.randomUUID(), this.state) }
  private queueAudienceUpdates(only?: string) {
    for (const [peer, audiences] of this.audiences) {
      if ((only && peer !== only) || !this.host.trusted(peer) || this.host.canSend?.(peer) === false) continue
      for (const audience of audiences) if (audience.at > (this.host.relationshipBoundary?.(peer) ?? 0) && Date.now() - audience.at <= 24 * 3600000) this.queueChunks(peer, "data", audience.token, selectProfileFields(this.state.values, this.getSharing(peer)))
    }
  }
  canDeliver(peer: string, wire: ProfileWire) {
    this.reload()
    if (this.host.canSend?.(peer) === false) return false
    if (wire.type === "revoke") return true
    if (wire.type === "sync") return peer === this.host.owner && wire.revision === this.state.revision && wire.device === this.state.device
    if (!this.host.trusted(peer)) return false
    if (wire.type === "request") return this.requests.get(peer)?.token === wire.token
    return wire.revision === this.state.revision && wire.device === this.state.device && this.audiences.get(peer)?.some(audience => audience.token === wire.token && audience.at > (this.host.relationshipBoundary?.(peer) ?? 0)) === true
  }
  async observe(records: readonly StoredEvent[]) {
    for (const record of records) {
      const event = record.event
      if (event.kind !== "profile" || record.legacy || this.seen.has(record.key)) continue
      this.seen.add(record.key)
      await this.receive(event)
    }
    for (const [key, transfer] of this.transfers) if (Date.now() - transfer.at > 60000) this.transfers.delete(key)
  }
  private async receive(event: MessagingEvent) {
    const wire = event.payload.profile!, peer = event.author
    if (wire.type === "sync") {
      if (peer !== this.host.owner || event.conversationId !== this.host.owner ) return
    } else {
      if (peer === this.host.owner || event.conversationId !== this.host.owner) return
      if (wire.type === "revoke") {
        if (!this.host.trusted(peer) && !this.cache[peer] && !this.requests.has(peer)) return
        const prior = this.cache[peer]
        if (newerProfile(wire, prior)) { this.cache[peer] = { revision: wire.revision, device: wire.device, values: {}, receivedAt: Date.now() }; this.persistCache() }
        return
      }
      if (!this.host.trusted(peer)) return
      if (wire.type === "request") {
        if (event.timestamp < Date.now() - 60000 || event.timestamp <= (this.host.relationshipBoundary?.(peer) ?? 0)) return
        const firstContact = !this.audiences.has(peer)
        this.audiences.set(peer, [...(this.audiences.get(peer) || []).filter(audience => audience.token !== wire.token && Date.now() - audience.at <= 24 * 3600000).slice(-3), { token: wire.token, at: Date.now() }]); this.queueAudienceUpdates(peer); this.request(peer, firstContact); return
      }
      if ((this.requests.get(peer)?.at ?? 0) <= (this.host.relationshipBoundary?.(peer) ?? 0) || (this.host.relationshipBoundary?.(peer) ?? 0) > 0 && (!Number.isSafeInteger(event.timestamp) || event.timestamp <= (this.host.relationshipBoundary?.(peer) ?? 0)) || this.requests.get(peer)?.token !== wire.token || (!newerProfile(wire, this.cache[peer]) && (wire.revision !== this.cache[peer]?.revision || wire.device !== this.cache[peer]?.device))) return
    }
    const key = `${peer}:${wire.transfer}`
    let transfer = this.transfers.get(key)
    if (!transfer) {
      if (this.transfers.size >= 12) return
      transfer = { header: wire, parts: new Map(), at: Date.now() }; this.transfers.set(key, transfer)
    }
    const header = transfer.header
    if (header.token !== wire.token || header.total !== wire.total || header.revision !== wire.revision || header.device !== wire.device || header.type !== wire.type) return
    if (transfer.parts.has(wire.index) && transfer.parts.get(wire.index) !== wire.data) { this.transfers.delete(key); return }
    transfer.parts.set(wire.index, wire.data)
    if (transfer.parts.size !== wire.total) return
    this.transfers.delete(key)
    try {
      const text = Array.from({ length: wire.total }, (_, index) => transfer!.parts.get(index)!).join("")
      if (text.length > PROFILE_MAX_TRANSFER) return
      const decoded: unknown = JSON.parse(text)
      if (wire.type === "sync") {
        if (!validProfileState(decoded) || decoded.revision !== wire.revision || decoded.device !== wire.device) return
        await this.verify(decoded.values); this.host.assertActive()
        const merged = this.nextState()
        const newerValues = newerProfile(decoded.valuesVersion, merged.valuesVersion)
        const changedGrants = Object.keys(decoded.grantVersions).filter(friend => newerProfile(decoded.grantVersions[friend], merged.grantVersions[friend]))
        if (!newerValues && !changedGrants.length) return
        const grants = { ...merged.grants }, grantVersions = { ...merged.grantVersions }, grantConfirmedAt = { ...merged.grantConfirmedAt }
        for (const friend of changedGrants) { grants[friend] = decoded.grants[friend] || []; grantVersions[friend] = decoded.grantVersions[friend]; delete grantConfirmedAt[friend]; if (decoded.grantConfirmedAt?.[friend]) grantConfirmedAt[friend] = decoded.grantConfirmedAt[friend] }
        this.write({ ...merged, values: newerValues ? decoded.values : merged.values, valuesVersion: newerValues ? decoded.valuesVersion : merged.valuesVersion, grants, grantVersions, grantConfirmedAt })
        this.expireGrants(); this.queueAudienceUpdates()
      } else {
        if (!validProfileValues(decoded)) return
        await this.verify(decoded); this.host.assertActive()
        if (!this.host.trusted(peer) || (this.requests.get(peer)?.at ?? 0) <= (this.host.relationshipBoundary?.(peer) ?? 0) || (this.host.relationshipBoundary?.(peer) ?? 0) > 0 && (!Number.isSafeInteger(event.timestamp) || event.timestamp <= (this.host.relationshipBoundary?.(peer) ?? 0)) || this.requests.get(peer)?.token !== wire.token || (this.cache[peer] && newerProfile(this.cache[peer], wire))) return
        this.cache[peer] = { revision: wire.revision, device: wire.device, values: decoded, receivedAt: Date.now(), sentAt: event.timestamp }; this.persistCache()
      }
    } catch { /* Invalid optional profile data never interrupts ordinary messaging. */ }
  }
  async flush() {
    if (this.flushing) return
    this.flushing = true
    try {
      this.reload()
      for (const peer of this.host.peers()) {
        if (this.host.canSend?.(peer) === false) { this.suppressedPeers.add(peer); continue }
        if (this.suppressedPeers.delete(peer)) { this.request(peer, true); this.queueAudienceUpdates(peer) }
        else this.request(peer)
      }
      const deferred: typeof this.pending = [], failed = new Set<string>()
      const batch = this.pending.splice(0)
      for (const item of batch) {
        this.host.assertActive()
        if (this.host.canSend?.(item.peer) === false) {
          this.suppressedPeers.add(item.peer)
          // Rebuild fresh requests/data when the route permits it again. Keep
          // only the latest cleanup fence while an optional route is paused.
          if (item.wire.type === "revoke") {
            const prior = deferred.findIndex(entry => entry.peer === item.peer && entry.wire.type === "revoke")
            if (prior >= 0) deferred.splice(prior, 1)
            deferred.push(item)
          }
          continue
        }
        if (failed.has(item.peer)) { if (this.canDeliver(item.peer, item.wire)) deferred.push(item); continue }
        if (!this.canDeliver(item.peer, item.wire)) continue
        try { await this.host.send(item.peer, item.wire) }
        catch {
          this.host.assertActive()
          // Optional profile failures must never hold up ordinary messaging or
          // another friend's updates. Retry this peer on a later sync pass.
          failed.add(item.peer)
          if (this.canDeliver(item.peer, item.wire) || this.host.canSend?.(item.peer) === false) deferred.push(item)
        }
      }
      this.pending.unshift(...deferred)
    } finally { this.flushing = false }
  }
}
