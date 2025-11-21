"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/utils/supabase/client"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"

interface Contact {
  id: string
  friend: {
    username: string
    full_name: string | null
    avatar_url: string | null
  }
}

export function ContactList({ userId }: { userId: string }) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    fetchContacts()
  }, [])

  const fetchContacts = async () => {
    try {
      const { data, error } = await supabase
        .from("friends")
        .select(`
          id,
          friend:profiles!friend_id(username, full_name, avatar_url)
        `)
        .eq("user_id", userId)
        .eq("status", "accepted")

      if (error) throw error
      setContacts(data as any)
    } catch (error) {
      console.error("Error fetching contacts:", error)
    } finally {
      setLoading(false)
    }
  }

  const removeContact = async (id: string) => {
    try {
      const { error } = await supabase.from("friends").delete().eq("id", id)
      if (error) throw error
      setContacts(contacts.filter((c) => c.id !== id))
      toast.success("Contact removed")
    } catch (error) {
      toast.error("Failed to remove contact")
    }
  }

  if (loading) return <div className="text-sm text-muted-foreground">Loading contacts...</div>

  if (contacts.length === 0) {
    return <div className="text-sm text-muted-foreground">No contacts yet. Add someone to get started.</div>
  }

  return (
    <div className="space-y-4">
      {contacts.map((contact) => (
        <div
          key={contact.id}
          className="flex items-center justify-between p-3 rounded-md bg-background/50 border border-border/50"
        >
          <div className="flex items-center gap-3">
            <Avatar>
              <AvatarImage src={contact.friend.avatar_url || undefined} />
              <AvatarFallback>{contact.friend.username[0].toUpperCase()}</AvatarFallback>
            </Avatar>
            <div>
              <p className="font-medium">{contact.friend.full_name || contact.friend.username}</p>
              <p className="text-xs text-muted-foreground">@{contact.friend.username}</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={() => removeContact(contact.id)}>
            <Trash2 className="h-4 w-4 text-muted-foreground hover:text-destructive" />
          </Button>
        </div>
      ))}
    </div>
  )
}
