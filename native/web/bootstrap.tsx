import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core"
import { createRoot, type Root } from "react-dom/client"
import type { NativeBridge, NativeInfo, NativeRequest, NativeResponse } from "../shared/bridge"
import { setNativeInfo } from "../shared/bridge"
import { initializeNativePersistence, recoverNativePersistence } from "../shared/persistence"
import { saveDownload } from "@/lib/save-download"

let reactRoot: Root | undefined
type FailureStage = "HOST_CONNECT" | "HOST_INFO" | "STORAGE_READ" | "STORAGE_RESTORE" | "STORAGE_WRITE" | "UI_START" | "STORAGE_RUNTIME"
let startupStage: FailureStage = "HOST_CONNECT"
let appStarted = false

interface MobilePlugin {
  getInfo(): Promise<NativeInfo>
  readSnapshot(): Promise<{ value: string | null }>
  writeSnapshot(input: { value: string }): Promise<void>
  request(input: NativeRequest): Promise<NativeResponse>
  saveFile(input: { name: string; mimeType: string; dataBase64: string }): Promise<{ saved: boolean }>
  openBackup(): Promise<{ name: string; dataBase64: string } | { cancelled: true }>
  openExternal(input: { url: string }): Promise<void>
  resetStorage(input: { confirmation: "DELETE LOCAL DATA" }): Promise<{ reset: boolean }>
  addListener(name: string, listener: (event: { active?: boolean }) => void): Promise<PluginListenerHandle>
}
function failure(stage: FailureStage = appStarted ? "STORAGE_RUNTIME" : startupStage) {
  // Never display exception payloads which may contain private state or keys.
  reactRoot?.unmount()
  reactRoot = undefined
  const root = document.getElementById("root")!
  root.replaceChildren()
  const main = document.createElement("main")
  main.className = "native-failure"
  main.setAttribute("role", "alert")
  main.dataset.nativeErrorCode = stage
  const title = document.createElement("h1")
  title.textContent = stage.startsWith("STORAGE_") ? "Serotine could not open its saved data." : "Serotine could not finish starting."
  const detail = document.createElement("p")
  detail.textContent = "Your stored files have been preserved. Close and reopen the app to retry. If storage is full, free some device space first. Do not clear app data or uninstall without your encrypted backup."
  const diagnostic = document.createElement("p")
  diagnostic.textContent = `Diagnostic code: ${stage}. Include this code when reporting the problem; you do not need to share your backup or password.`
  main.append(title, detail, diagnostic)
  const bridge = window.serotineNative
  if (bridge?.resetStorage && !appStarted && stage.startsWith("STORAGE_")) {
    const warning = document.createElement("p")
    warning.textContent = "If the saved data cannot be recovered, you can erase this app's local data and then restore a password-encrypted backup. This permanently removes local identities, history, files and settings. Data not in your backup cannot be recovered."
    const reset = document.createElement("button")
    const confirmation = document.createElement("input")
    confirmation.type = "text"
    confirmation.autocomplete = "off"
    confirmation.setAttribute("aria-label", "Type DELETE LOCAL DATA to erase local data")
    confirmation.placeholder = "Type DELETE LOCAL DATA"
    confirmation.style.display = "block"
    confirmation.style.margin = "1rem 0"
    reset.disabled = true
    confirmation.oninput = () => { reset.disabled = confirmation.value !== "DELETE LOCAL DATA" }
    reset.textContent = "Erase local data to recover from a backup…"
    reset.onclick = () => {
      if (confirmation.value !== "DELETE LOCAL DATA") return
      reset.disabled = true
      void (async () => {
        const result = await recoverNativePersistence(() => bridge.resetStorage!({ confirmation: "DELETE LOCAL DATA" }))
        if (!result.reset) { reset.disabled = false; return }
        window.location.reload()
      })().catch(() => { warning.textContent = "Recovery could not complete. Close and reopen Serotine before trying again. Your encrypted backup remains the recovery source."; reset.disabled = false })
    }
    main.append(warning, confirmation, reset)
  }
  root.append(main)
}
async function start() {
  if (!window.serotineNative && Capacitor.isNativePlatform()) {
    const plugin = registerPlugin<MobilePlugin>("SerotineNative")
    const bridge: NativeBridge = {
      platform: Capacitor.getPlatform(),
      getInfo: () => plugin.getInfo(),
      readSnapshot: async () => (await plugin.readSnapshot()).value,
      writeSnapshot: input => plugin.writeSnapshot(input),
      request: input => plugin.request(input),
      saveFile: input => plugin.saveFile(input),
      openBackup: async () => { const result = await plugin.openBackup(); return "cancelled" in result ? null : result },
      openExternal: input => plugin.openExternal(input),
      resetStorage: input => plugin.resetStorage(input),
      onResume: callback => {
        const listener = plugin.addListener("lifecycle", event => { if (event.active) callback() })
        return () => { void listener.then(handle => handle.remove()) }
      },
    }
    Object.defineProperty(window, "serotineNative", { value: Object.freeze(bridge), configurable: false, writable: false })
    await plugin.addListener("back", () => {
      if (window.location.pathname.startsWith("/chat/")) {
        window.history.replaceState({}, "", "/chat")
        window.dispatchEvent(new PopStateEvent("popstate"))
      } else window.history.back()
    })
  }
  const bridge = window.serotineNative
  if (!bridge) throw new Error("The installed client requires its native host.")
  startupStage = "HOST_INFO"
  const info = await bridge.getInfo()
  setNativeInfo(info)
  startupStage = "STORAGE_RESTORE"
  const persistence = await initializeNativePersistence({
    readSnapshot: async () => {
      try { return await bridge.readSnapshot() }
      catch (error) { startupStage = "STORAGE_READ"; throw error }
    },
    writeSnapshot: async value => {
      try { await bridge.writeSnapshot({ value }) }
      catch (error) { if (!appStarted) startupStage = "STORAGE_WRITE"; throw error }
    },
  }, () => failure())
  bridge.onBeforeQuit?.(async () => {
    reactRoot?.unmount(); reactRoot = undefined
    try { await persistence.flush() }
    catch (error) { failure(); throw error }
  })
  startupStage = "UI_START"
  const { NativeApp } = await import("./app")
  bridge.onResume(() => {
    window.dispatchEvent(new Event("online"))
    window.dispatchEvent(new Event("focus"))
    document.dispatchEvent(new Event("visibilitychange"))
  })
  // Native shells only load packaged code. Outbound pages open outside the bridge.
  document.addEventListener("click", event => {
    const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null
    if (!anchor) return
    if (anchor.hasAttribute("download")) {
      event.preventDefault()
      const url = new URL(anchor.href, window.location.href)
      if (url.protocol === "blob:" || url.protocol === "data:") {
        void fetch(url.href).then(response => response.blob()).then(blob => saveDownload(blob, anchor.download || "serotine-download")).catch(() => window.alert("The file could not be saved. Check device storage and try again."))
      }
      return
    }
    const url = new URL(anchor.href, window.location.href)
    if (url.origin !== window.location.origin && ["https:", "http:"].includes(url.protocol)) {
      event.preventDefault()
      void bridge.openExternal({ url: url.href }).catch(() => window.alert("The link could not be opened. Try again."))
    }
  }, true)
  if (window.location.pathname === "/" || window.location.pathname === "/index.html") {
    window.history.replaceState({}, "", `/login${window.location.search}${window.location.hash}`)
  }
  reactRoot = createRoot(document.getElementById("root")!)
  reactRoot.render(<NativeApp info={info} />)
  appStarted = true
}
void start().catch(() => failure())
