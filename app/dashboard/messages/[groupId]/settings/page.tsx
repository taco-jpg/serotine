import { createClient } from "@/utils/supabase/server"
import { redirect } from "next/navigation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ArrowLeft, Shield } from "lucide-react"
import Link from "next/link"
import { ProposalList } from "@/components/governance/proposal-list"
import { CreateGroupProposal } from "@/components/governance/create-group-proposal"
import { AddMemberForm } from "@/components/chat/add-member-form"

export default async function GroupSettingsPage({
  params,
}: {
  params: Promise<{ groupId: string }>
}) {
  const { groupId } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  // Fetch group details
  const { data: group } = await supabase.from("chat_groups").select("*").eq("id", groupId).single()

  if (!group) redirect("/dashboard/messages")

  const isCreator = group.created_by === user.id

  // Fetch group proposals
  const { data: proposals } = await supabase
    .from("proposals")
    .select(`
      *,
      author:profiles(username, nickname),
      votes(vote_type, voter_id)
    `)
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })

  return (
    <div className="container max-w-4xl py-8 space-y-8">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href={`/dashboard/messages?groupId=${groupId}`}>
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{group.name} Governance</h1>
          <p className="text-muted-foreground">Decentralized management for this group</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Quorum Threshold</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{group.quorum_percentage}%</div>
            <p className="text-xs text-muted-foreground">Required participation</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Last Change</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm font-medium">
              {group.last_quorum_change ? new Date(group.last_quorum_change).toLocaleDateString() : "Never"}
            </div>
            <p className="text-xs text-muted-foreground">Quorum update history</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Security</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 text-sm font-medium text-green-500">
              <Shield className="h-4 w-4" />
              Decentralized
            </div>
            <p className="text-xs text-muted-foreground">No admin privileges</p>
          </CardContent>
        </Card>
      </div>

      {isCreator && (
        <div className="grid gap-6">
          <h2 className="text-xl font-semibold">Management</h2>
          <div className="grid gap-6 md:grid-cols-2">
            <AddMemberForm groupId={groupId} />
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Proposals</h2>
        <CreateGroupProposal groupId={groupId} currentQuorum={group.quorum_percentage} />
      </div>

      <ProposalList proposals={proposals || []} userId={user.id} />
    </div>
  )
}
