import Link from "next/link"
import { AppLogo } from "@/components/ui/app-logo"
import { Button } from "@/components/ui/button"
import { ModeToggle } from "@/components/mode-toggle"

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/80 bg-card/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center gap-3 px-4">
        <Link href="/" className="flex items-center gap-2">
          <AppLogo />
        </Link>
        <nav aria-label="Main navigation" className="ml-auto flex items-center gap-2">
          <ModeToggle />
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign In</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/login?view=signup">Get Started</Link>
          </Button>
        </nav>
      </div>
    </header>
  )
}
