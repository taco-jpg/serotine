import type { Identity } from "./identity"

export type CallMode = "audio" | "video"
export type CallPhase = "idle" | "preparing" | "preview" | "incoming" | "ringing" | "connecting" | "connected" | "reconnecting" | "ended" | "declined" | "unanswered" | "busy" | "failed"
export type CallDirection = "incoming" | "outgoing"
export type CallAvailability = "checking" | "available" | "unavailable"
export interface CallPeerPolicy { accepted: boolean; blocked?: boolean; archived?: boolean; muted?: boolean; private?: boolean; label?: string }
export interface CallSettings { silenceIncoming: boolean; relayOnly: boolean }
export interface CallSnapshot {
  phase: CallPhase
  callId: string | null
  peer: string | null
  peerLabel: string
  direction: CallDirection | null
  mode: CallMode
  microphoneMuted: boolean
  cameraEnabled: boolean
  remoteMicrophoneMuted: boolean
  remoteCameraEnabled: boolean
  localStream: MediaStream | null
  remoteStream: MediaStream | null
  connectedAt: number | null
  error: string | null
  notice: string | null
  devices: MediaDeviceInfo[]
  microphoneId: string
  cameraId: string
  settings: CallSettings
  relayAvailable: boolean
  supported: boolean
}
export interface CompletedCall {
  id: string
  peer: string
  mode: CallMode
  direction: CallDirection
  outcome: "ended" | "declined" | "unanswered" | "busy" | "failed"
  startedAt: number
  endedAt: number
  durationSeconds: number
  private: boolean
}
export interface CallEngineOptions {
  identity: Identity
  getPeerPolicy: (peer: string) => CallPeerPolicy
  getPeers?: () => string[]
  onCompleted?: (call: CompletedCall) => void | Promise<void>
  settings?: Partial<CallSettings>
  onSettingsChange?: (settings: CallSettings) => void
}
export interface CallController {
  subscribe(listener: () => void): () => void
  getSnapshot(): CallSnapshot
  getServerSnapshot(): CallSnapshot
  start(): Promise<void>
  availability(peer: string): Promise<CallAvailability>
  prepareOutgoing(peer: string, mode: CallMode): Promise<void>
  prepareIncoming(mode: CallMode): Promise<void>
  connectPreview(): Promise<void>
  decline(): Promise<void>
  end(): Promise<void>
  dismiss(): void
  toggleMicrophone(): void
  toggleCamera(): Promise<void>
  selectMicrophone(deviceId: string): Promise<void>
  selectCamera(deviceId: string): Promise<void>
  switchCamera(): Promise<void>
  updateSettings(settings: Partial<CallSettings>): void
  dispose(): void
}
