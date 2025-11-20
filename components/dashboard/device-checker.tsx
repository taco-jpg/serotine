'use client'

import { useState, useEffect } from 'react'
import { useDevice } from '@/hooks/use-device'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Loader2, Laptop, ShieldAlert } from 'lucide-react'

export function DeviceChecker({ children }: { children: React.ReactNode }) {
  const { deviceInfo, loading, registerDevice } = useDevice()
  const [deviceName, setDeviceName] = useState('')
  const [registering, setRegistering] = useState(false)

  useEffect(() => {
    // Auto-generate a device name based on browser/OS
    if (!deviceName) {
      const platform = navigator.platform
      const browser = navigator.userAgent.includes('Chrome') ? 'Chrome' : 
                      navigator.userAgent.includes('Firefox') ? 'Firefox' : 
                      navigator.userAgent.includes('Safari') ? 'Safari' : 'Browser'
      setDeviceName(`${browser} on ${platform}`)
    }
  }, [])

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!deviceName) return
    
    setRegistering(true)
    try {
      await registerDevice(deviceName)
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
                  'Register Device'
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
