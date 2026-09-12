"use client"

import { useCallback, useEffect, useId, useState } from "react"

export const AUTO_COMPACT_STORAGE_KEY = "serotine:auto-compact-files"
const CHANGE_EVENT = "serotine:auto-compact-files-change"

/** Browser-local preference, off by default, synchronized between chat composers and tabs. */
export function useAutoCompactFiles(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    const refresh = () => {
      try { setEnabled(window.localStorage.getItem(AUTO_COMPACT_STORAGE_KEY) === "true") } catch { /* Storage may be disabled. */ }
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key === AUTO_COMPACT_STORAGE_KEY || event.key === null) refresh()
    }
    const handleChange = (event: Event) => {
      setEnabled((event as CustomEvent<boolean>).detail === true)
    }
    refresh()
    window.addEventListener("storage", handleStorage)
    window.addEventListener(CHANGE_EVENT, handleChange)
    return () => {
      window.removeEventListener("storage", handleStorage)
      window.removeEventListener(CHANGE_EVENT, handleChange)
    }
  }, [])

  const update = useCallback((next: boolean) => {
    setEnabled(next)
    try { window.localStorage.setItem(AUTO_COMPACT_STORAGE_KEY, String(next)) } catch { /* Keep the setting usable for this session. */ }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }))
  }, [])

  return [enabled, update]
}

export function AutoCompactFilesSetting({ enabled, onChange, disabled = false }: {
  enabled: boolean
  onChange: (enabled: boolean) => void
  disabled?: boolean
}) {
  const descriptionId = useId()
  return <div className="space-y-1">
    <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
      <input type="checkbox" checked={enabled} disabled={disabled} onChange={event => onChange(event.target.checked)} aria-describedby={descriptionId} className="accent-primary" />
      Auto compact files
    </label>
    <p id={descriptionId} className="text-xs text-muted-foreground">Lossless .gz download when smaller. Photos, audio, videos, and compressed files stay in their original format. Applies to the next file you add.</p>
  </div>
}
