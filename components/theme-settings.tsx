"use client"

import * as React from "react"
import { ArrowUpRight, Check, Download, Palette, Pencil, Plus, RotateCcw, Trash2, Upload } from "lucide-react"
import { useTheme } from "next-themes"

import { usePalette } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DEFAULT_THEME_ID,
  MAX_CUSTOM_THEMES,
  MAX_THEME_NAME_LENGTH,
  MAX_THEME_FILE_SIZE,
  PRESET_THEMES,
  getContrastWarnings,
  parseThemeFile,
  serializeThemeFile,
  themeVariables,
  type ColorTheme,
  type ThemeColors,
  type ThemeMode,
} from "@/lib/themes"

const colorFields: { key: keyof ThemeColors; label: string }[] = [
  { key: "background", label: "Main background" },
  { key: "foreground", label: "Main text" },
  { key: "surface", label: "Panels & controls" },
  { key: "sidebar", label: "Sidebar" },
  { key: "accent", label: "Accent" },
  { key: "mutedText", label: "Secondary text" },
  { key: "incoming", label: "Incoming bubble" },
  { key: "incomingText", label: "Incoming text" },
  { key: "outgoing", label: "Outgoing bubble" },
  { key: "outgoingText", label: "Outgoing text" },
]

// Settings and recovery always use readable built-in colors. Draft variables
// belong only to the sample conversation, never to the editor or document root.
export function safeThemeStyle(mode: ThemeMode): React.CSSProperties {
  const colors = PRESET_THEMES.find((preset) => preset.id === DEFAULT_THEME_ID)![mode]
  return {
    ...themeVariables(colors),
    colorScheme: mode,
    backgroundColor: colors.surface,
    color: colors.foreground,
  } as React.CSSProperties
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to update themes. Please try again."
}

function copyTheme(theme: ColorTheme): ColorTheme {
  return { ...theme, light: { ...theme.light }, dark: { ...theme.dark } }
}

function ThemeSwatches({ theme, mode }: { theme: ColorTheme; mode: ThemeMode }) {
  const colors = theme[mode]
  return (
    <span
      className="grid h-20 grid-cols-[24%_1fr] overflow-hidden rounded-sm border border-border bg-background"
      style={themeVariables(colors) as React.CSSProperties}
      aria-hidden="true"
    >
      <span className="flex flex-col gap-2 border-r border-border bg-sidebar px-2 py-3">
        <span className="mb-1 size-2.5 rounded-sm bg-primary" />
        <span className="h-1 w-full bg-muted-foreground/40" />
        <span className="h-1 w-3/4 bg-muted-foreground/20" />
        <span className="h-1 w-full bg-muted-foreground/20" />
      </span>
      <span className="flex min-w-0 flex-col gap-2 p-2.5">
        <span className="flex items-center gap-1.5 border-b border-border pb-1.5">
          <span className="size-1 rounded-full bg-primary" />
          <span className="h-1 w-1/3 bg-foreground/50" />
        </span>
        <span className="h-3 w-3/4 rounded-sm border border-border bg-message-incoming" />
        <span className="ml-auto h-3 w-2/3 rounded-sm border-l-2 border-primary bg-message-outgoing" />
      </span>
    </span>
  )
}

