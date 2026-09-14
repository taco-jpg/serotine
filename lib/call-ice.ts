/** Build the only media routing configuration supported by Serotine calls. */
export function directIceConfiguration(iceServers: RTCIceServer[]): RTCConfiguration {
  if (!Array.isArray(iceServers) || iceServers.length > 8) throw new Error("The direct calling configuration is invalid.")
  const servers = iceServers.map(server => {
    if (!server || typeof server !== "object" || Object.keys(server).some(key => key !== "urls")) throw new Error("Calling only supports STUN servers without relay credentials.")
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    if (!urls.length || urls.length > 8 || urls.some(url => typeof url !== "string" || !/^stuns?:[^\s/?#@]+$/i.test(url))) throw new Error("Calling only supports STUN servers; media relays are disabled.")
    return { urls: [...urls] }
  })
  return { iceServers: servers, iceTransportPolicy: "all", bundlePolicy: "max-bundle" }
}

/** Peers cannot introduce a TURN media route through signed signaling either. */
export function assertDirectCandidate(candidate: string) {
  if (/\btyp\s+relay\b/i.test(candidate)) throw new Error("This contact is using an unsupported media relay. Ask them to update Serotine and start a direct call.")
}

export function assertDirectDescription(sdp: string) {
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("a=candidate:")) assertDirectCandidate(line)
  }
}
