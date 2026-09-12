import { ID_PATTERN, PUBLIC_KEY_PATTERN } from "./protocol"

/** Accept both decoded route params and percent-encoded address-bar segments. */
export function parseConversationAddress(value: string): string | null {
  let address: string
  try { address = decodeURIComponent(value).toLowerCase() }
  catch { return null }
  if (PUBLIC_KEY_PATTERN.test(address)) return address
  if (address.startsWith("group:") && ID_PATTERN.test(address.slice(6))) return address
  return null
}

export function conversationHref(id: string): string {
  return `/chat/${encodeURIComponent(id)}`
}

export function conversationFromPathname(pathname: string): string | null {
  const segment = /^\/chat\/([^/]+)\/?$/.exec(pathname)?.[1]
  return segment ? parseConversationAddress(segment) : null
}
