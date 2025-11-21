"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { createGroupProposal } from "@/app/actions"
import { useToast } from "@/hooks/use-toast"
import { Plus } from "lucide-react"

export function CreateGroupProposal({ groupId, currentQuorum }: { groupId: string; currentQuorum: number }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState("general")
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [targetUser, setTargetUser] = useState("")
  const [newQuorum, setNewQuorum] = useState(currentQuorum.toString())
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await createGroupProposal({
        groupId,
        type,
        title,
        description,
        targetUserId: targetUser || undefined,
        newQuorum: type === "change_quorum" ? Number.parseInt(newQuorum) : undefined,
      })
      setOpen(false)
      toast({ title: "Proposal created successfully" })
    } catch (error) {
      toast({ title: "Error creating proposal", variant: "destructive" })
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          New Proposal
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Proposal</DialogTitle>
          <DialogDescription>Propose a change to the group. Voting lasts 24 hours.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label>Type</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="general">General</SelectItem>
                <SelectItem value="add_member">Add Member</SelectItem>
                <SelectItem value="remove_member">Remove Member</SelectItem>
                <SelectItem value="change_quorum">Change Quorum</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>

          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} required />
          </div>

          {(type === "add_member" || type === "remove_member") && (
            <div className="space-y-2">
              <Label>Target Username</Label>
              <Input
                value={targetUser}
                onChange={(e) => setTargetUser(e.target.value)}
                placeholder="Enter username"
                required
              />
            </div>
          )}

          {type === "change_quorum" && (
            <div className="space-y-2">
              <Label>New Quorum %</Label>
              <Input
                type="number"
                min="1"
                max="100"
                value={newQuorum}
                onChange={(e) => setNewQuorum(e.target.value)}
                required
              />
            </div>
          )}

          <Button type="submit" className="w-full">
            Submit Proposal
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
