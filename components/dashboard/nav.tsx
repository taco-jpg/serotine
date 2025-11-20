'use client'

import Link from "next/link"
import { usePathname } from 'next/navigation'
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { AppLogo } from "@/components/ui/app-logo"
import { createClient } from "@/utils/supabase/client"
import { useRouter } from 'next/navigation'
import { LayoutDashboard, MessageSquare, Users, Settings, LogOut, Shield } from 'lucide-react'

export function DashboardNav() {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const links = [
    { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
    { href: "/dashboard/messages", label: "Messages", icon: MessageSquare },
    { href: "/dashboard/groups", label: "Groups", icon: Users },
    { href: "/dashboard/settings", label: "Settings", icon: Settings },
  ]

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-20 items-center px-6 border-b border-border/40 bg-card/10">
        <Link href="/dashboard" className="transition-transform hover:scale-105">
          <AppLogo />
        </Link>
      </div>
      
      <div className="flex-1 py-8 px-4 space-y-2">
        <div className="mb-6 px-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-2">
            Navigation
          </p>
        </div>
        {links.map((link) => {
          const Icon = link.icon
          const isActive = pathname === link.href
          return (
            <Link key={link.href} href={link.href}>
              <Button
                variant="ghost"
                className={cn(
                  "w-full justify-start gap-3 mb-1 transition-all duration-200",
                  isActive 
                    ? "bg-primary/15 text-primary font-medium border-r-2 border-primary rounded-r-none rounded-l-md" 
                    : "text-muted-foreground hover:text-primary hover:bg-primary/5"
                )}
              >
                <Icon className={cn("h-4 w-4", isActive && "animate-pulse")} />
                {link.label}
              </Button>
            </Link>
          )
        })}
      </div>

      <div className="p-4 mt-auto">
        <div className="rounded-lg bg-card/30 border border-border/50 p-4 mb-4">
          <div className="flex items-center gap-3 mb-2">
            <div className="h-8 w-8 rounded-full bg-green-500/10 flex items-center justify-center">
              <Shield className="h-4 w-4 text-green-500" />
            </div>
            <div>
              <p className="text-xs font-medium">Encrypted</p>
              <p className="text-[10px] text-muted-foreground">Connection Secure</p>
            </div>
          </div>
        </div>
        
        <Button 
          variant="ghost" 
          className="w-full justify-start gap-3 text-muted-foreground hover:text-destructive hover:bg-destructive/10 border border-transparent hover:border-destructive/20"
          onClick={handleSignOut}
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </Button>
      </div>
    </div>
  )
}
