"use client"

import Link from "next/link"
import { MessageSquare, Lock, UserRound, ArrowRight } from "lucide-react"
import { useMessaging } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"

export default function ChatIndexPage() {
  const { identity, conversations } = useMessaging()
  const unread = conversations.filter(conversation => !conversation.blocked && !conversation.request).reduce((sum, conversation) => sum + conversation.unreadCount, 0)
  return <div className="flex h-full flex-col items-center justify-center p-10 text-center">
    <div className="mb-7 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5"><MessageSquare className="size-10 text-indigo-300" /></div>
    <p className="mb-3 text-xs font-medium uppercase tracking-[0.2em] text-zinc-500">Your private space</p>
    <h1 className="mb-4 max-w-lg text-4xl text-zinc-200">Good conversations, all together.</h1>
    <p className="max-w-md text-base leading-relaxed text-zinc-500">{unread ? `You have ${unread} unread message${unread === 1 ? "" : "s"}. Choose a conversation to catch up.` : "Choose a conversation, invite a friend, or create a group. Your inbox keeps up with every chat."}</p>
    {identity && <Button asChild variant="outline" className="mt-7 border-indigo-400/25 bg-indigo-400/5 text-indigo-200"><Link href={`/chat/${identity.publicKey}`}><UserRound className="size-4" /> Message yourself <ArrowRight className="size-4" /></Link></Button>}
    <div className="mt-12 flex max-w-lg gap-8 border-t border-zinc-800/70 pt-6 text-left"><div><Lock className="mb-3 size-4 text-zinc-500" /><p className="text-sm text-zinc-400">Private conversations</p><p className="mt-1 text-sm leading-relaxed text-zinc-600">Messages and shared files are encrypted on your device.</p></div><div><UserRound className="mb-3 size-4 text-zinc-500" /><p className="text-sm text-zinc-400">A chat with yourself</p><p className="mt-1 text-sm leading-relaxed text-zinc-600">Send yourself a thought, link, or file, just like any other message.</p></div></div>
  </div>
}
