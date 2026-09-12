type RetryResult = { status: "complete" | "cancelled"; completed: number } | { status: "failed"; completed: number; error: unknown }

/** Retry a fixed, chronological queue without changing message IDs or continuing after a failure. */
export async function retryMessageBatch<T extends { id: string; content: string; timestamp: number }>(
  messages: readonly T[],
  send: (content: string, message: T) => Promise<void>,
  isCurrent: () => boolean,
  onStart: (message: T, index: number) => void,
): Promise<RetryResult> {
  const queue = [...messages].sort((a, b) => a.timestamp - b.timestamp)
  let completed = 0
  for (const message of queue) {
    if (!isCurrent()) return { status: "cancelled", completed }
    onStart(message, completed)
    try { await send(message.content, message) }
    catch (error) {
      return isCurrent() ? { status: "failed", completed, error } : { status: "cancelled", completed }
    }
    completed++
  }
  return { status: isCurrent() ? "complete" : "cancelled", completed }
}
