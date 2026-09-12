/** Classify provider errors without returning SQL, routing addresses or packets. */
export function relayFailureKind(error: unknown): "quota" | "overloaded" | "schema" | "unavailable" {
  const visited = new Set<unknown>()
  let current = error
  for (let depth = 0; depth < 5 && current instanceof Error && !visited.has(current); depth++) {
    visited.add(current)
    const text = current.message
    if (/\b(?:daily|per.day)\b.{0,100}\b(?:limit|quota)\b|\b(?:limit|quota)\b.{0,100}\b(?:daily|per.day)\b/i.test(text)) return "quota"
    if (/\b(?:D1_ERROR|D1_EXEC_ERROR)\b.*\b(?:overloaded|too many requests|rate limit)/i.test(text)) return "overloaded"
    if (/no such (?:table|column)/i.test(text)) return "schema"
    current = current.cause
  }
  return "unavailable"
}
