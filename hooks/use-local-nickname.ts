"use client"

import { useCallback, useSyncExternalStore } from "react"
import { loadLocalNickname, subscribeLocalNickname } from "@/lib/local-nickname"

const serverSnapshot = () => ""

export function useLocalNickname(owner: string): string {
  const subscribe = useCallback((onChange: () => void) => subscribeLocalNickname(owner, onChange), [owner])
  const snapshot = useCallback(() => loadLocalNickname(owner), [owner])
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}
