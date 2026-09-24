import { registerNativeStorageBarrier } from "../../lib/native-persistence"

/** Prototype snapshot ceiling, including base64 expansion. This is deliberately
 * smaller than the browser's 5 GB Backpack limit. Native large-file storage must
 * become incremental before that capacity can be advertised for installed apps. */
export const NATIVE_SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024
const FORMAT = "serotine-native-storage"
const DB_NAME = /^(?:chat-storage|serotine-(?:messages|events|file-bank|verified-attachments):04[0-9a-f]{128})$/
const LOCAL_KEY = /^serotine[_.:]/
export function assertNativeDatabaseName(name: string): void {
  if (!DB_NAME.test(name)) throw fail("This installed-app version cannot safely persist the requested database. Update Serotine before continuing.")
}
type Encoded = [string, ...unknown[]]
interface SavedIndex { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }
interface SavedStore { name: string; keyPath: string | string[] | null; indexes: SavedIndex[]; rows: { key: Encoded; value: Encoded }[] }
interface SavedDatabase { name: string; version: number; stores: SavedStore[] }
interface Snapshot { format: typeof FORMAT; version: 1; local: [string, string][]; databases: SavedDatabase[] }
export interface NativeSnapshotStore {
  /** null is permitted only for a genuinely pristine native store. */
  readSnapshot(): Promise<string | null>
  /** Resolve only after encrypted, app-private, atomic durable replacement. */
  writeSnapshot(value: string): Promise<void>
}

function fail(message = "Installed-app storage is unavailable. Close and reopen the app to recover the last saved state; do not clear app data."): Error {
  return new Error(message)
}
function base64(bytes: Uint8Array): string {
  let text = ""
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(text)
}
function unbase64(text: unknown): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw fail("The saved native data is damaged. Nothing was replaced.")
  return Uint8Array.from(atob(text), character => character.charCodeAt(0))
}

/** Tag every value, including plain objects, so user data cannot impersonate a
 * binary tag. Blobs are included: losing a verified copy must never authorize
 * deletion of the only remaining attachment at the relay. */
export async function encodeNativeValue(value: unknown, depth = 0): Promise<Encoded> {
  if (depth > 64) throw fail("The stored data is nested too deeply to save safely.")
  if (value === null) return ["null"]
  if (value === undefined) return ["undefined"]
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value]
  if (typeof value === "number" && Number.isFinite(value)) return ["number", value]
  if (value instanceof Date && Number.isFinite(value.getTime())) return ["date", value.toISOString()]
  if (value instanceof Blob) {
    if (value.size > NATIVE_SNAPSHOT_MAX_BYTES * 0.7) throw fail("This file exceeds the installed beta's local storage limit. The previous saved state is intact.")
    return ["blob", value.type, base64(new Uint8Array(await value.arrayBuffer()))]
  }
  if (value instanceof ArrayBuffer) return ["buffer", base64(new Uint8Array(value))]
  if (value instanceof Uint8Array) return ["bytes", base64(value)]
  if (Array.isArray(value)) return ["array", await Promise.all(value.map(item => encodeNativeValue(item, depth + 1)))]
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return ["object", await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encodeNativeValue(item, depth + 1)]))]
  }
  throw fail("This installed-app version cannot safely save a stored value. The previous saved state is intact.")
}

