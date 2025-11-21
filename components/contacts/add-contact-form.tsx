"use client"

import type React from "react"

import { useState } from "react"
import { createClient } from "@/utils/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { UserPlus, Loader2 } from "lucide-react"
import { toast } from "sonner"

export function AddContactForm() {
  const [username, setUsername] = useState("")
  const [loading, setLoading] = useState(false)
  const supabase = createClient()

  const handleAddContact = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) return

    setLoading(true)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) throw new Error("Not authenticated")

      // Find user by username
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id")
        .eq("username", username)
        .single()

      if (profileError || !profile) {
        toast.error("User not found")
        return
      }

      if (profile.id === user.id) {
        toast.error("You cannot add yourself")
        return
      }

      // Add friend request
      const { error } = await supabase.from("friends").insert({
        user_id: user.id,
        friend_id: profile.id,
        status: "accepted", // Auto-accept for demo simplicity, normally 'pending'
      })

      if (error) {
        if (error.code === "23505") {
          toast.error("Contact already added")
        } else {
          throw error
        }
      } else {
        toast.success("Contact added successfully")
        setUsername("")
        // Refresh page to show new contact
        window.location.reload()
      }
    } catch (error) {
      console.error("Error adding contact:", error)
      toast.error("Failed to add contact")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleAddContact} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="username">Username</Label>
        <div className="flex gap-2">
          <Input
            id="username"
            placeholder="Enter username..."
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <Button type="submit" disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </form>
  )
}
