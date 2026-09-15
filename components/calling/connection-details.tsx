import { callRouteLabels, type CallConnectionDiagnostics } from "@/lib/call-ice"

export function ConnectionDetails({ connection }: { connection: CallConnectionDiagnostics | null }) {
  if (!connection) return null
  return <details className="text-xs leading-5 text-muted-foreground">
    <summary className="cursor-pointer" data-testid="call-route">Connection: {callRouteLabels[connection.route]}</summary>
    <p>{connection.localType ?? "Unknown"} ↔ {connection.remoteType ?? "Unknown"}{connection.protocol ? ` · ${connection.protocol.toUpperCase()}` : ""}{connection.roundTripMs !== null ? ` · ${connection.roundTripMs} ms round trip` : ""}</p>
    <p>ICE {connection.iceConnectionState ?? "unknown"} · gathering {connection.iceGatheringState ?? "unknown"} · {connection.localCandidateCount} local / {connection.remoteCandidateCount} remote candidates</p>
    <p>{Math.round(connection.bytesSent / 1024)} KiB sent · {Math.round(connection.bytesReceived / 1024)} KiB received</p>
  </details>
}
