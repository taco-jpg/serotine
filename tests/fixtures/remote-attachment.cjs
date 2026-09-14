// Signed-message metadata fixture; no file bytes are allocated or uploaded.
module.exports = function remoteAttachment(size = 1024 ** 3) {
  const chunks = Math.ceil(size / (4 * 1024 ** 2))
  return { id: crypto.randomUUID(), name: 'large-file.bin', mime: 'application/octet-stream', size, chunks,
    sha256: 'a'.repeat(64), kind: 'file', remote: { version: 1, chunkBytes: 4 * 1024 ** 2,
      capability: 'b'.repeat(64), key: 'c'.repeat(64), ivPrefix: 'd'.repeat(16), hashes: Array(chunks).fill('e'.repeat(64)) } }
}
