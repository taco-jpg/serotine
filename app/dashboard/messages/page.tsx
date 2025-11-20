import { createClient } from '@/utils/supabase/server'
import { ChatInterface } from '@/components/chat/chat-interface'
import { redirect } from 'next/navigation'

export default async function MessagesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  // For this demo, we'll use a static global room ID
  // In a real app, this would be dynamic based on the selected group/chat
  const GLOBAL_ROOM_ID = 'global-shadow-room'

  return (
    <div className="container mx-auto p-4 md:p-8 h-full">
      <div className="mb-6">
        <h1 className="text-3xl font-bold font-serif tracking-tight">Encrypted Comms</h1>
        <p className="text-muted-foreground">
          Direct P2P connection established. Messages are not stored on any server.
        </p>
      </div>
      
      <ChatInterface 
        roomId={GLOBAL_ROOM_ID} 
        userId={user.id}
      />
    </div>
  )
}
