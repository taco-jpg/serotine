import { cn } from "@/lib/utils"

export function AppLogo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-8 h-8 text-primary"
      >
        {/* Updated logo to a designed "S" shape */}
        <path d="M4 11a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4H8a4 4 0 0 0-4 4v1a4 4 0 0 0 4 4h8a4 4 0 0 0 4-4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
      </svg>
      <span className="font-serif text-xl font-bold tracking-widest text-foreground">SEROTINE</span>
    </div>
  )
}
