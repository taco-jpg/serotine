import { cn } from "@/lib/utils"

// The same geometric mark and wordmark used on the landing page.
export function AppLogo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-2.5", className)}>
      <svg className="size-8 shrink-0 text-primary" viewBox="0 0 36 36" fill="none" aria-hidden="true" focusable="false">
        <path d="M27 7H14L5 16h17l-9 13H4M32 7l-9 13H10l-5 9M14 7l-9 9M22 16l-9 13h14l5-9" stroke="currentColor" strokeWidth="2.3" strokeLinejoin="round" />
      </svg>
      <span className={compact ? "sr-only" : "text-[25px] font-semibold leading-none tracking-[-0.06em] text-foreground"}>
        serotine<span className="text-primary">.</span>
      </span>
    </span>
  )
}
