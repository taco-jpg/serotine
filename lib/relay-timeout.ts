/** A timeout does not cancel a remote write. Retrying must keep the same ID. */
export async function withRelayTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("The relay took too long to respond. Reconnect, or retry an unconfirmed message.")), 15_000)
      }),
    ])
  } finally { clearTimeout(timer) }
}
