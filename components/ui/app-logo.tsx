import { cn } from "@/lib/utils"

export function AppLogo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="w-8 h-8 text-primary"
      >
        <path d="M2 12s3-1 5-3 2-4 5-4 3 2 5 4 5 3 5 3-3 2-5 2-2 3-5 3-3-3-5-3-2 0-5-2z" />
        <path d="M12 12v.01" />
      </svg>
      <span className="font-serif text-xl font-bold tracking-widest text-foreground">SEROTINE</span>
    </div>
  )
}
