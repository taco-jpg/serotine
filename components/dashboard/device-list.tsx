'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Laptop, Smartphone, ShieldCheck, ShieldAlert, Trash2 } from 'lucide-react'
import { Button } from "@/components/ui/button"
import { formatDistanceToNow } from 'date-fns'

interface Device {
  id: string
  device_name: string
  last_seen: string
  is_trusted: boolean
  device_id: string
}

export function DeviceList() {
  const [devices, setDevices] = useState<Device[]>([])
  const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(null)
  const supabase = createClient()

  useEffect(() => {
    setCurrentDeviceId(localStorage.getItem('serotine_device_id'))
    fetchDevices()
  }, [])

  const fetchDevices = async () => {
    const { data } = await supabase
      .from('devices')
      .select('*')
      .order('last_seen', { ascending: false })
    
    if (data) setDevices(data)
  }

  const deleteDevice = async (id: string) => {
    await supabase.from('devices').delete().eq('id', id)
    fetchDevices()
  }

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="font-serif">Active Devices</CardTitle>
        <CardDescription>Manage the devices that have access to your account</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {devices.map((device) => (
            <div
              key={device.id}
              className="flex items-center justify-between rounded-lg border border-border/50 p-4 transition-colors hover:bg-accent/5"
            >
              <div className="flex items-center gap-4">
                <div className="rounded-full bg-primary/10 p-2">
                  {device.device_name.toLowerCase().includes('mobile') ? (
                    <Smartphone className="h-5 w-5 text-primary" />
                  ) : (
                    <Laptop className="h-5 w-5 text-primary" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{device.device_name}</p>
                    {device.device_id === currentDeviceId && (
                      <Badge variant="secondary" className="text-xs">Current</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>Last seen {formatDistanceToNow(new Date(device.last_seen))} ago</span>
                    {device.is_trusted ? (
                      <span className="flex items-center gap-1 text-green-500">
                        <ShieldCheck className="h-3 w-3" /> Trusted
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 text-yellow-500">
                        <ShieldAlert className="h-3 w-3" /> Untrusted
                      </span>
                    )}
                  </div>
                </div>
              </div>
              {device.device_id !== currentDeviceId && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => deleteDevice(device.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
