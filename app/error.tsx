"use client"
import Link from "next/link"
import { AppLogo } from "@/components/ui/app-logo"
import { Button } from "@/components/ui/button"

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="app-surface mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-6"><Link href="/" className="mb-8 self-start" aria-label="Serotine home"><AppLogo /></Link><h1 className="text-[clamp(2rem,5vw,3rem)] font-medium leading-[1.05] tracking-[-0.04em]">Something interrupted this page.</h1><p className="text-sm leading-relaxed text-muted-foreground">Try opening it again. Your saved identity and message history have not been cleared.</p><div className="flex gap-3"><Button onClick={reset}>Try again</Button><Button asChild variant="outline"><Link href="/login">Open identity</Link></Button></div></main>
}
