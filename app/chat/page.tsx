export const runtime = 'edge';

import { Shield } from "lucide-react"

export default function ChatIndexPage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-8 text-center h-full">
      <Shield className="h-16 w-16 mb-6 text-zinc-800" />
      <h2 className="text-xl font-medium tracking-tight text-zinc-300 mb-2">Welcome to your secure terminal</h2>
      <p className="text-sm text-zinc-500 max-w-sm">
        Select a connection from the sidebar or manually enter a peer's Hex PubKey to initiate an end-to-end encrypted session.
      </p>
    </div>
  )
}
