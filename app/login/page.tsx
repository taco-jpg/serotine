import Link from "next/link"
import { ArrowLeft, ArrowUpRight, LockKeyhole, MessageCircle, ShieldCheck, Sparkles } from "lucide-react"
import { LoginForm } from "@/components/auth/login-form"
import { AppLogo } from "@/components/ui/app-logo"
import { ModeToggle } from "@/components/mode-toggle"

const principles = [
  { icon: LockKeyhole, number: "01", title: "An identity on this device", detail: "No email address or phone number." },
  { icon: ShieldCheck, number: "02", title: "Keys stay with you", detail: "Make a backup before you switch devices." },
  { icon: MessageCircle, number: "03", title: "Your conversations, ready", detail: "Direct messages, groups, and shared files." },
]

export default function LoginPage() {
  return <div className="app-surface login-page min-h-dvh bg-background px-5 text-foreground sm:px-8 lg:px-12">
    <header className="login-header mx-auto flex max-w-[1320px] items-center justify-between gap-4">
      <Link href="/" aria-label="Serotine home" className="login-brand"><AppLogo /></Link>
      <nav aria-label="Login navigation" className="flex items-center gap-3 sm:gap-5">
        <ModeToggle />
        <Link href="/" className="login-home-link"><ArrowLeft className="size-3.5" /><span className="hidden sm:inline">Back to Serotine</span><span className="sm:hidden">Home</span></Link>
      </nav>
    </header>

    <main className="login-layout mx-auto grid max-w-[1320px] gap-10 py-9 sm:py-12 lg:min-h-[calc(100dvh-154px)] lg:grid-cols-[minmax(0,1.1fr)_minmax(420px,.9fr)] lg:items-center lg:gap-20 lg:py-14">
      <section className="login-story min-w-0">
        <p className="login-kicker"><span aria-hidden="true" /> YOUR DEVICE / YOUR IDENTITY</p>
        <h1>Come as<br /><em>you are.</em></h1>
        <p className="login-lede">A private place to talk, made for the people you choose. Create a fresh identity here or bring yours with a backup.</p>
        <div className="login-principles" aria-label="How Serotine works">
          {principles.map(({ icon: Icon, number, title, detail }) => <div key={number}>
            <span className="login-principle-number">{number}</span><span className="login-principle-icon"><Icon className="size-4" aria-hidden="true" /></span>
            <span className="login-principle-copy"><strong>{title}</strong><small>{detail}</small></span>
            <ArrowUpRight className="login-principle-arrow size-3.5" aria-hidden="true" />
          </div>)}
        </div>
        <p className="login-aside-note"><Sparkles className="size-4" aria-hidden="true" /> A conversation starts with you.</p>
      </section>

      <section aria-label="Open your identity" className="login-card">
        <div className="login-card-heading">
          <span className="login-card-icon"><LockKeyhole className="size-4" aria-hidden="true" /></span>
          <span><span className="login-kicker">YOUR SEROTINE SPACE</span><span className="login-card-caption">Private messaging, on your terms.</span></span>
          <ArrowUpRight className="login-card-arrow size-4" aria-hidden="true" />
        </div>
        <div className="login-form-wrap"><LoginForm /></div>
        <div className="login-card-foot"><span className="login-foot-dot" /> Your private key stays in this browser.</div>
      </section>
    </main>

    <footer className="login-footer mx-auto flex max-w-[1320px] items-center justify-between gap-4">
      <span>serotine<span className="text-primary">.</span> <span className="login-footer-caption">A little closer, at your own pace.</span></span>
      <span className="login-footer-signoff">PRIVATE BY DESIGN <span>·</span> OPEN ABOUT HOW</span>
    </footer>
  </div>
}
