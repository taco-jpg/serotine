export const runtime = 'edge'

import ChatLayoutClient from './layout-client'

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  return <ChatLayoutClient>{children}</ChatLayoutClient>
}
