"use client"

import type React from "react"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { UserPlus, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { addMemberToGroup } from "@/app/actions"

export function AddMemberForm({ groupId }: { groupId: string }) {
  const [username, setUsername] = useState("")
  const [loading, setLoading] = useState(false)

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) return

    setLoading(true)
    try {
      const result = await addMemberToGroup(groupId, username)
      if (result.error) {
        toast.error(result.error)
      } else {
        toast.success("Member added successfully")
        setUsername("")
      }
    } catch (error) {
      toast.error("An unexpected error occurred")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Add Member</CardTitle>
        <CardDescription>Add a new user to this group chat.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleAddMember} className="flex gap-2">
          <div className="grid w-full items-center gap-1.5">
            <Label htmlFor="member-username" className="sr-only">
              Username
            </Label>
            <Input
              id="member-username"
              placeholder="Enter username..."
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            <span className="sr-only">Add</span>
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
