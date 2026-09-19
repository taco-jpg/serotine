/** Shared last-moment guard for server-backed attachment operations. */
export function assertRelayFileRoute(owner: string, conversationId: string) {
  let direct: boolean
  try { direct = typeof localStorage !== "undefined" && localStorage.getItem(`serotine.direct.v1:${owner}:${conversationId}`) === "1" }
  catch { throw new Error("The conversation delivery policy could not be verified. Upload is blocked.") }
  if (direct) throw new Error("Force P2P does not upload files to server storage. Use Send direct file, up to 2 MiB.")
}
