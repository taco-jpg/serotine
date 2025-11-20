import { createClient } from '@/utils/supabase/server'
import { ProposalCard } from '@/components/governance/proposal-card'
import { CreateProposalDialog } from '@/components/governance/create-proposal-dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export default async function GroupsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  // Fetch proposals with vote counts
  const { data: proposals } = await supabase
    .from('proposals')
    .select(`
      *,
      author:profiles(username),
      votes(vote_type, voter_id)
    `)
    .order('created_at', { ascending: false })

  // Process proposals to add vote counts and user vote status
  const processedProposals = proposals?.map(p => ({
    ...p,
    votes_for: p.votes.filter((v: any) => v.vote_type === 'for').length,
    votes_against: p.votes.filter((v: any) => v.vote_type === 'against').length,
    user_vote: p.votes.find((v: any) => v.voter_id === user?.id)?.vote_type
  })) || []

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold font-serif tracking-tight">Governance</h1>
          <p className="text-muted-foreground">
            Vote on community proposals and shape the future of the network.
          </p>
        </div>
        <CreateProposalDialog />
      </div>

      <Tabs defaultValue="active" className="w-full">
        <TabsList className="bg-card/50 border border-border/50">
          <TabsTrigger value="active">Active Proposals</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="active" className="mt-6 space-y-6">
          {processedProposals.filter(p => p.status === 'active').length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No active proposals at the moment.
            </div>
          ) : (
            processedProposals
              .filter(p => p.status === 'active')
              .map(proposal => (
                <ProposalCard key={proposal.id} proposal={proposal} />
              ))
          )}
        </TabsContent>
        <TabsContent value="history" className="mt-6 space-y-6">
          {processedProposals
            .filter(p => p.status !== 'active')
            .map(proposal => (
              <ProposalCard key={proposal.id} proposal={proposal} />
            ))}
        </TabsContent>
      </Tabs>
    </div>
  )
}
