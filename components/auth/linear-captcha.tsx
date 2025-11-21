"use client"

import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { RefreshCw, CheckCircle2, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

interface LinearCaptchaProps {
  onVerify: (isValid: boolean) => void
  className?: string
}

interface Equation {
  m: number
  b: number
  id: string
}

export function LinearCaptcha({ onVerify, className }: LinearCaptchaProps) {
  const [target, setTarget] = useState<Equation | null>(null)
  const [options, setOptions] = useState<Equation[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null)

  // Grid configuration
  const GRID_SIZE = 10 // -5 to 5
  const CELL_SIZE = 24
  const PADDING = 30
  const WIDTH = GRID_SIZE * CELL_SIZE + PADDING * 2
  const HEIGHT = GRID_SIZE * CELL_SIZE + PADDING * 2
  const CENTER_X = WIDTH / 2
  const CENTER_Y = HEIGHT / 2

  const formatEquation = (eq: Equation) => {
    const mStr = eq.m === 0 ? "" : eq.m === 1 ? "x" : eq.m === -1 ? "-x" : `${Number(eq.m.toFixed(2))}x`
    const bStr = eq.b === 0 ? "" : eq.b > 0 ? (eq.m !== 0 ? `+ ${eq.b}` : `${eq.b}`) : `- ${Math.abs(eq.b)}`
    return `y = ${mStr} ${bStr}`.trim()
  }

  const generateCaptcha = useCallback(() => {
    // Generate target with integer intercepts for clean display
    // x-intercept = a, y-intercept = b
    // Equation: x/a + y/b = 1 => y = (-b/a)x + b

    const getRandomInt = (min: number, max: number) => {
      let val
      do {
        val = Math.floor(Math.random() * (max - min + 1)) + min
      } while (val === 0)
      return val
    }

    const xInt = getRandomInt(-4, 4)
    const yInt = getRandomInt(-4, 4)

    const m = -yInt / xInt
    const b = yInt

    const targetEq: Equation = { m, b, id: "target" }

    // Generate distractors
    const distractors: Equation[] = []
    const used = new Set([formatEquation(targetEq)])

    while (distractors.length < 3) {
      // Strategies for distractors:
      // 1. Flip slope sign
      // 2. Flip intercept sign
      // 3. Swap intercepts (change slope and intercept)
      // 4. Random new line

      const strategy = Math.floor(Math.random() * 4)
      let dM = m,
        dB = b

      if (strategy === 0) dM = -m
      else if (strategy === 1) dB = -b
      else if (strategy === 2) {
        // Swap x and y intercepts effectively
        // New xInt = yInt, New yInt = xInt
        // New m = -xInt / yInt
        dM = -xInt / yInt
        dB = xInt
      } else {
        const dx = getRandomInt(-4, 4)
        const dy = getRandomInt(-4, 4)
        dM = -dy / dx
        dB = dy
      }

      const eq: Equation = { m: dM, b: dB, id: `distractor-${distractors.length}` }
      const eqStr = formatEquation(eq)

      if (!used.has(eqStr)) {
        used.add(eqStr)
        distractors.push(eq)
      }
    }

    const allOptions = [targetEq, ...distractors].sort(() => Math.random() - 0.5)

    setTarget(targetEq)
    setOptions(allOptions)
    setSelectedId(null)
    setIsCorrect(null)
    onVerify(false)
  }, [onVerify])

  useEffect(() => {
    generateCaptcha()
  }, [generateCaptcha])

  const handleOptionClick = (id: string) => {
    if (isCorrect) return // Prevent changing after success

    setSelectedId(id)
    const correct = id === target?.id

    if (correct) {
      setIsCorrect(true)
      onVerify(true)
    } else {
      setIsCorrect(false)
      onVerify(false)
      setTimeout(() => {
        generateCaptcha()
      }, 1000)
    }
  }

  // Helper to convert grid coordinates to SVG coordinates
  const toSvgX = (x: number) => CENTER_X + x * CELL_SIZE
  const toSvgY = (y: number) => CENTER_Y - y * CELL_SIZE

  if (!target) return null

  // Calculate points for drawing the line across the view
  // y = mx + b
  // At x = -6: y1 = m(-6) + b
  // At x = 6: y2 = m(6) + b
  const x1 = -6
  const y1 = target.m * x1 + target.b
  const x2 = 6
  const y2 = target.m * x2 + target.b

  // Intercept points
  const yIntercept = { x: 0, y: target.b }
  const xIntercept = { x: -target.b / target.m, y: 0 }

  return (
    <div className={cn("flex flex-col items-center space-y-4 w-full max-w-md mx-auto", className)}>
      <div className="flex items-center justify-between w-full">
        <div className="text-sm font-medium">Select the function that matches the graph</div>
        <Button type="button" variant="ghost" size="icon" onClick={generateCaptcha} className="h-8 w-8">
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      <div className="relative bg-background/50 border rounded-lg p-4 select-none flex justify-center">
        <svg width={WIDTH} height={HEIGHT} className="overflow-visible">
          <defs>
            <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">
              <polygon points="0 0, 10 3.5, 0 7" className="fill-foreground" />
            </marker>
          </defs>

          {/* Grid Lines */}
          {Array.from({ length: 11 }).map((_, i) => {
            const pos = PADDING + i * CELL_SIZE
            const val = i - 5
            const isAxis = val === 0

            return (
              <g key={i}>
                <line
                  x1={pos}
                  y1={PADDING}
                  x2={pos}
                  y2={HEIGHT - PADDING}
                  className={cn(
                    "transition-colors",
                    isAxis ? "stroke-foreground stroke-2" : "stroke-muted-foreground/20 stroke-1",
                  )}
                  {...(isAxis && { markerEnd: "url(#arrowhead)", markerStart: "url(#arrowhead-reverse)" })}
                />
                <line
                  x1={PADDING}
                  y1={pos}
                  x2={WIDTH - PADDING}
                  y2={pos}
                  className={cn(
                    "transition-colors",
                    isAxis ? "stroke-foreground stroke-2" : "stroke-muted-foreground/20 stroke-1",
                  )}
                  {...(isAxis && { markerEnd: "url(#arrowhead)", markerStart: "url(#arrowhead-reverse)" })}
                />
              </g>
            )
          })}

          {/* The Function Line */}
          <line x1={toSvgX(x1)} y1={toSvgY(y1)} x2={toSvgX(x2)} y2={toSvgY(y2)} className="stroke-primary stroke-[3]" />

          {/* Intercept Points */}
          <circle
            cx={toSvgX(yIntercept.x)}
            cy={toSvgY(yIntercept.y)}
            r={5}
            className="fill-background stroke-primary stroke-2"
          />
          <circle
            cx={toSvgX(xIntercept.x)}
            cy={toSvgY(xIntercept.y)}
            r={5}
            className="fill-background stroke-primary stroke-2"
          />

          {/* Labels */}
          <text
            x={toSvgX(yIntercept.x) + 10}
            y={toSvgY(yIntercept.y) - 10}
            className="text-[14px] fill-purple-500 font-extrabold"
            style={{ textShadow: "0px 0px 4px rgba(0,0,0,1)" }}
          >
            (0, {yIntercept.y})
          </text>
          <text
            x={toSvgX(xIntercept.x) + 10}
            y={toSvgY(xIntercept.y) + 15}
            className="text-[14px] fill-purple-500 font-extrabold"
            style={{ textShadow: "0px 0px 4px rgba(0,0,0,1)" }}
          >
            ({Number(xIntercept.x.toFixed(1))}, 0)
          </text>
        </svg>
      </div>

      <div className="grid grid-cols-2 gap-2 w-full">
        {options.map((opt) => (
          <Button
            key={opt.id}
            type="button"
            variant={selectedId === opt.id ? (isCorrect ? "default" : "destructive") : "outline"}
            className={cn(
              "w-full font-mono text-xs sm:text-sm transition-all",
              selectedId === opt.id && isCorrect && "bg-green-600 hover:bg-green-700 border-green-600",
            )}
            onClick={() => handleOptionClick(opt.id)}
            disabled={isCorrect === true}
          >
            {formatEquation(opt)}
            {selectedId === opt.id &&
              (isCorrect ? <CheckCircle2 className="ml-2 h-4 w-4" /> : <XCircle className="ml-2 h-4 w-4" />)}
          </Button>
        ))}
      </div>
    </div>
  )
}
