import { createContext, useContext, useEffect, useState, type ReactNode } from "react"
import type { ThemeProviderProps } from "next-themes"
export type { ThemeProviderProps } from "next-themes"
type Appearance = "light" | "dark" | "system"
const valid = (value: unknown): value is Appearance => value === "light" || value === "dark" || value === "system"
const Context = createContext({ theme: "system", resolvedTheme: "light", setTheme: (_theme: string) => {} })
/** A packaged client has no server-rendered first paint: no inline bootstrap
 * script is needed, so its CSP can keep script-src restricted to bundled code. */
export function ThemeProvider({ children }: ThemeProviderProps & { children: ReactNode }) {
  const [theme, update] = useState<Appearance>(() => { const saved = localStorage.getItem("serotine_native_appearance"); return valid(saved) ? saved : "system" })
  const [darkSystem, setDarkSystem] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches)
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)")
    const change = () => setDarkSystem(media.matches)
    media.addEventListener("change", change)
    return () => media.removeEventListener("change", change)
  }, [])
  const resolvedTheme = theme === "system" ? darkSystem ? "dark" : "light" : theme
  useEffect(() => { document.documentElement.classList.toggle("dark", resolvedTheme === "dark"); document.documentElement.style.colorScheme = resolvedTheme }, [resolvedTheme])
  return <Context.Provider value={{ theme, resolvedTheme, setTheme: value => { if (valid(value)) { localStorage.setItem("serotine_native_appearance", value); update(value) } } }}>{children}</Context.Provider>
}
export function useTheme() { return useContext(Context) }
