'use client'

import { useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Badge } from "@/components/ui/badge"
import { ThumbsUp, ThumbsDown, Clock, CheckCircle2, XCircle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { cn } from "@/lib/utils"

interface Proposal {
  id: string
  title: string
  description: string
  status: 'active' | 'passed' | 'rejected'
  expires_at: string
  created_at: string
  author: {
    username: string
  }
  votes_for: number
  votes_against: number
  user_vote?: 'for' | 'against'
}

export function ProposalCard({ proposal }: { proposal: Proposal }) {
  const [voting, setVoting] = useState(false)
  const [currentProposal, setCurrentProposal] = useState(proposal)
  const supabase = createClient()

  const totalVotes = currentProposal.votes_for + currentProposal.votes_against
  const forPercentage = totalVotes > 0 ? (currentProposal.votes_for / totalVotes) * 100 : 0

  const handleVote = async (voteType: 'for' | 'against') => {
    setVoting(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return

      // Optimistic update
      setCurrentProposal(prev => ({
        ...prev,
        user_vote: voteType,
        votes_for: voteType === 'for' ? prev.votes_for + 1 : prev.votes_for,
        votes_against: voteType === 'against' ? prev.votes_against + 1 : prev.votes_against
      }))

      const { error } = await supabase
        .from('votes')
        .upsert({
          proposal_id: proposal.id,
          voter_id: user.id,
          vote_type: voteType
        })

      if (error) throw error
    } catch (error) {
      console.error('Error voting:', error)
      // Revert optimistic update (simplified)
      setCurrentProposal(proposal)
    } finally {
      setVoting(false)
    }
  }

  const isExpired = new Date(proposal.expires_at) < new Date()

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm transition-all hover:border-primary/30">
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="font-serif text-xl">{proposal.title}</CardTitle>
            <CardDescription>
              Proposed by {proposal.author?.username || 'Anonymous'} • {formatDistanceToNow(new Date(proposal.created_at))} ago
            </CardDescription>
          </div>
          <Badge 
            variant={proposal.status === 'active' ? 'outline' : proposal.status === 'passed' ? 'default' : 'destructive'}
            className={cn(
              proposal.status === 'active' && "border-primary/50 text-primary",
              proposal.status === 'passed' && "bg-green-500/20 text-green-500 hover:bg-green-500/30",
              proposal.status === 'rejected' && "bg-destructive/20 text-destructive hover:bg-destructive/30"
            )}
          >
            {proposal.status.toUpperCase()}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground leading-relaxed">
          {proposal.description}
        </p>
        
        <div className="space-y-2">
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Approval Rating</span>
            <span>{forPercentage.toFixed(1)}%</span>
          </div>
          <Progress value={forPercentage} className="h-2 bg-secondary" />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1"><ThumbsUp className="h-3 w-3" /> {currentProposal.votes_for}</span>
            <span className="flex items-center gap-1"><ThumbsDown className="h-3 w-3" /> {currentProposal.votes_against}</span>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-between border-t border-border/40 pt-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {isExpired ? 'Expired' : `Ends ${formatDistanceToNow(new Date(proposal.expires_at), { addSuffix: true })}`}
        </div>
        
        {proposal.status === 'active' && !isExpired && (
          <div className="flex gap-2">
            <Button 
              size="sm" 
              variant={currentProposal.user_vote === 'against' ? 'destructive' : 'outline'}
              className={cn(
                "gap-2",
                currentProposal.user_vote === 'against' && "bg-destructive/20 text-destructive border-destructive/50"
              )}
              onClick={() => handleVote('against')}
              disabled={voting}
            >
              <ThumbsDown className="h-4 w-4" />
              Reject
            </Button>
            <Button 
              size="sm" 
              variant={currentProposal.user_vote === 'for' ? 'default' : 'outline'}
              className={cn(
                "gap-2",
                currentProposal.user_vote === 'for' 
                  ? "bg-green-500/20 text-green-500 border-green-500/50 hover:bg-green-500/30" 
                  : "hover:bg-green-500/10 hover:text-green-500 hover:border-green-500/50"
              )}
              onClick={() => handleVote('for')}
              disabled={voting}
            >
              <ThumbsUp className="h-4 w-4" />
              Approve
            </Button>
          </div>
        )}
      </CardFooter>
    </Card>
  )
}
