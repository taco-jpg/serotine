import { Component, useEffect, useState, type ReactNode } from "react"
import { ThemeProvider } from "@/components/theme-provider"
import { MobileViewport } from "@/components/mobile-viewport"
import LoginPage from "@/app/login/page"
import ChatLayout from "@/app/chat/layout-client"
import ChatIndex from "@/app/chat/page"
import ChatClient from "@/app/chat/[pubkey]/chat-client"
import CommunitiesPage from "@/app/chat/communities/page"
import { parseConversationAddress } from "@/lib/conversation-route"
import { usePathname } from "./router"
import { getNativeBridge, type NativeInfo, type NativeUpdateState } from "../shared/bridge"

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <main role="alert" className="p-8"><h1>Serotine could not open this screen.</h1><p>Your stored data has been preserved. Close and reopen the app to retry.</p></main> : this.props.children }
}
function NativeAbout({ info }: { info: NativeInfo }) {
  const [storage, setStorage] = useState("saved")
  const [open, setOpen] = useState(false)
  const [update, setUpdate] = useState<NativeUpdateState>({ status: info.autoUpdate ? "checking" : "unsupported" })
  const bridge = getNativeBridge()
  useEffect(() => {
    const update = (event: Event) => setStorage((event as CustomEvent<{ state: string }>).detail.state)
    window.addEventListener("serotine:native-storage", update)
    return () => window.removeEventListener("serotine:native-storage", update)
  }, [])
  useEffect(() => {
    if (!bridge) return
    let live = true
    const offUpdate = bridge.onUpdateState?.(state => { if (live) { setUpdate(state); if (state.status === "available") setOpen(true) } })
    const offAbout = bridge.onShowAbout?.(() => setOpen(true))
    const offCheck = bridge.onCheckUpdates?.(() => { setOpen(true); void bridge.checkForUpdates?.() })
    void bridge.getUpdateState?.().then(state => { if (live) setUpdate(state) }).catch(() => undefined)
    return () => { live = false; offUpdate?.(); offAbout?.(); offCheck?.() }
  }, [bridge])
  const check = () => { setUpdate({ status: "checking" }); void bridge?.checkForUpdates?.() }
  const download = () => { setUpdate({ status: "downloading", percent: 0 }); void bridge?.downloadUpdate?.() }
  const install = (restart: boolean) => { void bridge?.installUpdate?.(restart) }
  const updateMessage = update.message || (update.status === "unsupported" ? "Automatic updates are not available for this build." : "")
  return <>
    {storage !== "saved" && <div className="native-storage-status" role="status">{storage === "saving" ? "Saving on this device…" : "Storage could not be saved. Keep Serotine open while it retries."}</div>}
    {open && <div className="native-about-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="native-about" role="dialog" aria-modal="true" aria-labelledby="native-about-title">
        <header className="native-about-header"><div><p className="native-about-kicker">SEROTINE · DESKTOP</p><h1 id="native-about-title">About Serotine</h1></div><button className="native-about-close" onClick={() => setOpen(false)} aria-label="Close About">×</button></header>
        <div className="native-about-version"><span className="native-about-mark">s.</span><div><strong>Serotine {info.version}</strong><span>{info.platform === "darwin" ? "macOS" : info.platform === "win32" ? "Windows" : info.platform}</span></div><span className="native-about-channel">{info.development ? "PREVIEW" : "DESKTOP"}</span></div>
        <section className="native-about-section"><h2>Updates</h2>
          <p className="native-about-copy">{update.status === "available" ? `Serotine ${update.version} is ready to download.` : update.status === "downloaded" ? `Serotine ${update.version} is downloaded and ready to install.` : update.status === "not-available" ? "You’re using the latest available version." : update.status === "checking" ? "Checking for a newer version…" : update.status === "downloading" ? `Downloading update${typeof update.percent === "number" ? ` · ${Math.round(update.percent)}%` : "…"}` : updateMessage || "Check for the latest version."}</p>
          {update.status === "downloading" && <div className="native-about-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(update.percent || 0)}><span style={{ width: `${Math.max(0, Math.min(100, update.percent || 0))}%` }} /></div>}
          {update.status === "error" && <p className="native-about-error" role="alert">{update.message || "The update check did not finish. Try again when you’re online."}</p>}
          <div className="native-about-actions">
            {update.status === "available" && <><button className="native-about-primary" onClick={download}>Download update</button><button className="native-about-secondary" onClick={() => setOpen(false)}>Later</button></>}
            {update.status === "downloaded" && <><button className="native-about-primary" onClick={() => install(true)}>Restart and update</button><button className="native-about-secondary" onClick={() => install(false)}>Quit and update</button><button className="native-about-secondary" onClick={() => setOpen(false)}>Later</button></>}
            {(update.status === "idle" || update.status === "not-available" || update.status === "error") && <button className="native-about-primary" disabled={!info.autoUpdate} onClick={check}>Check for updates</button>}
            {update.status === "checking" && <button className="native-about-secondary" disabled>Checking…</button>}
            {update.status === "downloading" && <button className="native-about-secondary" disabled>Downloading…</button>}
          </div>
        </section>
        {info.platform === "darwin" && info.development && <section className="native-about-note"><strong>First opening on macOS</strong><p>For this unsigned preview, remove the downloaded quarantine once, then open it:</p><code>xattr -dr com.apple.quarantine "/Applications/Serotine Dev.app"</code><p>Unsigned macOS previews cannot install updates in-app. Download the next preview from Releases.</p></section>}
        <footer className="native-about-footer"><span>Keep the app open to sync messages.</span><button onClick={() => void bridge?.openExternal({ url: "https://github.com/taco-jpg/serotine/releases" })}>Official releases ↗</button></footer>
      </section>
    </div>}
  </>
}
export function NativeApp({ info }: { info: NativeInfo }) {
  const path = usePathname()
  let address: string | null = null
  try { address = path.startsWith("/chat/") ? parseConversationAddress(decodeURIComponent(path.slice(6))) : null } catch { /* Invalid deep links open the identity screen. */ }
  let screen: ReactNode = <LoginPage />
  if (path === "/chat" || path === "/chat/communities" || address) screen = <ChatLayout>{path === "/chat/communities" ? <CommunitiesPage /> : address ? <ChatClient key={address} params={{ pubkey: address }} /> : <ChatIndex />}</ChatLayout>
  return <ErrorBoundary><ThemeProvider attribute="class" defaultTheme="system" enableSystem enableColorScheme disableTransitionOnChange><MobileViewport /><NativeAbout info={info} /><div className="native-screen">{screen}</div></ThemeProvider></ErrorBoundary>
}
