export interface NativeInfo {
  platform: string
  version: string
  relayOrigin: string
  backgroundSync: boolean
  autoUpdate?: boolean
  development?: boolean
}
export type NativeUpdateState = { status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | "unsupported"; version?: string; percent?: number; message?: string }
export interface NativeRequest {
  path: string
  method: string
  headers?: Record<string, string>
  bodyBase64?: string
}
export interface NativeResponse {
  status: number
  headers: Record<string, string>
  bodyBase64: string
}
/** No filesystem paths, executable code, raw IPC, or caller-selected hosts. */
export interface NativeBridge {
  platform: string
  getInfo(): Promise<NativeInfo>
  readSnapshot(): Promise<string | null>
  writeSnapshot(input: { value: string }): Promise<void>
  request(input: NativeRequest): Promise<NativeResponse>
  saveFile(input: { name: string; mimeType: string; dataBase64: string }): Promise<{ saved: boolean }>
  openBackup(): Promise<{ name: string; dataBase64: string } | null>
  openExternal(input: { url: string }): Promise<void>
  checkForUpdates?(): Promise<void>
  downloadUpdate?(): Promise<void>
  installUpdate?(restart: boolean): Promise<void>
  getUpdateState?(): Promise<NativeUpdateState>
  onUpdateState?(callback: (state: NativeUpdateState) => void): () => void
  onShowAbout?(callback: () => void): () => void
  onCheckUpdates?(callback: () => void): () => void
  onResume(callback: () => void): () => void
  onBeforeQuit?(callback: () => Promise<void>): () => void
  resetStorage?(input: { confirmation: "DELETE LOCAL DATA" }): Promise<{ reset: boolean }>
}
let installedInfo: NativeInfo | undefined
export function setNativeInfo(info: NativeInfo) { installedInfo = info }
/** Desktop preload uses "desktop"; the verified host info identifies Windows. */
export function isWindowsNative(): boolean { return installedInfo?.platform === "win32" && !!getNativeBridge() }
export function appLinkOrigin(): string {
  if (getNativeBridge() && !installedInfo) throw new Error("The native relay configuration is not ready.")
  return installedInfo?.relayOrigin ?? (typeof window !== "undefined" ? window.location.origin : "https://serotine.chat")
}
declare global { interface Window { serotineNative?: NativeBridge } }
export function getNativeBridge(): NativeBridge | undefined {
  return typeof window === "undefined" ? undefined : window.serotineNative
}
