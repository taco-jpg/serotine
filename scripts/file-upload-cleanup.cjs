#!/usr/bin/env node
// Schedule this bounded sweep every minute or hour in your existing scheduler.
// It needs no user identity, Cloudflare token, or access to attachment plaintext.
const { webcrypto } = require('node:crypto')

async function main() {
  const site = process.argv[2]
  if (!site || process.argv.length !== 3) throw new Error('Usage: node scripts/file-upload-cleanup.cjs https://your-serotine-site.example')
  const url = new URL(site)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a bare HTTPS site origin, or localhost for local testing.')
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicKey = Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)).toString('hex')
  for (let sweep = 0; sweep < 6; sweep += 1) {
    const action = 'file:cleanup'
    const data = {}
    const proof = { publicKey, timestamp: Date.now(), nonce: webcrypto.randomUUID() }
    const text = JSON.stringify(['serotine:request:v2', action, proof.publicKey, proof.timestamp, proof.nonce, data])
    proof.signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(text))).toString('hex')
    const response = await fetch(new URL('/api/files', url), { method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', origin: url.origin },
      body: JSON.stringify({ version: 1, action, data, proof }), signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`File cleanup failed (HTTP ${response.status}). Check the deployed R2/D1 bindings and retry.`)
    const result = await response.json()
    if (result.success !== true) throw new Error('The file cleanup endpoint returned an unexpected response.')
  }
  process.stdout.write('Completed six bounded file cleanup sweeps (up to 24 expired uploads).\n')
}
main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
