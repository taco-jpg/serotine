"use client"
import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-6"><h1 className="text-3xl">Something interrupted this page.</h1><p className="text-base leading-relaxed text-zinc-400">Try opening it again. Your saved identity and message history have not been cleared.</p><div className="flex gap-3"><Button onClick={reset}>Try again</Button><Button asChild variant="outline"><Link href="/login">Open identity</Link></Button></div></main>
}
