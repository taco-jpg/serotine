import ChatClient from './chat-client'
import { parseConversationAddress } from '@/lib/conversation-route'
import { notFound } from 'next/navigation'

export default async function Page({ params }: { params: Promise<{ pubkey: string }> }) {
  const { pubkey } = await params
  const address = parseConversationAddress(pubkey)
  if (!address) notFound()
  return <ChatClient key={address} params={{ pubkey: address }} />
}
