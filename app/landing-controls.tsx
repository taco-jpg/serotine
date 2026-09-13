"use client"

import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { enhanceLanding } from "./landing-behavior"
import styles from "./landing.module.css"

// The document is server-rendered. Only this small progressive enhancement and
// the existing theme provider need to hydrate; there is no messaging provider.
export function LandingEnhancements() {
  useEffect(() => {
    const root = document.getElementById("serotine-landing")
    if (root) return enhanceLanding(root)
  }, [])
  return null
}

export function ThemeControl() {
  const { resolvedTheme, setTheme } = useTheme()
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  return <button type="button" className={styles.themeControl} disabled={!ready}
    aria-label={ready ? `Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme` : "Change color theme"}
    onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>
    <svg className={styles.themeGlyph} viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.2" /><path d="M10 4a6 6 0 0 1 0 12Z" fill="currentColor" /></svg>
  </button>
}
