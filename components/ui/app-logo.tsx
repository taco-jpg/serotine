import { cn } from "@/lib/utils"

/** Compact, high-contrast mark and wordmark shared by the public and app surfaces. */
export function AppLogo({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-2.5", className)}>
      <svg className="size-8 shrink-0" viewBox="0 0 36 36" fill="none" aria-hidden="true" focusable="false">
        <rect x="1" y="1" width="34" height="34" rx="11" fill="currentColor" />
        <path d="M23.2 11.1c-1.45-1.47-3.42-2.2-5.77-2.2-3.55 0-6.15 1.94-6.15 4.8 0 2.68 2.03 3.81 5.84 4.65 3.55.78 5.72 1.55 5.72 4.05 0 2.91-2.48 4.7-6.05 4.7-2.58 0-4.94-.98-6.73-2.8" stroke="var(--primary-foreground)" strokeWidth="2.05" strokeLinecap="round" />
        <path d="M9.3 25.9 6.8 29.1" stroke="var(--primary-foreground)" strokeWidth="2.05" strokeLinecap="round" />
      </svg>
      <span className={compact ? "sr-only" : "text-[23px] font-semibold leading-none tracking-[-0.065em] text-foreground"}>
        serotine<span className="text-primary">.</span>
      </span>
    </span>
  )
}
