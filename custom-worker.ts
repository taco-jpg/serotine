// The OpenNext adapter generates this module during the production build.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Generated worker does not exist before the first build.
import handler from "./.open-next/worker.js"
import { CALL_SOCKET_PATH, callSocketUpgradeError } from "./lib/call-socket-protocol"
import { maintainRelayStorage } from "./lib/relay-maintenance"
import type { StorageEnvironment } from "./lib/storage-routing"
import type { PayloadBucket } from "./lib/relay-payloads"
import type { FileUploadBucket } from "./lib/file-upload-relay"
import type { CallSignalingEnvironment } from "./lib/call-socket-server"
export { RelayRealtimeStore } from "./lib/relay-realtime-store"
export { CallSignalingHub } from "./lib/call-socket-server"

type Environment = CallSignalingEnvironment & StorageEnvironment & { serotine_files?: PayloadBucket & FileUploadBucket }

export default {
  async scheduled(_event: unknown, env: Environment, ctx: { waitUntil(task: Promise<unknown>): void }) {
    ctx.waitUntil(maintainRelayStorage(env))
  },
  async fetch(request: Request, env: CallSignalingEnvironment, ctx: unknown) {
    if (new URL(request.url).pathname === CALL_SOCKET_PATH) {
      const error = callSocketUpgradeError(request)
      if (error) return new Response("Open Serotine directly to use calling.", { status: error })
      if (!env.CALL_SIGNALING) return new Response("Calling signaling is unavailable.", { status: 503 })
      return env.CALL_SIGNALING.get(env.CALL_SIGNALING.idFromName("calls-v1")).fetch(request)
    }
    return handler.fetch(request, env, ctx)
  },
}
