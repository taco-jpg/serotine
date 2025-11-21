import { createBrowserClient } from "@supabase/ssr"

export function createClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    console.warn("Supabase credentials missing in client")
    throw new Error("Supabase credentials missing. Please check your environment variables.")
  }

  return createBrowserClient(supabaseUrl, supabaseKey)
}
