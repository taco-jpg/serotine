/* OLD!!
import Link from "next/link"
import { AppLogo } from "@/components/ui/app-logo"
import { Button } from "@/components/ui/button"
import { ModeToggle } from "@/components/mode-toggle"

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 max-w-screen-2xl items-center justify-between px-4">
        <Link href="/" className="flex items-center space-x-2">
          <AppLogo />
        </Link>
        <nav className="flex items-center gap-4">
          <ModeToggle />
          <Link href="/login">
            <Button variant="ghost" className="text-foreground hover:text-primary hover:bg-primary/10">
              Sign In
            </Button>
          </Link>
          <Link href="/login?view=signup">
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90">
              Get Started
            </Button>
          </Link>
        </nav>
      </div>
    </header>
  )
}
*/

import Link from "next/link"
import { AppLogo } from "@/components/ui/app-logo"
import { Button } from "@/components/ui/button"
import { ModeToggle } from "@/components/mode-toggle"

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 max-w-screen-2xl items-center px-4">
        
        {/* Left: Logo */}
        <Link href="/" className="flex items-center space-x-2">
          <AppLogo />
        </Link>

        {/* Right: Nav */}
        <nav className="ml-auto flex items-center gap-4 pr-2">
          <ModeToggle />

          <Link href="/login">
            <Button
              variant="ghost"
              className="text-foreground hover:text-primary hover:bg-primary/10"
            >
              Sign In
            </Button>
          </Link>

          <Link href="/login?view=signup">
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90">
              Get Started
            </Button>
          </Link>
        </nav>

      </div>
    </header>
  )
}