export function decodeNativeValue(value: unknown, depth = 0): unknown {
  if (depth > 64 || !Array.isArray(value) || typeof value[0] !== "string") throw fail("The saved native data is damaged. Nothing was replaced.")
  const [tag, item] = value
  if (tag === "null" && value.length === 1) return null
  if (tag === "undefined" && value.length === 1) return undefined
  if ((tag === "string" || tag === "boolean") && typeof item === tag && value.length === 2) return item
  if (tag === "number" && typeof item === "number" && Number.isFinite(item) && value.length === 2) return item
  if (tag === "date" && typeof item === "string" && Number.isFinite(Date.parse(item)) && value.length === 2) return new Date(item)
  if (tag === "blob" && typeof item === "string" && value.length === 3) return new Blob([unbase64(value[2])], { type: item })
  if (tag === "buffer" && value.length === 2) return unbase64(item).buffer
  if (tag === "bytes" && value.length === 2) return unbase64(item)
  if (tag === "array" && Array.isArray(item) && value.length === 2) return item.map(entry => decodeNativeValue(entry, depth + 1))
  if (tag === "object" && Array.isArray(item) && value.length === 2) {
    const output: Record<string, unknown> = {}
    for (const pair of item) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || Object.hasOwn(output, pair[0])) throw fail("The saved native data is damaged. Nothing was replaced.")
      Object.defineProperty(output, pair[0], { enumerable: true, writable: true, configurable: true, value: decodeNativeValue(pair[1], depth + 1) })
    }
    return output
  }
  throw fail("The saved native data is damaged. Nothing was replaced.")
}

function validKeyPath(value: unknown): value is string | string[] { return typeof value === "string" || Array.isArray(value) && value.every(key => typeof key === "string") }
function namesUnique(values: { name: string }[]): boolean { return new Set(values.map(value => value.name)).size === values.length }

/** Validate the complete envelope and every encoded record before touching the
 * WebView cache. Authentication/decryption belongs to the native OS adapter. */
export function parseNativeSnapshot(text: string): Snapshot {
  if (new TextEncoder().encode(text).length > NATIVE_SNAPSHOT_MAX_BYTES) throw fail("The saved native data exceeds this app version's storage limit.")
  let value: Snapshot
  try { value = JSON.parse(text) as Snapshot } catch { throw fail("The saved native data is damaged. Nothing was replaced.") }
  if (value?.format !== FORMAT || value.version !== 1 || !Array.isArray(value.local) || !Array.isArray(value.databases)
    || value.local.length > 100_000 || value.databases.length > 400) throw fail("The saved native data has an unsupported format. Nothing was replaced.")
  const local = new Set<string>()
  for (const pair of value.local) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !LOCAL_KEY.test(pair[0]) || typeof pair[1] !== "string" || local.has(pair[0])) throw fail("The saved native settings are damaged. Nothing was replaced.")
    local.add(pair[0])
  }
  if (!namesUnique(value.databases)) throw fail("The saved native databases are duplicated. Nothing was replaced.")
  for (const db of value.databases) {
    if (!db || !DB_NAME.test(db.name) || !Number.isSafeInteger(db.version) || db.version < 1 || !Array.isArray(db.stores) || db.stores.length > 20 || !namesUnique(db.stores)) throw fail("The saved native database is damaged. Nothing was replaced.")
    for (const store of db.stores) {
      if (typeof store.name !== "string" || !store.name || store.keyPath !== null && !validKeyPath(store.keyPath)
        || !Array.isArray(store.indexes) || store.indexes.length > 20 || !namesUnique(store.indexes)
        || !Array.isArray(store.rows) || store.rows.length > 250_000) throw fail("The saved native database schema is damaged. Nothing was replaced.")
      for (const index of store.indexes) if (!index || typeof index.name !== "string" || !validKeyPath(index.keyPath) || typeof index.unique !== "boolean" || typeof index.multiEntry !== "boolean") throw fail("The saved native index is damaged. Nothing was replaced.")
      for (const row of store.rows) {
        if (!row || typeof row !== "object") throw fail("The saved native record is damaged. Nothing was replaced.")
        const key = decodeNativeValue(row.key) as IDBValidKey, decoded = decodeNativeValue(row.value)
        try {
          indexedDB.cmp(key, key)
          if (store.keyPath !== null) {
            const atPath = (path: string) => path === "" ? decoded : path.split(".").reduce<unknown>((value, part) => value && typeof value === "object" ? Reflect.get(value, part) : undefined, decoded)
            const inline = Array.isArray(store.keyPath) ? store.keyPath.map(atPath) : atPath(store.keyPath)
            if (indexedDB.cmp(key, inline as IDBValidKey) !== 0) throw fail()
          }
        } catch { throw fail("The saved native record key is damaged. Nothing was replaced.") }
      }
    }
  }
  return value
}

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error ?? fail()) })
}
function completed(tx: IDBTransaction): Promise<void> {
  const result = new Promise<void>((resolve, reject) => {
    tx.addEventListener("complete", () => resolve(), { once: true })
    tx.addEventListener("abort", () => reject(tx.error ?? fail()), { once: true })
    tx.addEventListener("error", () => reject(tx.error ?? fail()), { once: true })
  })
  void result.catch(() => {})
  return result
}
async function databases(): Promise<IDBDatabaseInfo[]> {
  if (typeof indexedDB?.databases !== "function") throw fail("This system WebView cannot safely enumerate installed-app data. Update the system WebView before opening Serotine.")
  const all = await indexedDB.databases()
  for (const db of all) if (db.name?.startsWith("serotine-")) assertNativeDatabaseName(db.name)
  return all.filter(db => db.name && DB_NAME.test(db.name))
}
function localValues(): [string, string][] {
  const values: [string, string][] = []
  for (let at = 0; at < localStorage.length; at++) {
    const key = localStorage.key(at)
    if (key && LOCAL_KEY.test(key)) { const value = localStorage.getItem(key); if (value !== null) values.push([key, value]) }
  }
  return values.sort(([left], [right]) => left.localeCompare(right))
}

