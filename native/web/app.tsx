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
import { getNativeBridge, type NativeInfo } from "../shared/bridge"

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  render() { return this.state.failed ? <main role="alert" className="p-8"><h1>Serotine could not open this screen.</h1><p>Your stored data has been preserved. Close and reopen the app to retry.</p></main> : this.props.children }
}
function NativeStatus({ info }: { info: NativeInfo }) {
  const [storage, setStorage] = useState("saved")
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const update = (event: Event) => setStorage((event as CustomEvent<{ state: string }>).detail.state)
    window.addEventListener("serotine:native-storage", update)
    return () => window.removeEventListener("serotine:native-storage", update)
  }, [])
  return <>
    <div className="native-status">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>Serotine {info.version} · App info</button>
      <span role="status">{storage === "saving" ? "Saving on this device…" : storage === "error" ? "Storage unavailable — reopen to recover" : "Syncs while open"}</span>
    </div>
    {open && <section className="native-info" aria-label="Installed app information">
      <button onClick={() => setOpen(false)} className="float-right p-2" aria-label="Close app information">Close</button>
      <h2>Serotine for {info.platform}</h2>
      <p>This app has its own local identity and history. To bring your browser identity, restore your password-encrypted backup. File-bank items and drafts are not included in that transfer.</p>
      <p>Keep the app open to receive messages. Mobile suspension, closing the desktop window, or Quit stops synchronization. Calls and transfers can be interrupted by sleep or loss of network.</p>
      <p>Back up your identity before uninstalling or clearing app data. Updates from the same signed release channel preserve your data. Development builds use separate storage.</p>
      <button className="underline" onClick={() => void getNativeBridge()?.openExternal({ url: "https://github.com/taco-jpg/serotine/releases" })}>Official releases and update instructions</button>
    </section>}
  </>
}
export function NativeApp({ info }: { info: NativeInfo }) {
  const path = usePathname()
  let address: string | null = null
  try { address = path.startsWith("/chat/") ? parseConversationAddress(decodeURIComponent(path.slice(6))) : null } catch { /* Invalid deep links open the identity screen. */ }
  let screen: ReactNode = <LoginPage />
  if (path === "/chat" || path === "/chat/communities" || address) screen = <ChatLayout>{path === "/chat/communities" ? <CommunitiesPage /> : address ? <ChatClient key={address} params={{ pubkey: address }} /> : <ChatIndex />}</ChatLayout>
  return <ErrorBoundary><ThemeProvider attribute="class" defaultTheme="system" enableSystem enableColorScheme disableTransitionOnChange><MobileViewport /><NativeStatus info={info} /><div className="native-screen">{screen}</div></ThemeProvider></ErrorBoundary>
}
