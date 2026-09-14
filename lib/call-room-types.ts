import type { CallConnectionDiagnostics } from "./call-ice"
import type { Identity } from "./identity"
import type { CallMode, CallSettings } from "./call-types"
import type { CallRoomTarget } from "./call-room-transport"

export type CallRoomPhase = "idle" | "preparing" | "preview" | "joining" | "joined" | "ended" | "failed"
export interface CallRoomParticipantSnapshot {
  connection: CallConnectionDiagnostics | null
  publicKey: string
  sessionId: string
  label: string
  phase: "connecting" | "connected" | "reconnecting" | "failed"
  stream: MediaStream | null
  microphoneMuted: boolean
  cameraEnabled: boolean
  error: string | null
}
export interface CallRoomSnapshot {
  phase: CallRoomPhase
  target: CallRoomTarget | null
  targetLabel: string
  roomId: string | null
  mode: CallMode
  localStream: MediaStream | null
  /** Remote participants only. The local preview is in localStream. */
  participants: CallRoomParticipantSnapshot[]
  microphoneMuted: boolean
  cameraEnabled: boolean
  devices: MediaDeviceInfo[]
  microphoneId: string
  cameraId: string
  joinedAt: number | null
  error: string | null
  notice: string | null
  supported: boolean
  settings: CallSettings
}
export interface CallRoomEngineOptions {
  identity: Identity
  /** Return the current signed state, or null when membership/channel access ends. */
  getTarget: (target: CallRoomTarget) => CallRoomTarget | null
  getPeerLabel?: (publicKey: string) => string
  isBusy?: () => boolean
  settings?: Partial<CallSettings>
  onSettingsChange?: (settings: CallSettings) => void
}
export interface CallRoomController {
  subscribe(listener: () => void): () => void
  getSnapshot(): CallRoomSnapshot
  getServerSnapshot(): CallRoomSnapshot
  prepare(target: CallRoomTarget, mode: CallMode): Promise<void>
  joinPreview(): Promise<void>
  leave(): Promise<void>
  dismiss(): void
  toggleMicrophone(): void
  toggleCamera(): Promise<void>
  selectMicrophone(deviceId: string): Promise<void>
  selectCamera(deviceId: string): Promise<void>
  switchCamera(): Promise<void>
  updateSettings(settings: Partial<CallSettings>): void
  dispose(): void
}
