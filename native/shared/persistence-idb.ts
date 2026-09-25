/** Native bundle alias for `idb`. The build must resolve this file's own idb
 * import to the original package. Browser builds continue using unmodified idb.
 * Request success is NOT durability: transaction.done and database shorthand
 * mutations resolve only after the native encrypted snapshot has committed. */
import { openDB as originalOpenDB, deleteDB as originalDeleteDB } from "idb"
import type { DBSchema, OpenDBCallbacks } from "idb"
import { assertNativeDatabaseName, assertNativePersistenceReady, persistNativeMutation } from "./persistence"
export type { DBSchema, IDBPTransaction, IDBPDatabase } from "idb"

const mutationMethods = new Set(["put", "add", "delete", "clear", "update"])
const cursorMethods = new Set(["openCursor", "openKeyCursor", "continue", "advance", "continuePrimaryKey"])

// These proxies retain idb's original receiver because idb's own unwrap map
// cannot recognize a second proxy. No native IDB prototypes are modified.
export function durableTransaction<T extends object>(transaction: T): T {
  const tx = transaction as T & { mode: string; done: Promise<void> }
  if (tx.mode === "readonly") return transaction
  let changed = false
  const cache = new WeakMap<object, object>()
  const completion = tx.done.then(async () => { if (changed) await persistNativeMutation() })
  // A native disk error must not become an unhandled rejection when a request
  // fails first and its caller takes the abort path.
  void completion.catch(() => {})
  const handle = (value: object): object => {
    const known = cache.get(value)
    if (known) return known
    const proxy = new Proxy(value, {
      get(target, property) {
        if (target === transaction && property === "done") return completion
        const found = Reflect.get(target, property, target)
        if (property === "store" && found) return handle(found)
        if (typeof found !== "function") return found
        return (...args: unknown[]) => {
          if (property !== "abort") assertNativePersistenceReady()
          if (mutationMethods.has(String(property))) changed = true
          const result = Reflect.apply(found, target, args)
          if (property === "objectStore" || property === "index") return handle(result as object)
          if (cursorMethods.has(String(property))) return Promise.resolve(result).then(cursor => cursor ? handle(cursor) : cursor)
          return result
        }
      },
    })
    cache.set(value, proxy)
    return proxy
  }
  return handle(transaction) as T
}

export async function openDB<DBTypes extends DBSchema | unknown = unknown>(name: string, version?: number, callbacks?: OpenDBCallbacks<DBTypes>) {
  assertNativePersistenceReady()
  assertNativeDatabaseName(name)
  let upgraded = false
  const database = await originalOpenDB<DBTypes>(name, version, {
    ...callbacks,
    upgrade(...args) { upgraded = true; callbacks?.upgrade?.(...args) },
  })
  if (upgraded) {
    try { await persistNativeMutation() } catch (error) { database.close(); throw error }
  }
  return new Proxy(database, {
    get(target, property) {
      const found = Reflect.get(target, property, target)
      if (typeof found !== "function") return found
      return (...args: unknown[]) => {
        if (property !== "close") assertNativePersistenceReady()
        const result = Reflect.apply(found, target, args)
        if (property === "transaction") return durableTransaction(result as object)
        if (mutationMethods.has(String(property))) return Promise.resolve(result).then(async value => { await persistNativeMutation(); return value })
        return result
      }
    },
  })
}

export const deleteDB: typeof originalDeleteDB = async (...args) => {
  assertNativePersistenceReady()
  assertNativeDatabaseName(args[0])
  await originalDeleteDB(...args)
  await persistNativeMutation()
}
