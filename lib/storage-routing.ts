import type { D1DatabaseBinding, D1Result, D1Statement } from './db'

/** The existing SQL arbitration stays intact; only these tables move to the DO. */
export const REALTIME_TABLES = ['RequestNonce', 'RelaySignal', 'CallPresence', 'CallSession', 'CallSignal',
  'CallRoomAuthority', 'CallRoomMember', 'CallRoomSignal', 'DirectSignal'] as const
const realtime = new RegExp(`\\b(${REALTIME_TABLES.join('|')})\\b`, 'i')
export interface RealtimeNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}
export interface StorageEnvironment {
  serotine_db: D1DatabaseBinding
  SEROTINE_REALTIME?: RealtimeNamespace
  SEROTINE_STORAGE_VERSION?: string
  SEROTINE_D1_METRICS?: string
}
export type Query = { sql: string; values: unknown[] }
export function realtimeQuery(sql: string) { return realtime.test(sql) }
const retirementWrite = (sql: string) => /^INSERT\s+OR\s+IGNORE\s+INTO\s+RetiredIdentity\b/i.test(sql.trim())

/** No proofs, SQL parameters, message content, keys or identifiers are logged. */
export function recordD1Result(sql: string, result: D1Result, enabled: boolean) {
  if (!enabled) return
  const meta = result.meta
  const source = sql.match(/\b(?:INTO|UPDATE|FROM)\s+(\w+)/i)?.[1] ?? 'schema'
  if (meta.rows_written) console.info(JSON.stringify({ metric: 'serotine.d1', source,
    operation: sql.trim().split(/\s+/)[0].toUpperCase(), rows_written: meta.rows_written, rows_read: meta.rows_read ?? 0 }))
}

/** A binding-only SQL transport, never exposed through an HTTP route. Batches
 * involving call arbitration always execute in one DO SQLite transaction. */
export function routeStorage(env: StorageEnvironment): D1DatabaseBinding {
  const d1 = env.serotine_db
  const namespace = env.SEROTINE_REALTIME
  if (!namespace) throw new Error('The SEROTINE_REALTIME Durable Object binding is not configured')
  const query = async (items: Query[]) => {
    const stub = namespace.get(namespace.idFromName('relay-realtime-v1'))
    const response = await stub.fetch(new Request('https://realtime.internal/query', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(items) }))
    if (!response.ok) throw new Error('Realtime storage is temporarily unavailable')
    return await response.json() as (D1Result & { results: Record<string, unknown>[] })[]
  }
  const enabled = env.SEROTINE_D1_METRICS === '1'
  class Statement implements D1Statement {
    constructor(readonly sql: string, readonly values: unknown[] = []) {}
    bind(...values: unknown[]) { return new Statement(this.sql, values) }
    raw() { return d1.prepare(this.sql).bind(...this.values) }
    async all<T = unknown>(): Promise<{ results: T[] }> {
      if (/\bsqlite_master\b/i.test(this.sql)) {
        const primary = await this.raw().all<T>()
        const [secondary] = await query([this])
        return { results: [...primary.results, ...secondary.results as T[]] }
      }
      if (realtimeQuery(this.sql) || retirementWrite(this.sql)) return (await query([this]))[0] as { results: T[] }
      const result = await this.raw().all<T>()
      if ('meta' in result) recordD1Result(this.sql, result as unknown as D1Result, enabled)
      return result
    }
    async first<T = unknown>(): Promise<T | null> { return (await this.all<T>()).results[0] ?? null }
    async run(): Promise<D1Result> {
      if (realtimeQuery(this.sql) || retirementWrite(this.sql)) return (await query([this]))[0]
      const result = await this.raw().run(); recordD1Result(this.sql, result, enabled); return result
    }
  }
  return {
    prepare: sql => new Statement(sql),
    async batch(items) {
      const statements = items as Statement[]
      if (statements.every(s => realtimeQuery(s.sql))) return query(statements)
      if (statements.every(s => !realtimeQuery(s.sql) && !retirementWrite(s.sql))) {
        const results = d1.batch ? await d1.batch(statements.map(s => s.raw())) : await Promise.all(statements.map(s => s.raw().run()))
        results.forEach((r, i) => recordD1Result(statements[i].sql, r, enabled))
        return results
      }
      // Only idempotent schema bootstrap may span storage systems. Never
      // silently turn a multi-store data transaction into separate commits.
      if (!statements.every(s => /^CREATE\b/i.test(s.sql.trim()))) throw new Error('Cross-store transaction is not supported')
      const results: D1Result[] = []
      for (const statement of statements) results.push(await statement.run())
      return results
    },
  }
}
