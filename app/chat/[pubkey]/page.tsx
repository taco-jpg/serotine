import ChatClient from './chat-client'
import { PUBLIC_KEY_PATTERN } from '@/lib/protocol'
import { notFound } from 'next/navigation'

export default async function Page({ params }: { params: Promise<{ pubkey: string }> }) {
  const { pubkey } = await params
  const address = pubkey.toLowerCase()
  if (!PUBLIC_KEY_PATTERN.test(address) && !/^group:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(address)) notFound()
  return <ChatClient key={address} params={{ pubkey: address }} />
}
