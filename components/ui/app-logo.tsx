import { cn } from "@/lib/utils"

function SerotineIcon({ className }: { className?: string }) {
  const nodes = [
    { cx: 18, cy: 5 },
    { cx: 4, cy: 29 },
    { cx: 32, cy: 29 },
  ]
  const edges: [number, number][] = [[0, 1], [0, 2], [1, 2]]

  return (
    <svg
      width="36" height="36" viewBox="0 0 36 36"
      fill="none" xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {edges.map(([a, b], i) => (
        <line
          key={i}
          x1={nodes[a].cx} y1={nodes[a].cy}
          x2={nodes[b].cx} y2={nodes[b].cy}
          stroke="currentColor" strokeOpacity="0.25"
          strokeWidth="1.5" strokeLinecap="round"
        />
      ))}
      {nodes.map((n, i) => (
        <g key={i}>
          <circle cx={n.cx} cy={n.cy} r="5.5"
            fill="rgb(110 231 183)" fillOpacity="0.15" />
          <circle cx={n.cx} cy={n.cy} r="3"
            fill="rgb(110 231 183)" fillOpacity="0.9" />
        </g>
      ))}
    </svg>
  )
}

export function AppLogo({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <SerotineIcon />
      <span className="font-syne text-[18px] font-extrabold tracking-[0.18em] text-foreground">
        Serotine
      </span>
    </div>
  )
}
