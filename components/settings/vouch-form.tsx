"use client"

import type React from "react"

import { useState } from "react"
import { createClient } from "@/utils/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, CheckCircle2 } from "lucide-react"
import { toast } from "sonner"

export function VouchForm() {
  const [code, setCode] = useState("")
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const handleVouch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!code || code.length !== 8) {
      toast.error("Invalid code format")
      return
    }

    setLoading(true)
    const supabase = createClient()

    try {
      // Find device by code
      const { data: device, error: fetchError } = await supabase
        .from("devices")
        .select("*")
        .eq("vouch_code", code.toUpperCase())
        .single()

      if (fetchError || !device) {
        throw new Error("Device not found with this code")
      }

      // Mark as trusted
      const { error: updateError } = await supabase
        .from("devices")
        .update({ is_trusted: true, vouch_code: null }) // Clear code after use
        .eq("id", device.id)

      if (updateError) throw updateError

      setSuccess(true)
      setCode("")
      toast.success(`Successfully vouched for ${device.device_name}`)

      setTimeout(() => setSuccess(false), 3000)
    } catch (error: any) {
      toast.error(error.message || "Failed to vouch for device")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Vouch for a Friend</CardTitle>
        <CardDescription>
          Enter the 8-character verification code from your friend's new device to trust it.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleVouch} className="flex gap-4">
          <Input
            placeholder="ENTER CODE"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={8}
            className="font-mono uppercase tracking-widest"
          />
          <Button type="submit" disabled={loading || success}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : success ? (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            ) : (
              "Vouch"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
