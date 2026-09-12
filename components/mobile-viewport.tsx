"use client"

import { useEffect } from "react"

// Safari's keyboard resizes the visual viewport without changing 100dvh.
// Keep the chat and dialogs inside the visible area while retaining pinch zoom.
export function MobileViewport() {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (Math.abs(viewport.scale - 1) > 0.01) return
        root.style.setProperty("--app-height", `${viewport.height}px`)
        root.style.setProperty("--app-top", `${viewport.offsetTop}px`)
        const active = document.activeElement
        const dialog = active?.closest<HTMLElement>('.serotine-dialog')
        if (dialog && active instanceof HTMLElement && active.matches("input, textarea, select")) {
          const field = active.getBoundingClientRect()
          const bounds = dialog.getBoundingClientRect()
          if (field.bottom > bounds.bottom - 16) dialog.scrollTop += field.bottom - bounds.bottom + 16
          else if (field.top < bounds.top + 16) dialog.scrollTop += field.top - bounds.top - 16
        }
      })
    }
    update()
    viewport.addEventListener("resize", update)
    viewport.addEventListener("scroll", update)
    return () => {
      cancelAnimationFrame(frame)
      viewport.removeEventListener("resize", update)
      viewport.removeEventListener("scroll", update)
      root.style.removeProperty("--app-height")
      root.style.removeProperty("--app-top")
    }
  }, [])
  return null
}
