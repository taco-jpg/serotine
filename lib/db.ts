import { getCloudflareContext } from "@opennextjs/cloudflare"
import { ensureRelaySchema } from "./relay-schema"

/** The subset of Cloudflare D1 used by the server actions. */
export interface D1Result {
  meta: { changes: number }
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

interface CloudflareEnv {
  serotine_db: D1DatabaseBinding
}

export class RelayConfigurationError extends Error {}

export async function getDB(): Promise<D1DatabaseBinding> {
  const { env } = await getCloudflareContext({ async: true })
  const db = (env as unknown as CloudflareEnv).serotine_db

  if (!db || typeof db.prepare !== "function") {
    throw new RelayConfigurationError("The serotine_db D1 binding is not configured")
  }

  await ensureRelaySchema(db)
  return db
}
