"use client"

import * as React from "react"
import { Monitor, Moon, Palette, RotateCcw, Sun } from "lucide-react"
import { useTheme } from "next-themes"

import { usePalette } from "@/components/theme-provider"
import { safeThemeStyle, ThemeSettings } from "@/components/theme-settings"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const themeOptions = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
]

export function ModeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const { resetPalette } = usePalette()
  const [mounted, setMounted] = React.useState(false)
  const [settingsOpen, setSettingsOpen] = React.useState(false)
  const [settingsError, setSettingsError] = React.useState("")
  const triggerRef = React.useRef<HTMLButtonElement>(null)

  const handleSettingsOpenChange = (open: boolean) => {
    setSettingsOpen(open)
    if (!open) requestAnimationFrame(() => triggerRef.current?.focus())
  }

  React.useEffect(() => setMounted(true), [])

  const selection = mounted ? themeOptions.find((option) => option.value === theme) : undefined
  const Icon = selection?.icon ?? Monitor
  const label = selection ? `Theme: ${selection.label}` : "Choose theme"
  const recoveryStyle = mounted ? safeThemeStyle(resolvedTheme === "dark" ? "dark" : "light") : undefined

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={triggerRef} variant="ghost" size="icon-sm" aria-label={label} title={label} disabled={!mounted} style={recoveryStyle} className="shrink-0 text-muted-foreground hover:text-foreground">
            <Icon className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" style={recoveryStyle} className="w-60 rounded-xl p-1.5">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Appearance</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={mounted ? theme : undefined} onValueChange={setTheme} aria-label="Theme">
            {themeOptions.map(({ value, label: optionLabel, icon: OptionIcon }) => (
              <DropdownMenuRadioItem key={value} value={value} className="rounded-md">
                <OptionIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                {optionLabel}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { setSettingsError(""); setSettingsOpen(true) }} className="rounded-md">
            <Palette aria-hidden="true" />Palettes & custom themes
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => {
            try {
              resetPalette()
            } catch (error) {
              setSettingsError(error instanceof Error ? error.message : "Default palette restored, but could not be saved.")
              setSettingsOpen(true)
            }
          }} className="rounded-md">
            <RotateCcw aria-hidden="true" />Restore default palette
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ThemeSettings open={settingsOpen} onOpenChange={handleSettingsOpenChange} initialError={settingsError} />
    </>
  )
}