async function capture(): Promise<Snapshot> {
  const output: SavedDatabase[] = []
  const all = await databases()
  if (all.length > 400) throw fail("The installed beta's database limit was reached. The previous saved state is intact.")
  for (const info of all.sort((left, right) => left.name!.localeCompare(right.name!))) {
    const db = await request(indexedDB.open(info.name!, info.version))
    try {
      const names = [...db.objectStoreNames]
      if (names.length > 20) throw fail("This installed-app version cannot safely save the database schema.")
      const saved: SavedDatabase = { name: db.name, version: db.version, stores: [] }
      if (names.length) {
        const tx = db.transaction(names, "readonly"), done = completed(tx)
        const collected = await Promise.all(names.map(async name => {
          const store = tx.objectStore(name)
          if (store.autoIncrement) throw fail("This app version cannot safely snapshot an auto-increment database.")
          const indexes = [...store.indexNames].map(indexName => { const index = store.index(indexName); return { name: index.name, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry } })
          const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
          if (indexes.length > 20 || keys.length > 250_000) throw fail("The installed beta's database limit was reached. The previous saved state is intact.")
          return { name, keyPath: store.keyPath, indexes, keys, values }
        }))
        await done
        for (const store of collected) saved.stores.push({ name: store.name, keyPath: store.keyPath, indexes: store.indexes,
          rows: await Promise.all(store.keys.map(async (key, index) => ({ key: await encodeNativeValue(key), value: await encodeNativeValue(store.values[index]) }))) })
      }
      output.push(saved)
    } finally { db.close() }
  }
  const local = localValues()
  if (local.length > 100_000) throw fail("The installed beta's settings limit was reached. The previous saved state is intact.")
  return { format: FORMAT, version: 1, local, databases: output }
}

async function restore(snapshot: Snapshot): Promise<void> {
  // Only run before any application database connections or React effects exist.
  for (const info of await databases()) {
    const deletion = indexedDB.deleteDatabase(info.name!)
    deletion.onblocked = () => { /* This process is single-instance; startup will remain blocked rather than mount unsafe data. */ }
    await request(deletion)
  }
  for (const saved of snapshot.databases) {
    const opening = indexedDB.open(saved.name, saved.version)
    opening.onupgradeneeded = () => {
      const db = opening.result
      for (const store of saved.stores) {
        const created = db.createObjectStore(store.name, { keyPath: store.keyPath })
        for (const index of store.indexes) created.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry })
      }
    }
    const db = await request(opening)
    try {
      if (!saved.stores.length) continue
      const tx = db.transaction(saved.stores.map(store => store.name), "readwrite"), done = completed(tx)
      try {
        for (const store of saved.stores) for (const row of store.rows) {
          const value = decodeNativeValue(row.value), key = decodeNativeValue(row.key) as IDBValidKey
          if (store.keyPath === null) tx.objectStore(store.name).add(value, key)
          else tx.objectStore(store.name).add(value)
        }
        await done
      } catch (error) { try { tx.abort() } catch { /* Already aborted. */ } await done.catch(() => {}); throw error }
    } finally { db.close() }
  }
  for (const [key] of localValues()) localStorage.removeItem(key)
  for (const [key, value] of snapshot.local) localStorage.setItem(key, value)
}