function ThemePreview({ colors }: { colors: ThemeColors }) {
  return (
    <div
      aria-label="Theme conversation preview"
      className="overflow-hidden rounded-sm border border-border bg-background text-foreground"
      style={themeVariables(colors) as React.CSSProperties}
    >
      <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
        <div className="space-y-3 border-r border-border bg-sidebar p-2 text-sidebar-foreground">
          <p className="py-1 text-sm font-semibold tracking-tight">serotine<span className="text-primary">.</span></p>
          <p className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">Messages</p>
          <div className="border-l-2 border-sidebar-ring bg-sidebar-accent px-2 py-1.5 text-sidebar-accent-foreground">Study group</div>
          <p className="px-2 text-muted-foreground">Saved notes</p>
        </div>
        <div className="min-w-0 space-y-3 p-3">
          <p className="border-b border-border pb-2 font-medium">Study group <span className="block pt-1 font-mono text-[9px] font-normal uppercase tracking-wider text-muted-foreground">Today</span></p>
          <div className="w-fit max-w-[92%] rounded-sm border border-border bg-message-incoming px-3 py-2 text-message-incoming-foreground">How does this look?</div>
          <div className="ml-auto w-fit max-w-[92%] rounded-sm border-l-2 border-primary bg-message-outgoing px-3 py-2 text-message-outgoing-foreground">Feels like Serotine.</div>
          <p><a href="#" onClick={(event) => event.preventDefault()} className="text-primary underline underline-offset-2">Shared notes</a></p>
          <div className="flex min-w-0 items-center gap-2 rounded-sm border border-input bg-card p-1.5 text-card-foreground">
            <span className="min-w-0 flex-1 truncate text-muted-foreground">Write a message…</span>
            <button type="button" className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-label="Preview send button"><ArrowUpRight className="size-4" aria-hidden="true" /></button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ThemeSettingsContent({ onClose, initialError }: { onClose: () => void; initialError: string }) {
  const { preferences, palette, ready, selectPalette, saveCustomTheme, deleteCustomTheme, resetPalette } = usePalette()
  const { resolvedTheme } = useTheme()
  const appearance: ThemeMode = resolvedTheme === "dark" ? "dark" : "light"
  const [draft, setDraft] = React.useState<ColorTheme | null>(null)
  const [previewMode, setPreviewMode] = React.useState<ThemeMode>(appearance)
  const [error, setError] = React.useState(initialError)
  const [notice, setNotice] = React.useState("")
  const [pendingDelete, setPendingDelete] = React.useState<string | null>(null)
  const [importing, setImporting] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const importGeneration = React.useRef(0)
  const id = React.useId()

  React.useEffect(() => () => { importGeneration.current += 1 }, [])

  const runAction = (action: () => void, success?: string) => {
    setError("")
    setNotice("")
    try {
      action()
      if (success) setNotice(success)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const startDraft = (source: ColorTheme, editing = false) => {
    const next = copyTheme(source)
    if (!editing) {
      next.id = `custom-${crypto.randomUUID()}`
      next.name = `${source.name} custom`.slice(0, MAX_THEME_NAME_LENGTH)
    }
    setDraft(next)
    setPreviewMode(appearance)
    setError("")
    setNotice("")
    setPendingDelete(null)
  }

  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ""
    if (!file) return
    const generation = ++importGeneration.current
    setError("")
    setNotice("")
    if (file.size > MAX_THEME_FILE_SIZE) {
      setError(`Theme files must be ${MAX_THEME_FILE_SIZE / 1024} KB or smaller.`)
      return
    }
    setImporting(true)
    try {
      const raw = await file.text()
      if (generation !== importGeneration.current) return
      const imported = parseThemeFile(raw)
      setDraft({ ...imported, id: `custom-${crypto.randomUUID()}` })
      setPreviewMode(appearance)
      setNotice("Theme imported for preview. Save & apply when you are ready.")
    } catch (cause) {
      if (generation === importGeneration.current) setError(errorMessage(cause))
    } finally {
      if (generation === importGeneration.current) setImporting(false)
    }
  }

  const exportTheme = (theme: ColorTheme) => runAction(() => {
    const url = URL.createObjectURL(new Blob([serializeThemeFile(theme)], { type: "application/json" }))
    const link = document.createElement("a")
    link.href = url
    link.download = `${theme.name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 60) || "serotine"}.serotine-theme.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })

  const restoreDefault = () => {
    setDraft(null)
    setPendingDelete(null)
    runAction(resetPalette, "Default palette restored.")
  }

  const warnings = draft ? (["light", "dark"] as const).flatMap((mode) =>
    getContrastWarnings(draft[mode]).map((warning) => ({ ...warning, mode }))
  ) : []
  const basePreset = draft ? PRESET_THEMES.find((preset) => preset.id === draft.baseId) ?? PRESET_THEMES[0] : null
  const isSavedDraft = draft ? preferences.customThemes.some((theme) => theme.id === draft.id) : false

  return (
    <DialogContent className="grid-cols-[minmax(0,1fr)] gap-5 sm:max-w-3xl" style={safeThemeStyle(appearance)}>
      <DialogHeader className="border-b border-border pb-4 text-left">
        <p className="mb-1 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground"><Palette className="size-3 text-primary" aria-hidden="true" />Appearance</p>
        <DialogTitle className="text-2xl font-medium tracking-tight">{draft ? "Edit custom theme" : "Palettes & custom themes"}</DialogTitle>
        <DialogDescription>
          {draft ? "Make it yours. Preview both variants, then save your colors." : "One familiar space, in your colors. Every palette includes a light and dark variant."}
        </DialogDescription>
      </DialogHeader>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}

      {draft ? (
        <form onSubmit={(event) => {
          event.preventDefault()
          runAction(() => {
            saveCustomTheme({ ...draft, name: draft.name.trim() })
            setDraft(null)
          }, "Custom theme saved and applied.")
        }} className="min-w-0 space-y-4">
          <div className="space-y-1.5">
            <label htmlFor={`${id}-name`} className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Theme name</label>
            <input id={`${id}-name`} autoFocus required maxLength={MAX_THEME_NAME_LENGTH} value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div className="min-w-0 space-y-3">
              <fieldset className="flex gap-1 rounded-sm border border-border bg-background p-1">
                <legend className="sr-only">Variant to edit and preview</legend>
                {(["light", "dark"] as const).map((mode) => (
                  <label key={mode} className="relative flex-1 cursor-pointer">
                    <input type="radio" name={`${id}-variant`} value={mode} checked={previewMode === mode} onChange={() => setPreviewMode(mode)} className="peer sr-only" />
                    <span className="block rounded-sm px-2 py-2 text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-2 peer-focus-visible:ring-ring">{mode === "light" ? "Light variant" : "Dark variant"}</span>
                  </label>
                ))}
              </fieldset>
              <div className="grid grid-cols-2 gap-2">
                {colorFields.map(({ key, label }) => (
                  <div key={key} className="flex min-w-0 items-center gap-2 rounded-sm border border-border bg-background p-2">
                    <input type="color" id={`${id}-${key}`} aria-label={`${label} color`} value={draft[previewMode][key]}
                      onChange={(event) => setDraft({ ...draft, [previewMode]: { ...draft[previewMode], [key]: event.target.value } })}
                      className="size-8 shrink-0 cursor-pointer rounded border border-input bg-background p-0.5 focus-visible:outline-2 focus-visible:outline-ring" />
                    <label htmlFor={`${id}-${key}`} className="min-w-0 cursor-pointer text-xs leading-tight">
                      {label}<span className="mt-1 block font-mono text-[10px] text-muted-foreground">{draft[previewMode][key]}</span>
                    </label>
                  </div>
                ))}
              </div>
              <Button type="button" variant="outline" size="sm" className="w-full" onClick={() => {
                if (basePreset) setDraft({ ...draft, light: { ...basePreset.light }, dark: { ...basePreset.dark } })
                setError("")
              }}><RotateCcw aria-hidden="true" />Reset colors to {basePreset?.name}</Button>
            </div>
            <div className="min-w-0 space-y-3">
              <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Live preview · {previewMode}</p>
              <ThemePreview colors={draft[previewMode]} />
              <p className="text-xs text-muted-foreground">Edit both variants so your theme also works when the system appearance changes.</p>
              {warnings.length > 0 ? (
                <details className="rounded-md border border-border bg-muted/40 p-3 text-xs">
                  <summary className="cursor-pointer font-medium">{warnings.length} readability {warnings.length === 1 ? "warning" : "warnings"}</summary>
                  <p className="mt-2 text-muted-foreground">Some text may be hard to read. You can still save these colors.</p>
                  <ul className="mt-2 space-y-1">
                    {warnings.map((warning) => <li key={`${warning.mode}-${warning.label}`}><span className="capitalize">{warning.mode}</span>: {warning.label} ({warning.ratio.toFixed(2)}:1)</li>)}
                  </ul>
                </details>
              ) : <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="size-3.5 shrink-0" aria-hidden="true" />Both variants pass the text contrast checks.</p>}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <Button type="button" variant="ghost" size="sm" onClick={restoreDefault}><RotateCcw aria-hidden="true" />Restore default palette</Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(null); setError(""); setNotice("") }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={!ready || !draft.name.trim() || (!isSavedDraft && preferences.customThemes.length >= MAX_CUSTOM_THEMES)}>Save & apply</Button>
            </div>
          </div>
          {!isSavedDraft && preferences.customThemes.length >= MAX_CUSTOM_THEMES && <p className="text-xs text-muted-foreground">You have {MAX_CUSTOM_THEMES} custom themes. Delete one to save another.</p>}
        </form>
      ) : (
        <>
          <section aria-labelledby={`${id}-presets`} className="min-w-0 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h3 id={`${id}-presets`} className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Presets</h3>
              <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{appearance} appearance</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {PRESET_THEMES.map((preset, index) => (
                <button key={preset.id} type="button" aria-label={preset.name} aria-pressed={palette.id === preset.id} disabled={!ready || importing}
                  onClick={() => runAction(() => selectPalette(preset.id), `${preset.name} palette applied.`)}
                  className="group min-w-0 space-y-2.5 rounded-sm border border-border bg-background p-2 text-left outline-none transition-colors hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-primary aria-pressed:bg-accent disabled:opacity-50">
                  <ThemeSwatches theme={preset} mode={appearance} />
                  <span className="flex items-center justify-between gap-2 px-0.5 pb-0.5 text-xs font-medium">
                    <span className="flex min-w-0 items-center gap-2"><span className="font-mono text-[9px] text-muted-foreground" aria-hidden="true">0{index + 1}</span>{preset.name}</span>
                    {palette.id === preset.id && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                  </span>
                </button>
              ))}
            </div>
          </section>
          <section aria-labelledby={`${id}-custom`} className="min-w-0 space-y-3 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${id}-custom`} className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Your themes <span className="font-normal">({preferences.customThemes.length}/{MAX_CUSTOM_THEMES})</span></h3>
              <div className="flex gap-1.5">
                <input ref={inputRef} type="file" accept=".json,application/json" aria-label="Import theme file" className="sr-only" tabIndex={-1} onChange={importFile} />
                <Button variant="outline" size="sm" disabled={!ready || importing} onClick={() => inputRef.current?.click()}><Upload aria-hidden="true" />{importing ? "Importing…" : "Import"}</Button>
                <Button size="sm" disabled={!ready || importing || preferences.customThemes.length >= MAX_CUSTOM_THEMES} onClick={() => runAction(() => startDraft(palette))}><Plus aria-hidden="true" />New theme</Button>
              </div>
            </div>
            {preferences.customThemes.length ? (
              <div className="max-h-52 space-y-2 overflow-y-auto rounded-md">
                {preferences.customThemes.map((custom) => (
                  <div key={custom.id} className="rounded-sm border border-border bg-background p-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <button type="button" aria-pressed={palette.id === custom.id} disabled={!ready || importing} onClick={() => runAction(() => selectPalette(custom.id), `${custom.name} palette applied.`)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
                        <span className="size-4 shrink-0 rounded-sm border border-border" style={{ backgroundColor: custom[appearance].accent }} aria-hidden="true" /><span className="truncate">{custom.name}</span>{palette.id === custom.id && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                      </button>
                      <Button variant="ghost" size="icon-sm" disabled={importing} aria-label={`Edit ${custom.name}`} title="Edit theme" onClick={() => startDraft(custom, true)}><Pencil aria-hidden="true" /></Button>
                      <Button variant="ghost" size="icon-sm" disabled={importing} aria-label={`Export ${custom.name}`} title="Export theme" onClick={() => exportTheme(custom)}><Download aria-hidden="true" /></Button>
                      <Button variant="ghost" size="icon-sm" disabled={importing} aria-label={`Delete ${custom.name}`} title="Delete theme" onClick={() => setPendingDelete(custom.id)}><Trash2 aria-hidden="true" /></Button>
                    </div>
                    {pendingDelete === custom.id && (
                      <div className="mt-2 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2 text-xs">
                        <span className="mr-auto">Delete “{custom.name}”?</span>
                        <Button variant="outline" size="sm" onClick={() => setPendingDelete(null)}>Keep</Button>
                        <Button variant="destructive" size="sm" onClick={() => runAction(() => { deleteCustomTheme(custom.id); setPendingDelete(null) }, "Custom theme deleted.")}>Delete theme</Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : <div className="flex items-center gap-3 rounded-sm border border-dashed border-border bg-background p-4 text-sm text-muted-foreground"><Palette className="size-5 shrink-0 text-primary" aria-hidden="true" /><p>Start with {palette.name} and make it yours.</p></div>}
            <p className="text-xs text-muted-foreground">Saved in this browser. Theme files share colors only.</p>
          </section>
          <div className="flex flex-wrap justify-between gap-2 border-t border-border pt-3">
            <Button variant="ghost" size="sm" onClick={restoreDefault}><RotateCcw aria-hidden="true" />Restore default palette</Button>
            <Button variant="outline" size="sm" onClick={onClose}>Done</Button>
          </div>
        </>
      )}
    </DialogContent>
  )
}

export function ThemeSettings({ open, onOpenChange, initialError = "" }: { open: boolean; onOpenChange: (open: boolean) => void; initialError?: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <ThemeSettingsContent onClose={() => onOpenChange(false)} initialError={initialError} />}
    </Dialog>
  )
}
