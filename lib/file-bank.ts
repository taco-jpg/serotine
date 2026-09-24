import { openDB, type DBSchema, type IDBPTransaction } from "idb"
import { formatFileSize, safeFilename, validateAttachmentFile } from "./attachments"
import { nativeStorageLimits } from "./native-persistence"

export const BANK_MAX_BYTES = 5 * 1024 ** 3
export const BANK_MAX_FILES = 100
export function bankCapacityBytes(): number { return nativeStorageLimits()?.bankBytes ?? BANK_MAX_BYTES }
const EVENT = "serotine:file-bank"
const CHANNEL = "serotine-file-bank-v1"
const source = globalThis.crypto?.randomUUID?.() ?? String(Math.random())

export interface BankFile {
  id: string
  name: string
  mime: string
  size: number
  createdAt: number
  lastModified: number
}

interface FileBankDB extends DBSchema {
  // Only present in version 1; migrated atomically before version 2 opens.
  files: { key: string; value: BankFile & { blob: Blob } }
  metadata: { key: string; value: BankFile }
  blobs: { key: string; value: { id: string; blob: Blob } }
}

type BankWriteTransaction = IDBPTransaction<FileBankDB, ["metadata", "blobs"], "readwrite">

function validateOwner(owner: string) {
  if (!/^04[0-9a-f]{128}$/.test(owner)) throw new Error("A valid local identity is required to use Backpack.")
}

function storageError(cause: unknown): Error {
  if (cause instanceof Error && cause.name === "QuotaExceededError") return new Error(`This device is out of storage. Backpack supports up to ${formatFileSize(bankCapacityBytes())}, but your device may allow less. Free some storage and try again; your saved files were not removed.`)
  if (cause instanceof Error && ["SecurityError", "InvalidStateError", "UnknownError"].includes(cause.name)) return new Error("Browser storage is unavailable. Check this site's storage permissions and try again.")
  return cause instanceof Error ? cause : new Error("Unable to access saved files. Please try again.")
}

// Separate from message databases and identity backups; blobs stay in this browser.
async function initDB(owner: string) {
  validateOwner(owner)
  if (typeof indexedDB === "undefined") throw new Error("Backpack needs browser storage, which is unavailable here.")
  let migrationError: unknown
  try {
    return await openDB<FileBankDB>(`serotine-file-bank:${owner}`, 2, {
      upgrade(db, oldVersion, _newVersion, tx) {
        const metadata = db.createObjectStore("metadata", { keyPath: "id" })
        const blobs = db.createObjectStore("blobs", { keyPath: "id" })
        if (oldVersion !== 1) return
        // A cursor avoids loading the old bank into memory in one getAll(). The
        // upgrade transaction rolls back both stores if any copy fails.
        void (async () => {
          let cursor = await tx.objectStore("files").openCursor()
          while (cursor) {
            const { blob, ...entry } = cursor.value
            await metadata.add(entry)
            await blobs.add({ id: entry.id, blob })
            cursor = await cursor.continue()
          }
          db.deleteObjectStore("files")
        })().catch(cause => { migrationError = cause; try { tx.abort() } catch { /* Already aborted by IndexedDB. */ } })
      },
    })
  } catch (cause) { throw storageError(migrationError ?? cause) }
}

function notifyBankChanged(owner: string) {
  if (typeof window === "undefined") return
  const change = { owner, source }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: change }))
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(CHANNEL)
      channel.postMessage(change)
      channel.close()
    }
  } catch { /* Reopening the picker and focus refresh still load current files. */ }
}

export function subscribeToFileBank(owner: string, refresh: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const accept = (value: { owner?: unknown } | undefined) => { if (value?.owner === owner) refresh() }
  const local = (event: Event) => accept((event as CustomEvent).detail)
  window.addEventListener(EVENT, local)
  window.addEventListener("focus", refresh)
  let channel: BroadcastChannel | undefined
  try {
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL)
      channel.onmessage = event => { if (event.data?.source !== source) accept(event.data) }
    }
  } catch { /* Focus refresh is the fallback if cross-tab messaging is blocked. */ }
  return () => { window.removeEventListener(EVENT, local); window.removeEventListener("focus", refresh); channel?.close() }
}

