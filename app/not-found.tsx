import Link from "next/link"
import { Button } from "@/components/ui/button"

export default function NotFound() {
  return <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 px-6"><p className="text-xs tracking-widest text-indigo-300">404</p><h1 className="text-3xl">This address isn’t here.</h1><p className="text-base leading-relaxed text-zinc-400">Check the link, or open your contacts to choose a conversation.</p><Button asChild className="self-start"><Link href="/chat">Open conversations</Link></Button></main>
}
