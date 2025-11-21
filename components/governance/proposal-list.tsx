"use client"

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { voteOnProposal } from "@/app/actions"
import { useToast } from "@/hooks/use-toast"

export function ProposalList({ proposals, userId }: { proposals: any[]; userId: string }) {
  const { toast } = useToast()

  const handleVote = async (proposalId: string, voteType: "for" | "against") => {
    try {
      await voteOnProposal(proposalId, voteType)
      toast({ title: "Vote recorded" })
    } catch (error) {
      toast({ title: "Error voting", variant: "destructive" })
    }
  }

  if (proposals.length === 0) {
    return <div className="text-center text-muted-foreground py-8">No active proposals</div>
  }

  return (
    <div className="space-y-4">
      {proposals.map((proposal) => {
        const votesFor = proposal.votes.filter((v: any) => v.vote_type === "for").length
        const votesAgainst = proposal.votes.filter((v: any) => v.vote_type === "against").length
        const totalVotes = votesFor + votesAgainst
        const userVote = proposal.votes.find((v: any) => v.voter_id === userId)?.vote_type

        return (
          <Card key={proposal.id}>
            <CardHeader>
              <div className="flex justify-between items-start">
                <div>
                  <CardTitle className="text-lg">{proposal.title}</CardTitle>
                  <div className="flex gap-2 mt-2">
                    <Badge variant="outline">{proposal.type}</Badge>
                    <Badge variant={proposal.status === "active" ? "default" : "secondary"}>{proposal.status}</Badge>
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">
                  by {proposal.author?.nickname || proposal.author?.username}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm">{proposal.description}</p>

              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>For: {votesFor}</span>
                  <span>Against: {votesAgainst}</span>
                </div>
                <Progress value={totalVotes > 0 ? (votesFor / totalVotes) * 100 : 0} />
              </div>
            </CardContent>
            <CardFooter className="gap-2">
              {proposal.status === "active" && (
                <>
                  <Button
                    variant={userVote === "for" ? "default" : "outline"}
                    className="flex-1"
                    onClick={() => handleVote(proposal.id, "for")}
                    disabled={userVote === "for"}
                  >
                    Vote For
                  </Button>
                  <Button
                    variant={userVote === "against" ? "destructive" : "outline"}
                    className="flex-1"
                    onClick={() => handleVote(proposal.id, "against")}
                    disabled={userVote === "against"}
                  >
                    Vote Against
                  </Button>
                </>
              )}
            </CardFooter>
          </Card>
        )
      })}
    </div>
  )
}
