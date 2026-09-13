import Link from "next/link"
import { ArrowLeft, ArrowUpRight } from "lucide-react"
import { LoginForm } from "@/components/auth/login-form"
import { AppLogo } from "@/components/ui/app-logo"
import { ModeToggle } from "@/components/mode-toggle"

export default function LoginPage() {
  return <div className="app-surface min-h-dvh bg-background px-6 text-foreground sm:px-10 lg:px-14">
    <header className="mx-auto flex min-h-20 max-w-6xl items-center justify-between gap-4 border-b border-border sm:min-h-24">
      <Link href="/" aria-label="Serotine home" className="inline-flex min-h-11 items-center"><AppLogo /></Link>
      <nav aria-label="Login navigation" className="flex items-center gap-3 sm:gap-6">
        <ModeToggle />
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-primary"><ArrowLeft className="size-3.5" /><span className="hidden sm:inline">Back to Serotine</span><span className="sm:hidden">Home</span></Link>
      </nav>
    </header>
    <main className="mx-auto grid max-w-6xl gap-10 py-12 sm:py-16 lg:min-h-[calc(100dvh-12rem)] lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-16 lg:py-20">
      <section className="min-w-0">
        <p className="app-eyebrow flex items-center gap-2"><span className="mr-2 inline-block size-1.5 bg-primary" aria-hidden="true" /> YOUR DEVICE. YOUR IDENTITY.</p>
        <h1 className="mt-6 text-[clamp(3.1rem,6vw,5.5rem)] font-normal leading-[1.02] tracking-[-0.065em]">A private<br /><span className="text-primary">place to talk.</span></h1>
        <p className="mt-6 max-w-sm text-sm leading-7 text-muted-foreground">A conversation starts with you. Create an identity here, or bring yours from another device.</p>
        <div className="mt-8 grid grid-cols-2 border-y border-border sm:mt-10">
          <div className="py-4 pr-4"><p className="app-eyebrow mb-2">01 / YOUR ADDRESS</p><p className="text-xs text-muted-foreground">No email or phone number.</p></div>
          <div className="border-l border-border py-4 pl-4"><p className="app-eyebrow mb-2">02 / YOUR KEY</p><p className="text-xs text-muted-foreground">Stored on this device.</p></div>
        </div>
      </section>
      <section aria-label="Open your identity" className="min-w-0 border-t border-border pt-7 lg:border-t-0 lg:border-l lg:py-6 lg:pl-12">
        <div className="mb-7 flex items-center justify-between gap-4"><p className="app-eyebrow">ENTER SEROTINE</p><ArrowUpRight className="size-5 text-primary" aria-hidden="true" /></div>
        <div className="max-w-md"><LoginForm /></div>
        <p className="mt-7 max-w-md border-t border-border pt-4 text-xs leading-6 text-muted-foreground">Your private key stays in this browser. Only share your public contact address.</p>
      </section>
    </main>
    <footer className="mx-auto flex max-w-6xl items-center justify-between gap-4 border-t border-border py-6">
      <p className="app-eyebrow">A LITTLE LESS NOISE. A LITTLE MORE YOU.</p>
      <span className="text-xl leading-none text-primary" aria-hidden="true">✳</span>
    </footer>
  </div>
}
