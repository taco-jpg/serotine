/** Gather direct, STUN, and managed TURN routes together. Standard ICE prefers
 * viable host/reflexive candidates over relay candidates without a custom relay. */
export function callIceConfiguration(iceServers: RTCIceServer[]): RTCConfiguration {
  if (!Array.isArray(iceServers) || iceServers.length > 8) throw new Error("The calling configuration is invalid.")
  const servers = iceServers.map(server => {
    if (!server || typeof server !== "object" || Object.keys(server).some(key => !["urls", "username", "credential", "credentialType"].includes(key))) throw new Error("The calling server configuration is invalid.")
    const credentialType = (server as RTCIceServer & { credentialType?: unknown }).credentialType
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    if (!urls.length || urls.length > 8 || urls.some(url => typeof url !== "string" || url.length > 512)) throw new Error("The calling server URLs are invalid.")
    if (urls.some(url => /^turns?:/.test(url))) {
      if (urls.some(url => !/^turns?:turn\.cloudflare\.com:(?:3478|5349|443|80)\?transport=(?:udp|tcp)$/.test(url))
        || typeof server.username !== "string" || !server.username.length || server.username.length > 512
        || typeof server.credential !== "string" || !server.credential.length || server.credential.length > 512
        || (credentialType !== undefined && credentialType !== "password")) throw new Error("The managed TURN configuration is invalid.")
      return { urls: [...urls], username: server.username, credential: server.credential }
    }
    if (urls.some(url => !/^stuns?:[^\s/?#@]+$/.test(url)) || server.username !== undefined || server.credential !== undefined || credentialType !== undefined) throw new Error("The STUN configuration is invalid.")
    return { urls: [...urls] }
  })
  return { iceServers: servers, iceTransportPolicy: "all", bundlePolicy: "max-bundle" }
}

export type CallRoute = "unknown" | "direct" | "stun" | "turn"
export interface CallConnectionDiagnostics {
  route: CallRoute
  localType: string | null
  remoteType: string | null
  protocol: string | null
  roundTripMs: number | null
  bytesSent: number
  bytesReceived: number
}
export const callRouteLabels: Record<CallRoute, string> = {
  unknown: "Checking connection", direct: "Direct P2P", stun: "STUN-assisted P2P", turn: "TURN relay",
}

/** Classify only the selected pair. Never expose addresses, candidate IDs, ports,
 * URLs, SDP, credentials, or the raw stats report. */
export function callConnectionDiagnostics(stats: RTCStatsReport): CallConnectionDiagnostics {
  const rows: Record<string, unknown>[] = []
  stats.forEach(row => rows.push(row))
  const transport = rows.find(row => row.type === "transport" && typeof row.selectedCandidatePairId === "string")
  const pair = transport ? stats.get(transport.selectedCandidatePairId as string) as Record<string, unknown> | undefined
    : rows.find(row => row.type === "candidate-pair" && row.state === "succeeded" && row.selected === true)
      ?? rows.find(row => row.type === "candidate-pair" && row.state === "succeeded" && row.nominated === true)
  const local = pair && stats.get(String(pair.localCandidateId)), remote = pair && stats.get(String(pair.remoteCandidateId))
  const candidateType = (row: Record<string, unknown> | undefined) => row && ["host", "srflx", "prflx", "relay"].includes(String(row.candidateType)) ? String(row.candidateType) : null
  const localType = candidateType(local), remoteType = candidateType(remote)
  const route: CallRoute = !pair || !localType || !remoteType ? "unknown"
    : [localType, remoteType].includes("relay") ? "turn"
      : [localType, remoteType].some(type => type === "srflx" || type === "prflx") ? "stun" : "direct"
  const counter = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
  return { route, localType, remoteType, protocol: ["udp", "tcp"].includes(local?.protocol) ? local.protocol : null,
    roundTripMs: typeof pair?.currentRoundTripTime === "number" && Number.isFinite(pair.currentRoundTripTime) && pair.currentRoundTripTime >= 0 ? Math.round(pair.currentRoundTripTime * 1000) : null,
    bytesSent: counter(pair?.bytesSent), bytesReceived: counter(pair?.bytesReceived) }
}

export function observeCallConnection(pc: RTCPeerConnection, update: (value: CallConnectionDiagnostics) => void) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  async function sample() {
    if (stopped || pc.connectionState === "closed") return
    try { const stats = await pc.getStats(); if (!stopped) update(callConnectionDiagnostics(stats)) } catch { /* Diagnostics cannot interrupt media. */ }
    if (!stopped) timer = setTimeout(() => { void sample() }, 2_000)
  }
  if (typeof pc.getStats === "function") void sample()
  return () => { stopped = true; clearTimeout(timer) }
}
