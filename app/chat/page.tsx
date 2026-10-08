"use client"

import Link from "next/link"
import { ArrowUpRight, CircleCheck, Hash, LockKeyhole, UserRound } from "lucide-react"
import { useCommunities, useMessaging } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"

export default function ChatIndexPage() {
  const { identity, conversations, preferences } = useMessaging()
  const { model } = useCommunities()
  const unread = conversations.filter(conversation => !conversation.blocked && !conversation.request && !conversation.archived).reduce((sum, conversation) => sum + conversation.unreadCount, 0)
    + model.communities.filter(community => community.joined && !community.deleted && !preferences.archived.includes(community.id)).reduce((sum, community) => sum + community.unreadCount, 0)

  return <div className="chat-home flex h-full min-h-0 flex-col overflow-y-auto">
    <header className="chat-home-header flex min-h-15 shrink-0 items-center justify-between gap-4 border-b border-border px-6">
      <p className="app-eyebrow">YOUR INBOX <span>/</span> OVERVIEW</p>
      <span className={`chat-home-state ${unread ? "has-unread" : ""}`}><span aria-hidden="true" />{unread ? `${unread} unread` : "All caught up"}</span>
    </header>
    <main className="chat-home-main flex flex-1 flex-col justify-center px-6 py-10 sm:px-10 lg:px-16">
      <div className="chat-home-grid mx-auto grid w-full max-w-6xl items-center gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(300px,.76fr)] lg:gap-20">
        <section className="chat-home-copy min-w-0">
          <div className="chat-home-kicker"><span /> A SPACE OF YOUR OWN</div>
          <h1>{unread ? <>You have<br /><em>messages waiting.</em></> : <>The people you care about,<br /><em>closer by.</em></>}</h1>
          <p>{unread ? `You have ${unread} unread message${unread === 1 ? "" : "s"}. Open a conversation to pick up where you left off.` : "A thought, a plan, a conversation worth having. Choose a chat or invite someone in."}</p>
          <div className="chat-home-actions">
            {identity && <Button asChild className="chat-home-primary"><Link href={`/chat/${identity.publicKey}`}><UserRound className="size-4" />Message yourself<ArrowUpRight className="size-4" /></Link></Button>}
            <Button asChild variant="outline" className="chat-home-community"><Link href="/chat/communities"><Hash className="size-4" />Explore communities</Link></Button>
          </div>
        </section>
        <aside className="chat-home-card" aria-label="Serotine workspace status">
          <div className="chat-home-card-top"><span>WORKSPACE STATUS</span><span><CircleCheck className="size-3.5" /> READY</span></div>
          <div className="chat-home-orbit" aria-hidden="true"><span className="orbit-ring orbit-ring-one" /><span className="orbit-ring orbit-ring-two" /><span className="orbit-center"><LockKeyhole className="size-5" /></span><span className="orbit-node orbit-node-one" /><span className="orbit-node orbit-node-two" /><span className="orbit-node orbit-node-three" /></div>
          <p className="chat-home-card-title">A calmer inbox.</p>
          <p className="chat-home-card-copy">No feed, no algorithm. Just the conversations you choose to keep.</p>
          <div className="chat-home-card-bottom"><span><span className="chat-home-led" /> IDENTITY ON THIS DEVICE</span><span><Hash className="size-3" /> PRIVATE SPACE</span></div>
        </aside>
      </div>
      <div className="chat-home-notes mx-auto grid w-full max-w-6xl grid-cols-2 border-y border-border lg:mt-16">
        <div><span className="app-eyebrow">01 / PRIVATE BY DESIGN</span><p>Messages and shared files are encrypted on your device.</p></div>
        <div><span className="app-eyebrow">02 / KEEP IT TOGETHER</span><p>Save thoughts, links, and files in a conversation with yourself.</p></div>
      </div>
    </main>
  </div>
}
