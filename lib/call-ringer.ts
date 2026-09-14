import type { CallSnapshot } from "./call-types"

export type CallSoundStatus = "ready" | "blocked" | "unavailable"
type RingMode = "incoming" | "outgoing"
type RingState = Pick<CallSnapshot, "phase" | "direction" | "callId" | "settings">
interface RingerOptions {
  onStatusChange?: (status: CallSoundStatus) => void
  createContext?: () => AudioContext
  now?: () => number
  maxDurationMs?: number
}

/** Local synthesized alerts only: this never captures, records, or sends audio. */
export class CallRinger {
  private context: AudioContext | null = null
  private active: { id: string; mode: RingMode; expiresAt: number } | null = null
  private selectedCall: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private tones = new Map<OscillatorNode, GainNode>()
  private status: CallSoundStatus = "blocked"
  private disposed = false
  private readonly now: () => number

  constructor(private readonly options: RingerOptions = {}) { this.now = options.now ?? Date.now }
  getStatus() { return this.status }
  private report(status: CallSoundStatus) {
    if (this.disposed || this.status === status) return
    this.status = status
    this.options.onStatusChange?.(status)
  }
  private ensureContext() {
    if (this.context || this.disposed) return this.context
    try {
      this.context = this.options.createContext?.() ?? new AudioContext()
      this.context.onstatechange = () => this.refresh()
    } catch { this.report("unavailable") }
    return this.context
  }

  /** Call directly from a pointer/keyboard gesture; resume may stay pending until permission. */
  unlock = () => {
    const context = this.ensureContext()
    if (!context) return
    if (context.state !== "running") {
      void context.resume().then(() => this.refresh()).catch(() => this.report("blocked"))
    }
    this.refresh()
  }

  setCall(snapshot: RingState | null) {
    const mode = snapshot?.phase === "incoming" && !snapshot.settings.silenceIncoming ? "incoming"
      : snapshot?.phase === "ringing" && snapshot.direction === "outgoing" ? "outgoing" : null
    if (!mode || !snapshot?.callId) { this.stop(); return }
    const key = `${snapshot.callId}:${mode}`
    if (this.selectedCall === key) return
    this.stop()
    if (this.disposed) return
    this.selectedCall = key
    this.active = { id: snapshot.callId, mode, expiresAt: this.now() + (this.options.maxDurationMs ?? 40_000) }
    this.ensureContext()
    this.refresh()
  }

  private refresh() {
    if (this.disposed || !this.context) return
    if (this.context.state === "running") {
      this.report("ready")
      if (this.active && !this.timer) {
        try { this.cycle() } catch { this.stopSound(); this.report("unavailable") }
      }
    } else {
      this.report(this.context.state === "closed" ? "unavailable" : "blocked")
      this.stopSound()
    }
  }
  private cycle() {
    if (this.disposed || !this.active || !this.context || this.context.state !== "running") return
    const remaining = this.active.expiresAt - this.now()
    if (remaining <= 0) { this.active = null; this.stopSound(); return }
    const start = this.context.currentTime
    // Soft double chime for the recipient; a quieter pulse while the caller waits.
    if (this.active.mode === "incoming") {
      this.tone(660, start, 0.22, 0.045)
      this.tone(880, start + 0.32, 0.22, 0.045)
    } else {
      this.tone(440, start, 0.8, 0.022)
      this.tone(480, start, 0.8, 0.022)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.refresh()
    }, Math.min(remaining, this.active.mode === "incoming" ? 2_600 : 4_000))
  }
  private tone(frequency: number, start: number, duration: number, volume: number) {
    const context = this.context!
    const tone = context.createOscillator()
    const gain = context.createGain()
    tone.type = "sine"
    tone.frequency.value = frequency
    gain.gain.setValueAtTime(0, start)
    gain.gain.linearRampToValueAtTime(volume, start + 0.025)
    gain.gain.setValueAtTime(volume, start + duration - 0.04)
    gain.gain.linearRampToValueAtTime(0, start + duration)
    tone.connect(gain)
    gain.connect(context.destination)
    this.tones.set(tone, gain)
    tone.onended = () => { tone.disconnect(); gain.disconnect(); this.tones.delete(tone) }
    tone.start(start)
    tone.stop(start + duration)
  }
  private stopSound() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const [tone, gain] of this.tones) {
      tone.onended = null
      try { tone.stop() } catch { /* The scheduled tone may already have ended. */ }
      tone.disconnect()
      gain.disconnect()
    }
    this.tones.clear()
  }
  stop() { this.active = null; this.selectedCall = null; this.stopSound() }
  dispose() {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    if (this.context) {
      this.context.onstatechange = null
      void this.context.close().catch(() => undefined)
      this.context = null
    }
  }
}
