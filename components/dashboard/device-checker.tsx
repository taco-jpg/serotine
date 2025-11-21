"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { useDevice } from "@/hooks/use-device"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, ShieldAlert, QrCode } from "lucide-react"
import { createClient } from "@/utils/supabase/client"

export function DeviceChecker({ children }: { children: React.ReactNode }) {
  const { deviceInfo, loading, registerDevice } = useDevice()
  const [deviceName, setDeviceName] = useState("")
  const [registering, setRegistering] = useState(false)
  const [vouchCode, setVouchCode] = useState<string | null>(null)
  const [isTrusted, setIsTrusted] = useState(false)

  useEffect(() => {
    if (!deviceName) {
      const platform = navigator.platform
      const browser = navigator.userAgent.includes("Chrome")
        ? "Chrome"
        : navigator.userAgent.includes("Firefox")
          ? "Firefox"
          : navigator.userAgent.includes("Safari")
            ? "Safari"
            : "Browser"
      setDeviceName(`${browser} on ${platform}`)
    }
  }, [])

  useEffect(() => {
    if (deviceInfo?.isRegistered && !deviceInfo.isTrusted) {
      const supabase = createClient()
      const channel = supabase
        .channel(`device:${deviceInfo.deviceId}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "devices",
            filter: `device_id=eq.${deviceInfo.deviceId}`,
          },
          (payload) => {
            if (payload.new.is_trusted) {
              setIsTrusted(true)
              window.location.reload()
            }
          },
        )
        .subscribe()

      return () => {
        supabase.removeChannel(channel)
      }
    }
  }, [deviceInfo])

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!deviceName) return

    setRegistering(true)
    try {
      const code = Math.random().toString(36).substring(2, 10).toUpperCase()
      setVouchCode(code)
      await registerDevice(deviceName, code)
    } catch (error) {
      // Error handled in hook
    } finally {
      setRegistering(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  if (deviceInfo?.isRegistered && !deviceInfo.isTrusted && !isTrusted) {
    return (
      <div className="flex h-screen items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-md border-primary/20 bg-card/50 backdrop-blur-xl">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-yellow-500/10">
              <QrCode className="h-6 w-6 text-yellow-500" />
            </div>
            <CardTitle className="text-xl font-serif">Device Verification Required</CardTitle>
            <CardDescription>
              This device is registered but not yet trusted. Ask a friend to vouch for you using this code.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6 text-center">
            <div className="p-6 bg-muted/50 rounded-lg border border-border/50">
              <p className="text-sm text-muted-foreground mb-2">Verification Code</p>
              <p className="text-4xl font-mono font-bold tracking-widest text-primary">
                {deviceInfo.vouchCode || vouchCode || "PENDING"}
              </p>
            </div>
            <div className="text-sm text-muted-foreground">
              <p>1. Go to Settings on a trusted device</p>
              <p>2. Select "Vouch for Friend"</p>
              <p>3. Enter the code above</p>
            </div>
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground animate-pulse">
              <Loader2 className="h-3 w-3 animate-spin" />
              Waiting for approval...
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!deviceInfo || !deviceInfo.isRegistered) {
    return (
      <div className="flex h-screen items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-md border-primary/20 bg-card/50 backdrop-blur-xl">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
              <ShieldAlert className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl font-serif">New Device Detected</CardTitle>
            <CardDescription>
              This device is not yet part of your secure network. Register it to continue.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleRegister} className="space-y-4">
              <div className="space-y-2">
                <Input
                  placeholder="Device Name (e.g. MacBook Pro)"
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  className="bg-background/50"
                />
              </div>
              <Button type="submit" className="w-full bg-primary hover:bg-primary/90" disabled={registering}>
                {registering ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Securing Device...
                  </>
                ) : (
                  "Register Device"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    )
  }

  return <>{children}</>
}
