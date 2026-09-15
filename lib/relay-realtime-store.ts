import type { D1DatabaseBinding } from './db'
import { REALTIME_TABLES, realtimeQuery, recordD1Result, type Query } from './storage-routing'

interface SqlCursor { toArray(): Record<string, unknown>[]; rowsWritten: number; rowsRead: number }
interface State {
  storage: { sql: { exec(sql: string, ...values: unknown[]): SqlCursor }; transactionSync<T>(fn: () => T): T }
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>
}
interface Env { serotine_db: D1DatabaseBinding; SEROTINE_D1_METRICS?: string }

/** Nonces, leases, presence and encrypted signaling live here, alongside the
 * permanent membership anti-rollback checkpoint. WebSocket attachments remain
 * in CallSignalingHub. D1 keeps durable delivery history and identity retirement.
 * There is deliberately no public route to this object's SQL interface. */
export class RelayRealtimeStore {
  private initialized = false
  constructor(private ctx: State, private env: Env) {}

  private async initialize() {
    if (this.initialized) return
    const sql = this.ctx.storage.sql
    sql.exec('CREATE TABLE IF NOT EXISTS _RelayImport (name TEXT PRIMARY KEY, cursor INTEGER NOT NULL, complete INTEGER NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS RetiredIdentity (publicKey TEXT PRIMARY KEY, retiredAt INTEGER NOT NULL)')
    // Resume the copy after interruption. Never delete source tables or replay
    // an already imported snapshot over live DO state. Import sequence numbers
    // explicitly, preserving client cursors and outstanding multi-device calls.
    const started = Date.now()
    // Fence the old D1 writers BEFORE copying their state. An old Worker still
    // finishing a deployment request must fail/retry, never create a second
    // authority for device claims or consume a nonce after the snapshot.
    const { results: sources } = await this.env.serotine_db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>()
    const fences = sources.filter(row => (REALTIME_TABLES as readonly string[]).includes(row.name)).flatMap(({ name }) =>
      ['INSERT', 'UPDATE', 'DELETE'].map(operation => `CREATE TRIGGER IF NOT EXISTS serotine_v2_fence_${name}_${operation.toLowerCase()}
        BEFORE ${operation} ON ${name} BEGIN SELECT RAISE(ABORT, 'Realtime storage moved; retry on the current Worker'); END`))
    if (fences.length) {
      if (!this.env.serotine_db.batch) throw new Error('Transactional D1 batch is required for cutover')
      const results = await this.env.serotine_db.batch(fences.map(sql => this.env.serotine_db.prepare(sql)))
      results.forEach((r, i) => recordD1Result(fences[i], r, this.env.SEROTINE_D1_METRICS === '1'))
    }
    for (const name of [...REALTIME_TABLES, 'RetiredIdentity']) {
      const progress = sql.exec('SELECT cursor, complete FROM _RelayImport WHERE name = ?', name).toArray()[0]
      if (progress?.complete) continue
      const source = await this.env.serotine_db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first<{ sql: string }>()
      if (source) {
        sql.exec(source.sql.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS '))
        let cursor = Number(progress?.cursor ?? 0)
        while (true) {
          const { results } = await this.env.serotine_db.prepare(`SELECT rowid AS _sourceRowid, * FROM ${name} WHERE rowid > ? ORDER BY rowid LIMIT 32`).bind(cursor).all<Record<string, unknown>>()
          this.ctx.storage.transactionSync(() => {
            for (const { _sourceRowid, ...row } of results) {
              const columns = Object.keys(row)
              sql.exec(`INSERT OR IGNORE INTO ${name} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, ...Object.values(row))
              cursor = Number(_sourceRowid)
            }
            sql.exec('INSERT INTO _RelayImport VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor, complete=excluded.complete', name, cursor, Number(results.length < 32))
          })
          if (results.length < 32) break
          // Stay below blockConcurrencyWhile's 30-second deadline. A later
          // request continues from the committed page, never a partial row.
          if (Date.now() - started > 15_000) throw new Error('Realtime migration is continuing; retry')
        }
        const { results: indexes } = await this.env.serotine_db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL").bind(name).all<{ sql: string }>()
        for (const index of indexes) sql.exec(index.sql.replace(/^CREATE (UNIQUE )?INDEX /i, 'CREATE $1INDEX IF NOT EXISTS '))
      } else sql.exec('INSERT OR IGNORE INTO _RelayImport VALUES (?, 0, 1)', name)
    }
    this.initialized = true
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/query') return new Response('Not found', { status: 404 })
    const queries = await request.json() as Query[]
    if (!Array.isArray(queries) || queries.length > 64 || queries.some(q => typeof q.sql !== 'string' || !Array.isArray(q.values)
      || !(realtimeQuery(q.sql) || /\bsqlite_master\b/.test(q.sql) || /^INSERT OR IGNORE INTO RetiredIdentity\b/.test(q.sql)))) {
      return new Response('Invalid internal query', { status: 400 })
    }
    try {
      return await this.ctx.blockConcurrencyWhile(async () => {
        await this.initialize()
        // Serialize permanent retirement with all call mutations. D1 commits
        // first; retries repair a crash before the local copy. Refresh existing
        // retirements before each request too, covering old-version in-flight
        // retirements and interrupted cross-store commits without stale access.
        const cursor = Number(this.ctx.storage.sql.exec("SELECT cursor FROM _RelayImport WHERE name='RetiredIdentity'").toArray()[0]?.cursor ?? 0)
        const { results: retired } = await this.env.serotine_db.prepare('SELECT rowid AS _sourceRowid, publicKey, retiredAt FROM RetiredIdentity WHERE rowid > ? ORDER BY rowid').bind(cursor).all<{ _sourceRowid: number; publicKey: string; retiredAt: number }>()
        for (const row of retired) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO RetiredIdentity VALUES (?, ?)', row.publicKey, row.retiredAt)
        if (retired.length) this.ctx.storage.sql.exec("UPDATE _RelayImport SET cursor=? WHERE name='RetiredIdentity'", retired.at(-1)!._sourceRowid)
        const results: { results: Record<string, unknown>[]; meta: { changes: number; rows_written: number; rows_read: number } }[] = []
        for (const q of queries) {
          if (/^INSERT OR IGNORE INTO RetiredIdentity\b/.test(q.sql)) {
            if (queries.length !== 1) throw new Error('Retirement must be a single operation')
            const r = await this.env.serotine_db.prepare(q.sql).bind(...q.values).run()
            recordD1Result(q.sql, r, this.env.SEROTINE_D1_METRICS === '1')
            this.ctx.storage.sql.exec(q.sql, ...q.values)
            return Response.json([{ ...r, results: [] }])
          }
        }
        this.ctx.storage.transactionSync(() => {
          for (const q of queries) {
            const cursor = this.ctx.storage.sql.exec(q.sql, ...q.values)
            const rows = cursor.toArray()
            const changes = /^(INSERT|UPDATE|DELETE)\b/.test(q.sql.trim())
              ? Number(this.ctx.storage.sql.exec('SELECT changes() AS n').toArray()[0].n) : 0
            results.push({ results: rows, meta: { changes, rows_written: cursor.rowsWritten, rows_read: cursor.rowsRead } })
          }
        })
        return Response.json(results)
      })
    } catch { return new Response('Realtime storage unavailable', { status: 503 }) }
  }
}
