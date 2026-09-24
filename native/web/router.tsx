import { forwardRef, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react"

const listeners = new Set<() => void>()
function changed() { for (const listener of listeners) listener() }
if (typeof window !== "undefined") { window.addEventListener("popstate", changed); window.addEventListener("hashchange", changed) }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
function useLocation() { return useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search + window.location.hash, () => "/login") }
export function usePathname() { return useLocation().split(/[?#]/, 1)[0] }
function go(href: string, replace = false) {
  // The shared router accepts only local paths, never arbitrary bridge origins.
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\") || [...href].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("Invalid app destination")
  const before = window.location.href, previousHash = window.location.hash
  window.history[replace ? "replaceState" : "pushState"]({}, "", href)
  changed()
  // Shared community/contact/message views consume hashchange. History APIs do
  // not emit it, even when a link targets another channel on the same screen.
  if (previousHash !== window.location.hash) window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: before, newURL: window.location.href }))
}
const router = { push: (href: string) => go(href), replace: (href: string) => go(href, true), back: () => window.history.back(), forward: () => window.history.forward(), refresh: changed, prefetch: () => Promise.resolve() }
export function useRouter() { return router }
export function useSearchParams() { const location = useLocation(); return new URLSearchParams(location.split("#", 1)[0].split("?").slice(1).join("?")) }
export function notFound(): never { throw new Error("This conversation address is invalid.") }
type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; prefetch?: boolean; replace?: boolean; scroll?: boolean }
const Link = forwardRef<HTMLAnchorElement, LinkProps>(function NativeLink({ href, onClick, prefetch: _prefetch, replace, scroll: _scroll, ...props }, ref) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || props.target || props.download) return
    if (href.startsWith("/") && !href.startsWith("//")) { event.preventDefault(); go(href, replace) }
  }
  return <a {...props} ref={ref} href={href} onClick={click} />
})
export default Link
