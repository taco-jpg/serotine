import Link from "next/link"
import { AppLogo } from "@/components/ui/app-logo"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return <main className="app-surface relative isolate mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-6"><div className="hl-backdrop !fixed" aria-hidden="true" /><Link href="/" className="mb-8 self-start" aria-label="Serotine home"><AppLogo /></Link><p className="app-eyebrow inline-flex w-fit items-center gap-2 rounded-full border border-ring/30 bg-ring/10 px-3 py-1 !text-ring"><span className="live-dot" aria-hidden="true" />404</p><h1 className="text-4xl font-medium tracking-[-0.05em]">This address isn’t here.</h1><p className="text-base leading-relaxed text-muted-foreground">Check the link, or open your contacts to choose a conversation.</p><Button asChild className="self-start"><Link href="/chat">Open conversations</Link></Button></main>
}
