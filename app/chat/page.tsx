"use client"

import Link from "next/link"
import { ArrowUpRight, Lock, UserRound } from "lucide-react"
import { useMessaging } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"

export default function ChatIndexPage() {
  const { identity, conversations } = useMessaging()
  const unread = conversations.filter(conversation => !conversation.blocked && !conversation.request && !conversation.archived).reduce((sum, conversation) => sum + conversation.unreadCount, 0)

  return <div className="flex h-full min-h-0 flex-col overflow-y-auto">
    <header className="flex min-h-15 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
      <p className="app-eyebrow">Your inbox</p>
      <span className="font-mono text-[10px] tracking-wide text-muted-foreground">{unread ? `${unread} unread` : "All caught up"}</span>
    </header>
    <div className="flex flex-1 flex-col justify-center px-8 py-10 lg:px-14">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-7 flex items-center gap-3"><span aria-hidden="true" className="size-1.5 bg-primary" /><p className="app-eyebrow">A little less noise.</p></div>
        <h1 className="max-w-2xl text-5xl leading-[1.02] font-medium tracking-[-0.065em] text-foreground lg:text-7xl">Good conversations.<br /><span className="text-primary">Your space.</span></h1>
        <p className="mt-6 max-w-md text-sm leading-7 text-muted-foreground">{unread ? `You have ${unread} unread message${unread === 1 ? "" : "s"}. Open a conversation to pick up where you left off.` : "A thought, a plan, a conversation worth having. Choose a chat or invite someone in."}</p>
        {identity && <Button asChild className="mt-7 h-11 gap-7 px-4"><Link href={`/chat/${identity.publicKey}`}><UserRound className="size-4" />Message yourself<ArrowUpRight className="size-4" /></Link></Button>}
        <div className="mt-12 grid grid-cols-2 border-y border-border text-left lg:mt-16">
          <div className="py-5 pr-6">
            <div className="mb-3 flex items-center justify-between gap-3"><span className="app-eyebrow">01 / Private by design</span><Lock className="size-3.5 shrink-0 text-primary" /></div>
            <p className="max-w-60 text-xs leading-6 text-muted-foreground">Messages and shared files are encrypted on your device.</p>
          </div>
          <div className="border-l border-border py-5 pl-6">
            <div className="mb-3 flex items-center justify-between gap-3"><span className="app-eyebrow">02 / Keep it together</span><ArrowUpRight className="size-3.5 shrink-0 text-primary" /></div>
            <p className="max-w-60 text-xs leading-6 text-muted-foreground">Save thoughts, links, and files in a conversation with yourself.</p>
          </div>
        </div>
      </div>
    </div>
  </div>
}
