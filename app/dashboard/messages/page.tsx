import { createClient } from "@/utils/supabase/server"
import { ChatInterface } from "@/components/chat/chat-interface"
import { CreateGroupDialog } from "@/components/chat/create-group-dialog"
import { redirect } from "next/navigation"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { MessageSquare, Users } from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ groupId?: string }>
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { groupId: selectedGroupId } = await searchParams

  // Fetch user's groups
  const { data: groups } = await supabase
    .from("chat_groups")
    .select(`
      *,
      chat_group_members!inner(user_id)
    `)
    .eq("chat_group_members.user_id", user.id)
    .order("created_at", { ascending: false })

  const selectedGroup = groups?.find((g) => g.id === selectedGroupId)

  return (
    <div className="container mx-auto p-4 md:p-8 h-[calc(100vh-4rem)] flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold font-serif tracking-tight">Encrypted Comms</h1>
          <p className="text-muted-foreground">End-to-End Encrypted P2P Chat</p>
        </div>
        <CreateGroupDialog />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 flex-1 min-h-0">
        {/* Sidebar - Group List */}
        <Card
          className={cn(
            "md:col-span-1 flex flex-col overflow-hidden border-border/50 bg-card/30 backdrop-blur-sm",
            selectedGroupId ? "hidden md:flex" : "flex",
          )}
        >
          <CardHeader className="pb-4">
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="h-5 w-5" />
              Groups
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto p-2 space-y-2">
            {groups?.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No groups yet. Create one to start chatting.
              </div>
            ) : (
              groups?.map((group) => (
                <Link key={group.id} href={`/dashboard/messages?groupId=${group.id}`} className="block">
                  <Button
                    variant={selectedGroupId === group.id ? "secondary" : "ghost"}
                    className="w-full justify-start gap-3 h-auto py-3"
                  >
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <MessageSquare className="h-5 w-5 text-primary" />
                    </div>
                    <div className="text-left overflow-hidden">
                      <div className="font-medium truncate">{group.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {new Date(group.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  </Button>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        {/* Main Chat Area */}
        <div className={cn("md:col-span-3 flex flex-col min-h-0", selectedGroupId ? "flex" : "hidden md:flex")}>
          {selectedGroupId ? (
            <ChatInterface
              key={selectedGroupId} // Force remount on group change
              roomId={selectedGroupId}
              userId={user.id}
              userName={user.user_metadata.full_name || user.email?.split("@")[0] || "Anonymous"}
              groupName={selectedGroup?.name}
            />
          ) : (
            <Card className="flex-1 flex items-center justify-center border-border/50 bg-card/30 backdrop-blur-sm">
              <div className="text-center space-y-4 p-8">
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
                  <MessageSquare className="h-8 w-8 text-primary" />
                </div>
                <div>
                  <h3 className="text-xl font-semibold">Select a Group</h3>
                  <p className="text-muted-foreground mt-2">
                    Choose a group from the sidebar or create a new one to start chatting.
                  </p>
                </div>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
