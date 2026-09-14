import type { Identity } from "./identity"
import { callRoomId, type CallRoomTarget } from "./call-room-protocol"
import { createCallRoomTransport, type CallRoomTransport } from "./call-room-transport"

interface Options {
  identity: Identity
  getTarget: (target: CallRoomTarget) => CallRoomTarget | null
}
interface Dependencies {
  transport?: Pick<CallRoomTransport, "status">
  retryDelayMs?: number
  maxScopes?: number
}
interface Entry {
  target: CallRoomTarget
  acknowledged: string
  desired: CallRoomTarget | null
  attempted: string
  attempts: number
  running: boolean
  timer?: ReturnType<typeof setTimeout>
}
const signature = (target: CallRoomTarget) => target.kind === "group" ? target.group.signature : target.community.signature
const scope = (target: CallRoomTarget) => target.kind === "group" ? callRoomId(target) : target.community.id

/** Remember only joined rooms for this unlocked identity session. Governance
 * can outlive local media so a channel deletion still reaches the relay. */
export class CallRoomGovernance {
  private readonly entries = new Map<string, Entry>()
  private readonly transport: Pick<CallRoomTransport, "status">
  private disposed = false
  constructor(private readonly options: Options, private readonly dependencies: Dependencies = {}) {
    this.transport = dependencies.transport ?? createCallRoomTransport(options.identity)
  }
  observeJoined(target: CallRoomTarget) {
    if (this.disposed) return
    const key = scope(target)
    const previous = this.entries.get(key)
    if (previous) {
      previous.target = target
      this.entries.delete(key); this.entries.set(key, previous)
    } else {
      this.entries.set(key, { target, acknowledged: signature(target), desired: null, attempted: "", attempts: 0, running: false })
      const limit = Math.max(1, Math.min(64, this.dependencies.maxScopes ?? 64))
      if (this.entries.size > limit) {
        const oldest = this.entries.keys().next().value!
        clearTimeout(this.entries.get(oldest)?.timer)
        this.entries.delete(oldest)
      }
    }
    this.refresh()
  }
  refresh() {
    if (this.disposed) return
    for (const [key, entry] of this.entries) this.refreshEntry(key, entry)
  }
  private refreshEntry(key: string, entry: Entry) {
    const latest = this.options.getTarget(entry.target)
    if (!latest || scope(latest) !== key || callRoomId(latest) !== callRoomId(entry.target)) {
      entry.desired = null
      clearTimeout(entry.timer); entry.timer = undefined
      return
    }
    const nextSignature = signature(latest)
    entry.desired = nextSignature === entry.acknowledged ? null : latest
    if (!entry.desired) { clearTimeout(entry.timer); entry.timer = undefined; return }
    if (entry.attempted !== nextSignature) {
      clearTimeout(entry.timer); entry.timer = undefined
      entry.attempted = nextSignature; entry.attempts = 0
    }
    if (!entry.running && !entry.timer && entry.attempts < 4) void this.publish(key, entry)
  }
  private live(key: string, entry: Entry) { return !this.disposed && this.entries.get(key) === entry }
  private async publish(key: string, entry: Entry) {
    const target = entry.desired
    if (!target || !this.live(key, entry) || entry.running) return
    const sentSignature = signature(target)
    entry.running = true; entry.attempts++
    let succeeded = false
    try { await this.transport.status(target); succeeded = true } catch { /* Bounded retries; media cleanup is independent. */ }
    if (!this.live(key, entry)) return
    entry.running = false
    if (succeeded) entry.acknowledged = sentSignature
    const latest = this.options.getTarget(entry.target)
    if (!latest || scope(latest) !== key || callRoomId(latest) !== callRoomId(entry.target)) {
      entry.desired = null; return
    }
    if (signature(latest) !== sentSignature || succeeded) { this.refreshEntry(key, entry); return }
    if (entry.attempts >= 4) return
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      if (this.live(key, entry)) this.refreshEntry(key, entry)
    }, this.dependencies.retryDelayMs ?? 1_000)
  }
  dispose() {
    this.disposed = true
    for (const entry of this.entries.values()) clearTimeout(entry.timer)
    this.entries.clear()
  }
}
