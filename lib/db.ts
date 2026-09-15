import { getCloudflareContext } from "@opennextjs/cloudflare"
import { ensureIdentityRetirementSchema } from "./identity-retirement-schema"
import { routeStorage, type StorageEnvironment } from "./storage-routing"
import { ensureRelaySchema } from "./relay-schema"

/** The subset of Cloudflare D1 used by the server actions. */
export interface D1Result {
  meta: { changes: number; rows_written?: number; rows_read?: number }
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement
  run(): Promise<D1Result>
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results: T[] }>
}

export interface D1DatabaseBinding {
  prepare(query: string): D1Statement
  batch?(statements: D1Statement[]): Promise<D1Result[]>
}

type CloudflareEnv = StorageEnvironment

export class RelayConfigurationError extends Error {}
const routed = new WeakMap<D1DatabaseBinding, D1DatabaseBinding>()

export async function getDB(): Promise<D1DatabaseBinding> {
  const { env } = await getCloudflareContext({ async: true })
  const bindings = env as unknown as CloudflareEnv
  const primary = bindings.serotine_db
  if (primary && bindings.SEROTINE_STORAGE_VERSION !== "1") await ensureIdentityRetirementSchema(primary)
  let db = primary
  if (primary && bindings.SEROTINE_STORAGE_VERSION !== "1") {
    db = routed.get(primary) ?? routeStorage(bindings)
    routed.set(primary, db)
  }

  if (!db || typeof db.prepare !== "function") {
    throw new RelayConfigurationError("The serotine_db D1 binding is not configured")
  }

  await ensureRelaySchema(db)
  return db
}
