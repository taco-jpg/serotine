import { createClient } from "@/utils/supabase/server"
import { redirect } from "next/navigation"
import { SettingsForm } from "@/components/settings/settings-form"
import { VouchForm } from "@/components/settings/vouch-form" // Import VouchForm

export default async function SettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single()

  return (
    <div className="container max-w-2xl py-8">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
          <p className="text-muted-foreground mt-2">Manage your account settings and preferences</p>
        </div>

        <SettingsForm profile={profile} userEmail={user.email || ""} />

        <div className="pt-6 border-t">
          <h2 className="text-xl font-semibold mb-4">Trust Network</h2>
          <VouchForm />
        </div>
      </div>
    </div>
  )
}
