"use client"

import { useEffect } from "react"
import { createClient } from "@/utils/supabase/client"

export function CoverTraffic() {
  useEffect(() => {
    const supabase = createClient()

    // Generate fake traffic every 15-30 seconds
    const interval = setInterval(async () => {
      const delay = Math.random() * 15000 + 15000 // 15-30s

      // In a real app, we would send dummy encrypted messages to random IDs
      // For this demo, we'll just log it to simulate the activity
      console.log("[Serotine] Generating cover traffic packet...", new Date().toISOString())

      // We could actually insert a dummy row into a 'signals' table if we wanted to be more realistic
      // but for now, client-side simulation is sufficient to show the intent
    }, 20000)

    return () => clearInterval(interval)
  }, [])

  return null // Invisible component
}
