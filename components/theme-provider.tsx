'use client'

import * as React from 'react'
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
  useTheme,
} from 'next-themes'
import {
  DEFAULT_THEME_ID,
  MAX_CUSTOM_THEMES,
  PRESET_THEMES,
  THEME_STORAGE_KEY,
  defaultThemePreferences,
  getColorTheme,
  normalizeCustomTheme,
  parseThemePreferences,
  themeVariables,
  type ColorTheme,
  type ThemePreferences,
} from '@/lib/themes'

type PaletteContextValue = {
  preferences: ThemePreferences
  palette: ColorTheme
  ready: boolean
  selectPalette: (id: string) => void
  saveCustomTheme: (theme: ColorTheme) => void
  deleteCustomTheme: (id: string) => void
  resetPalette: () => void
}

const PaletteContext = React.createContext<PaletteContextValue | null>(null)

export function usePalette() {
  const context = React.useContext(PaletteContext)
  if (!context) throw new Error('Palette settings require ThemeProvider.')
  return context
}

function PaletteProvider({ children }: { children: React.ReactNode }) {
  const [preferences, setPreferences] = React.useState<ThemePreferences>(defaultThemePreferences)
  const [ready, setReady] = React.useState(false)
  const current = React.useRef(preferences)
  const { resolvedTheme } = useTheme()

  React.useEffect(() => {
    const refresh = () => {
      let next = defaultThemePreferences()
      try { next = parseThemePreferences(window.localStorage.getItem(THEME_STORAGE_KEY)) } catch { /* Use the readable built-in theme when storage is unavailable. */ }
      current.current = next
      setPreferences(next)
      setReady(true)
    }
    const onStorage = (event: StorageEvent) => {
      if ((event.key === THEME_STORAGE_KEY || event.key === null) && event.storageArea === window.localStorage) refresh()
    }
    refresh()
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const palette = getColorTheme(preferences)
  React.useEffect(() => {
    if (!ready) return
    const root = document.documentElement
    // Read the actual class as next-themes changes it, including system and
    // cross-tab updates. Only color properties belong to a palette.
    let appliedKeys: string[] = []
    const apply = () => {
      for (const key of appliedKeys) root.style.removeProperty(key)
      const mode = root.classList.contains('dark') ? 'dark' : 'light'
      const variables = palette.id === DEFAULT_THEME_ID ? {} : themeVariables(palette[mode])
      for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value)
      appliedKeys = Object.keys(variables)
      root.dataset.palette = palette.id
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => {
      observer.disconnect()
      for (const key of appliedKeys) root.style.removeProperty(key)
      delete root.dataset.palette
    }
  }, [palette, ready, resolvedTheme])

  const persist = (next: ThemePreferences) => {
    try { window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next)) } catch {
      throw new Error('Could not save your theme. Browser storage may be full or disabled.')
    }
    current.current = next
    setPreferences(next)
  }

  const selectPalette = (id: string) => {
    const next = current.current
    if (!PRESET_THEMES.some(theme => theme.id === id) && !next.customThemes.some(theme => theme.id === id)) {
      throw new Error('This theme is no longer available. Choose another palette.')
    }
    persist({ ...next, selectedId: id })
  }

  const saveCustomTheme = (input: ColorTheme) => {
    const theme = normalizeCustomTheme(input)
    const next = current.current
    const exists = next.customThemes.some(saved => saved.id === theme.id)
    if (!exists && next.customThemes.length >= MAX_CUSTOM_THEMES) {
      throw new Error(`You can save up to ${MAX_CUSTOM_THEMES} custom themes. Delete one before adding another.`)
    }
    const customThemes = exists
      ? next.customThemes.map(saved => saved.id === theme.id ? theme : saved)
      : [...next.customThemes, theme]
    persist({ selectedId: theme.id, customThemes })
  }

  const deleteCustomTheme = (id: string) => {
    const next = current.current
    persist({
      selectedId: next.selectedId === id ? DEFAULT_THEME_ID : next.selectedId,
      customThemes: next.customThemes.filter(theme => theme.id !== id),
    })
  }

  const resetPalette = () => {
    const next = { ...current.current, selectedId: DEFAULT_THEME_ID }
    // Recovery must work for this session even if persistence is blocked.
    current.current = next
    setPreferences(next)
    try { window.localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(next)) } catch {
      throw new Error('Default palette restored for this session. Browser storage is unavailable, so the change could not be saved.')
    }
  }

  return <PaletteContext.Provider value={{ preferences, palette, ready, selectPalette, saveCustomTheme, deleteCustomTheme, resetPalette }}>{children}</PaletteContext.Provider>
}

function BrowserThemeColor() {
  const { resolvedTheme } = useTheme()

  React.useEffect(() => {
    const root = document.documentElement
    const updateChrome = () => {
      const color = getComputedStyle(root).getPropertyValue('--theme-chrome').trim()
      if (!color) return
      // Both media variants must respect an explicit choice over the OS theme.
      document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
        meta.content = color
      })
    }

    updateChrome()
    // Observe the class to avoid effect-order races with next-themes, and to
    // follow cross-tab and system theme changes as well as explicit choices.
    const observer = new MutationObserver(updateChrome)
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => observer.disconnect()
  }, [resolvedTheme])

  return null
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <PaletteProvider>
        <BrowserThemeColor />
        {children}
      </PaletteProvider>
    </NextThemesProvider>
  )
}
