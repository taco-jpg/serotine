"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { navigationSnapshot, parseNavigationPreferences, subscribeNavigation } from "@/lib/navigation-preferences"

const serverSnapshot = () => ""

export function useNavigationPreferences(owner: string) {
  const subscribe = useCallback((onChange: () => void) => subscribeNavigation(owner, onChange), [owner])
  const snapshot = useCallback(() => navigationSnapshot(owner), [owner])
  const raw = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  return useMemo(() => parseNavigationPreferences(raw), [raw])
}
