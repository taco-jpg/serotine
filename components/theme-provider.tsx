'use client'

import * as React from 'react'
import {
  ThemeProvider as NextThemesProvider,
  type ThemeProviderProps,
  useTheme,
} from 'next-themes'

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
    observer.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [resolvedTheme])

  return null
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider {...props}>
      <BrowserThemeColor />
      {children}
    </NextThemesProvider>
  )
}
