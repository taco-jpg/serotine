import { openDB, type DBSchema, type IDBPTransaction } from "idb"
import { safeFilename, validateAttachmentFile } from "./attachments"

export const BANK_MAX_BYTES = 50 * 1024 * 1024
export const BANK_MAX_FILES = 100
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
  blob: Blob
}

interface FileBankDB extends DBSchema {
  files: { key: string; value: BankFile }
}

function validateOwner(owner: string) {
  if (!/^04[0-9a-f]{128}$/.test(owner)) throw new Error("A valid local identity is required to use the file bank.")
}

function storageError(cause: unknown): Error {
  if (cause instanceof Error && cause.name === "QuotaExceededError") return new Error("This browser is out of storage. Remove some saved files and try again.")
  if (cause instanceof Error && ["SecurityError", "InvalidStateError", "UnknownError"].includes(cause.name)) return new Error("Browser storage is unavailable. Check this site's storage permissions and try again.")
  return cause instanceof Error ? cause : new Error("Unable to access saved files. Please try again.")
}

// Separate from message databases and identity backups; blobs stay in this browser.
async function initDB(owner: string) {
  validateOwner(owner)
  if (typeof indexedDB === "undefined") throw new Error("The file bank needs browser storage, which is unavailable here.")
  try {
    return await openDB<FileBankDB>(`serotine-file-bank:${owner}`, 1, {
      upgrade(db) { db.createObjectStore("files", { keyPath: "id" }) },
    })
  } catch (cause) { throw storageError(cause) }
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

async function writeBank(owner: string, write: (tx: IDBPTransaction<FileBankDB, ["files"], "readwrite">) => Promise<void>) {
  const db = await initDB(owner)
  try {
    const tx = db.transaction("files", "readwrite")
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

/** Validate and save the entire batch atomically, including quota checks across tabs. */
export async function saveBankFiles(owner: string, files: File[]): Promise<void> {
  validateOwner(owner)
  if (!files.length) return
  if (files.length > BANK_MAX_FILES) throw new Error(`The file bank holds up to ${BANK_MAX_FILES} files. Remove some files before adding more.`)
  const rows = files.map(file => {
    validateAttachmentFile(file)
    if (!(file instanceof Blob)) throw new Error("Choose a valid file.")
    const mime = file.type.split(";")[0].trim().toLowerCase() || "application/octet-stream"
    return { id: crypto.randomUUID(), name: safeFilename(file.name), mime, size: file.size,
      createdAt: Date.now(), lastModified: file.lastModified, blob: file.slice(0, file.size, mime) }
  })
  await writeBank(owner, async tx => {
    const existing = await tx.store.getAll()
    if (existing.length + rows.length > BANK_MAX_FILES) throw new Error(`The file bank holds up to ${BANK_MAX_FILES} files. Remove some files before adding more.`)
    if ([...existing, ...rows].reduce((total, row) => total + row.size, 0) > BANK_MAX_BYTES) throw new Error("The file bank has a 50 MB limit. Remove some files before adding more.")
    for (const row of rows) await tx.store.add(row)
  })
}

export async function listBankFiles(owner: string): Promise<BankFile[]> {
  const db = await initDB(owner)
  try { return (await db.getAll("files")).sort((a, b) => b.createdAt - a.createdAt || a.name.localeCompare(b.name)) }
  catch (cause) { throw storageError(cause) }
  finally { db.close() }
}

export async function getBankFile(owner: string, id: string): Promise<File> {
  const db = await initDB(owner)
  try {
    const row = await db.get("files", id)
    if (!row) throw new Error("This saved file was removed. Choose another file.")
    const file = new File([row.blob], safeFilename(row.name), { type: row.mime, lastModified: row.lastModified })
    validateAttachmentFile(file)
    return file
  } catch (cause) { throw storageError(cause) }
  finally { db.close() }
}

export async function renameBankFile(owner: string, id: string, name: string): Promise<void> {
  if (!name.trim()) throw new Error("Enter a name for this file.")
  await writeBank(owner, async tx => {
    const row = await tx.store.get(id)
    if (!row) throw new Error("This saved file was removed. Choose another file.")
    await tx.store.put({ ...row, name: safeFilename(name) })
  })
}

export async function deleteBankFile(owner: string, id: string): Promise<void> {
  await writeBank(owner, async tx => { await tx.store.delete(id) })
}
