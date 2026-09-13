import Link from "next/link"
import { AppLogo } from "@/components/ui/app-logo"
import { Button } from "@/components/ui/button"
import { ModeToggle } from "@/components/mode-toggle"

export function SiteHeader() {
  return (
    <header className="app-surface sticky top-0 z-50 w-full border-b border-border bg-background">
      <div className="mx-auto flex min-h-18 max-w-screen-2xl flex-wrap items-center gap-3 px-5 py-3 sm:px-8">
        <Link href="/" aria-label="Serotine home" className="flex min-h-11 items-center gap-2">
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