async function writeBank(owner: string, write: (tx: BankWriteTransaction) => Promise<void>) {
  const db = await initDB(owner)
  try {
    const tx = db.transaction(["metadata", "blobs"], "readwrite")
    // Attach a rejection handler immediately; a quota error can abort before a request settles.
    const completion = tx.done
    void completion.catch(() => {})
    try {
      await write(tx)
      await completion
    } catch (cause) {
      try { tx.abort() } catch { /* The browser may already have aborted it. */ }
      await completion.catch(() => {})
      throw storageError(cause)
    }
    notifyBankChanged(owner)
  } finally { db.close() }
}

/** Approximate free storage shared with this site's messages and other data. */
export async function estimateBankStorage(): Promise<number | undefined> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return undefined
    const { quota, usage } = await navigator.storage.estimate()
    return typeof quota === "number" && Number.isFinite(quota) && typeof usage === "number" && Number.isFinite(usage)
      ? Math.max(0, quota - usage) : undefined
  } catch { return undefined }
}

let persistenceRequested = false
function requestPersistentStorage() {
  // Saving is an explicit user action. Do not request permission during a list,
  // refresh, or background operation, and do not treat persistence as more quota.
  if (persistenceRequested || typeof navigator === "undefined" || !navigator.storage?.persist || navigator.userActivation?.isActive === false) return
  persistenceRequested = true
  try { void navigator.storage.persist().catch(() => {}) } catch { /* Saving can still succeed without persistence. */ }
}

/** Validate and save the entire batch atomically, including quota checks across tabs. */
export async function saveBankFiles(owner: string, files: File[]): Promise<void> {
  validateOwner(owner)
  if (!files.length) return
  if (files.length > BANK_MAX_FILES) throw new Error(`Backpack holds up to ${BANK_MAX_FILES} files. Remove some files before adding more.`)
  const rows = files.map(file => {
    validateAttachmentFile(file)
    if (!(file instanceof Blob)) throw new Error("Choose a valid file.")
    const mime = file.type.split(";")[0].trim().toLowerCase() || "application/octet-stream"
    return { id: crypto.randomUUID(), name: safeFilename(file.name), mime, size: file.size,
      createdAt: Date.now(), lastModified: file.lastModified, blob: file.slice(0, file.size, mime) }
  })
  requestPersistentStorage()
  await writeBank(owner, async tx => {
    const metadata = tx.objectStore("metadata"), blobs = tx.objectStore("blobs")
    const existing = await metadata.getAll()
    if (existing.length + rows.length > BANK_MAX_FILES) throw new Error(`Backpack holds up to ${BANK_MAX_FILES} files. Remove some files before adding more.`)
    if ([...existing, ...rows].reduce((total, row) => total + row.size, 0) > bankCapacityBytes()) throw new Error(`Backpack has a ${formatFileSize(bankCapacityBytes()).replace(".0 ", " ")} limit. Remove some saved files before adding more.`)
    for (const { blob, ...entry } of rows) {
      await metadata.add(entry)
      await blobs.add({ id: entry.id, blob })
    }
  })
}

export async function listBankFiles(owner: string): Promise<BankFile[]> {
  const db = await initDB(owner)
  try { return (await db.getAll("metadata")).sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name)) }
  catch (cause) { throw storageError(cause) }
  finally { db.close() }
}

export async function getBankFile(owner: string, id: string): Promise<File> {
  const db = await initDB(owner)
  try {
    const tx = db.transaction(["metadata", "blobs"], "readonly")
    // Queue both reads together so a concurrent delete/rename cannot split them.
    const [row, content] = await Promise.all([
      tx.objectStore("metadata").get(id), tx.objectStore("blobs").get(id), tx.done,
    ])
    if (!row || !content) throw new Error("This saved file was removed. Choose another file.")
    const file = new File([content.blob], safeFilename(row.name), { type: row.mime, lastModified: row.lastModified })
    validateAttachmentFile(file)
    return file
  } catch (cause) { throw storageError(cause) }
  finally { db.close() }
}

export async function renameBankFile(owner: string, id: string, name: string): Promise<void> {
  if (!name.trim()) throw new Error("Enter a name for this file.")
  await writeBank(owner, async tx => {
    const metadata = tx.objectStore("metadata")
    const row = await metadata.get(id)
    if (!row) throw new Error("This saved file was removed. Choose another file.")
    await metadata.put({ ...row, name: safeFilename(name) })
  })
}

export async function deleteBankFile(owner: string, id: string): Promise<void> {
  await writeBank(owner, async tx => {
    await tx.objectStore("metadata").delete(id)
    await tx.objectStore("blobs").delete(id)
  })
}
