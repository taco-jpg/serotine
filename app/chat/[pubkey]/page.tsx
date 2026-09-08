import ChatClient from './chat-client'
import { PUBLIC_KEY_PATTERN } from '@/lib/protocol'
import { notFound } from 'next/navigation'

export default async function Page({ params }: { params: Promise<{ pubkey: string }> }) {
  const { pubkey } = await params
  const address = pubkey.toLowerCase()
  if (!PUBLIC_KEY_PATTERN.test(address)) notFound()
  return <ChatClient key={address} params={{ pubkey: address }} />
}