interface PersistenceController { assertReady(): void; changed(): Promise<void>; flush(): Promise<void> }
let controller: PersistenceController | undefined
export function assertNativePersistenceReady(): void {
  if (!controller) throw fail("Native storage has not finished opening. Messaging has not started.")
  controller.assertReady()
}
export function persistNativeMutation(): Promise<void> {
  assertNativePersistenceReady()
  return controller!.changed()
}

/** Native startup must await this function BEFORE importing/mounting the UI.
 * Native storage is authoritative; WebView localStorage/IndexedDB are rebuildable
 * working caches. The native layer must separately exclude them from OS backup.
 * Errors are sticky: no more network or durable writes until safe restart. */
export async function initializeNativePersistence(bridge: NativeSnapshotStore, onFailure: (error: Error) => void = () => {}): Promise<{ flush(): Promise<void> }> {
  if (controller) throw fail("Native storage was already initialized.")
  let fatal: Error | undefined
  let generation = 0, durableGeneration = 0
  let writing: Promise<void> | undefined
  const announce = (state: "saving" | "saved" | "error") => window.dispatchEvent(new CustomEvent("serotine:native-storage", { detail: { state } }))
  const assertReady = () => { if (fatal) throw fatal }
  const report = (cause: unknown) => {
    if (!fatal) { fatal = cause instanceof Error ? cause : fail(); announce("error"); onFailure(fatal) }
    return fatal
  }
  const flush = async (): Promise<void> => {
    assertReady()
    if (!writing && generation > durableGeneration) {
      writing = (async () => {
        announce("saving")
        try {
          while (generation > durableGeneration) {
            const current = generation
            const snapshot = JSON.stringify(await capture())
            if (new TextEncoder().encode(snapshot).length > NATIVE_SNAPSHOT_MAX_BYTES) throw fail("The installed beta's 64 MiB local storage limit was reached. Reopen to recover the previous saved state; do not clear app data.")
            await bridge.writeSnapshot(snapshot)
            durableGeneration = current
          }
        } catch (cause) { throw report(cause) }
        finally { writing = undefined }
      })()
    }
    await writing
    assertReady()
    // Announce only after the running-writer slot is free: a settings listener
    // may enqueue another change synchronously in response to this event.
    if (generation === durableGeneration) announce("saved")
  }
  const changed = (): Promise<void> => { assertReady(); generation++; return flush() }
  try {
    const saved = await bridge.readSnapshot()
    if (saved !== null) await restore(parseNativeSnapshot(saved))
    else {
      if (localValues().length || (await databases()).length) throw fail("Native saved data is missing but WebView data exists. Messaging is stopped to protect your identity; do not clear app data.")
      // Establish the empty native envelope before offering Create or Restore.
      await bridge.writeSnapshot(JSON.stringify({ format: FORMAT, version: 1, local: [], databases: [] }))
    }
    const originalSet = Storage.prototype.setItem, originalRemove = Storage.prototype.removeItem, originalClear = Storage.prototype.clear
    const schedule = () => { void changed().catch(() => { /* report() already froze the UI. */ }) }
    Storage.prototype.setItem = function (key, value) { assertReady(); originalSet.call(this, key, value); if (this === localStorage && LOCAL_KEY.test(String(key))) schedule() }
    Storage.prototype.removeItem = function (key) { assertReady(); originalRemove.call(this, key); if (this === localStorage && LOCAL_KEY.test(String(key))) schedule() }
    Storage.prototype.clear = function () { assertReady(); originalClear.call(this); if (this === localStorage) schedule() }
    controller = { assertReady, changed, flush }
    registerNativeStorageBarrier(flush)
    return { flush }
  } catch (cause) { throw report(cause) }
}
