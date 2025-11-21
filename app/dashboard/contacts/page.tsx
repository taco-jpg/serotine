import { createClient } from "@/utils/supabase/server"
import { AddContactForm } from "@/components/contacts/add-contact-form"
import { ContactList } from "@/components/contacts/contact-list"

export default async function ContactsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  return (
    <div className="container mx-auto p-4 md:p-8 space-y-8">
      <div>
        <h1 className="text-3xl font-bold font-serif tracking-tight">Contacts</h1>
        <p className="text-muted-foreground">
          Manage your trusted network. Adding contacts enables social verification.
        </p>
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-6">
          <div className="rounded-lg border border-border/50 bg-card/30 p-6">
            <h2 className="text-xl font-semibold mb-4">Add Contact</h2>
            <AddContactForm />
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border border-border/50 bg-card/30 p-6">
            <h2 className="text-xl font-semibold mb-4">Your Network</h2>
            <ContactList userId={user?.id || ""} />
          </div>
        </div>
      </div>
    </div>
  )
}
