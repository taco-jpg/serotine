import Link from "next/link"
import { ArrowLeft, ArrowUpRight } from "lucide-react"
import { LoginForm } from "@/components/auth/login-form"
import { AppLogo } from "@/components/ui/app-logo"
import { ModeToggle } from "@/components/mode-toggle"

const specifications = [
  { term: "Identity", value: "P-256 key pair" },
  { term: "Address", value: "Derived, shareable" },
  { term: "Private key", value: "This browser only" },
  { term: "Sign-up", value: "None" },
]

export default function LoginPage() {
  return <div className="app-surface relative min-h-dvh bg-background px-5 text-foreground sm:px-8 lg:px-14">
    <header className="relative z-10 mx-auto flex min-h-16 max-w-7xl items-center justify-between gap-4 border-b border-border">
      <Link href="/" aria-label="Serotine home" className="inline-flex min-h-11 items-center"><AppLogo /></Link>
      <nav aria-label="Login navigation" className="flex items-center gap-1">
        <ModeToggle />
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 px-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground transition-colors hover:text-foreground"><ArrowLeft className="size-3.5" /><span className="hidden sm:inline">Back to Serotine</span><span className="sm:hidden">Home</span></Link>
      </nav>
    </header>
    <main className="relative z-10 mx-auto grid max-w-7xl gap-12 py-12 sm:py-16 lg:min-h-[calc(100dvh-12rem)] lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-20 lg:py-20">
      <section className="min-w-0">
        <p className="app-eyebrow flex items-center gap-2.5"><span className="inline-block size-1.5 bg-primary" aria-hidden="true" /> Your device. Your identity.</p>
        <h1 className="mt-6 text-[clamp(2.9rem,5.6vw,5rem)] font-medium leading-[1] tracking-[-0.05em]">A private<br /><span className="text-primary">place to talk.</span></h1>
        <p className="mt-7 max-w-md text-sm leading-7 text-muted-foreground">A conversation starts with you. Create an identity here, or bring yours from another device.</p>
        <dl className="mt-10 max-w-md border-t border-border">
          {specifications.map(specification => <div className="flex items-baseline justify-between gap-6 border-b border-border py-3" key={specification.term}>
            <dt className="font-mono text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{specification.term}</dt>
            <dd className="text-right font-mono text-[12px] text-foreground">{specification.value}</dd>
          </div>)}
        </dl>
      </section>
      <section aria-label="Open your identity" className="min-w-0 lg:justify-self-end lg:pl-8 lg:border-l lg:border-border">
        <div className="w-full max-w-md border border-border bg-card">
          <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
            <p className="app-eyebrow">Enter Serotine</p>
            <ArrowUpRight className="size-4 text-primary" aria-hidden="true" />
          </div>
          <div className="p-5 sm:p-6"><LoginForm /></div>
          <p className="border-t border-border px-5 py-4 text-xs leading-6 text-muted-foreground sm:px-6">Your private key stays in this browser. Only share your public contact address.</p>
        </div>
      </section>
    </main>
    <footer className="relative z-10 mx-auto flex max-w-7xl items-center justify-between gap-4 border-t border-border py-6">
      <p className="app-eyebrow">A little less noise. A little more you.</p>
      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground" aria-hidden="true">E2EE</span>
    </footer>
  </div>
}
