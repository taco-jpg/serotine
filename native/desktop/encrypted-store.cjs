const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { MAX_SNAPSHOT_BYTES, decodeBase64 } = require('./security.cjs')
const AAD = Buffer.from('serotine-native-snapshot-v1')

async function exists(file) {
  try { await fs.stat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function atomicWrite(file, bytes) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close(); handle = undefined
    await fs.rename(temp, file)
    // fsync the directory entry where supported. Windows does not allow opening directories this way.
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temp).catch(() => undefined)
  }
}

class EncryptedStore {
  constructor(directory, safeStorage, platform = process.platform) {
    this.directory = directory
    this.file = path.join(directory, 'snapshot.v1.json')
    this.marker = path.join(directory, 'initialized.v1')
    this.safeStorage = safeStorage
    this.platform = platform
    this.queue = Promise.resolve()
    this.pendingWrites = 0
    this.pendingReads = 0
    this.pendingFlushes = 0
    this.resetting = false
  }
  available() {
    if (!this.safeStorage.isEncryptionAvailable()
      || (this.platform === 'linux' && ['basic_text', 'unknown'].includes(this.safeStorage.getSelectedStorageBackend()))) {
      throw new Error('OS-protected storage is unavailable. Unlock your system keychain and restart Serotine. Local data has not been replaced.')
    }
  }
  async load() {
    this.available()
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const present = await exists(this.file), marked = await exists(this.marker)
    if (!present) {
      const interrupted = (await fs.readdir(this.directory)).some(name => name.startsWith('snapshot.v1.json.'))
      if (marked || interrupted) throw new Error('Serotine local data is missing or interrupted. Restore a known encrypted backup; a replacement identity was not created.')
      return null
    }
    const stat = await fs.stat(this.file)
    if (stat.size > MAX_SNAPSHOT_BYTES * 1.4 + 65536) throw new Error('The encrypted local snapshot is too large.')
    let key
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'))
      if (data.version !== 1) throw new Error('format')
      key = decodeBase64(this.safeStorage.decryptString(decodeBase64(data.protectedKey, 32768)), 32)
      if (key.length !== 32) throw new Error('key')
      const iv = decodeBase64(data.iv, 12), tag = decodeBase64(data.tag, 16)
      if (iv.length !== 12 || tag.length !== 16) throw new Error('format')
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAAD(AAD); decipher.setAuthTag(tag)
      const value = Buffer.concat([decipher.update(decodeBase64(data.ciphertext, MAX_SNAPSHOT_BYTES)), decipher.final()]).toString('utf8')
      // A crash after the first snapshot rename is recoverable even before the sentinel is created.
      if (!marked) await atomicWrite(this.marker, Buffer.from('1\n'))
      return value
    } catch {
      throw new Error('Serotine could not unlock its saved data. The encrypted snapshot is intact. Unlock your system keychain or restore an encrypted backup.')
    } finally { key?.fill(0) }
  }
  read() {
    if (this.resetting) return Promise.reject(new Error('Local data removal is in progress.'))
    this.pendingReads++
    return this.queue.then(() => this.load()).finally(() => { this.pendingReads-- })
  }
  write(value) {
    if (this.resetting) return Promise.reject(new Error('Local data removal is in progress.'))
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_SNAPSHOT_BYTES) return Promise.reject(new Error('The native snapshot exceeds the 64 MiB prototype limit. Export a backup before removing local files.'))
    const run = async () => {
      // Never silently overwrite data whose OS key is missing or whose authentication failed.
      await this.load()
      const key = crypto.randomBytes(32), iv = crypto.randomBytes(12)
      try {
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
        cipher.setAAD(AAD)
        const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
        const data = { version: 1, protectedKey: this.safeStorage.encryptString(key.toString('base64')).toString('base64'),
          iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
        await atomicWrite(this.file, Buffer.from(JSON.stringify(data)))
        await atomicWrite(this.marker, Buffer.from('1\n'))
      } finally { key.fill(0) }
    }
    this.pendingWrites++
    const pending = this.queue.then(run)
    this.queue = pending.then(() => { this.pendingWrites-- }, () => { this.pendingWrites-- })
    return pending
  }
  flush() {
    this.pendingFlushes++
    return this.queue.finally(() => { this.pendingFlushes-- })
  }
  async reset() {
    if (this.resetting || this.pendingWrites || this.pendingReads || this.pendingFlushes) {
      throw new Error('Local data is busy. Close and reopen Serotine before trying recovery again.')
    }
    this.resetting = true
    try {
      // Deliberate recovery is the only path which discards an unreadable envelope or missing OS key.
      // The caller must validate the exact typed phrase and obtain native user confirmation.
      await fs.rm(this.directory, { recursive: true, force: true })
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    } finally { this.resetting = false }
  }
}
module.exports = { EncryptedStore, atomicWrite }
