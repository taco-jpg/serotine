const path = require('node:path')

const APP_URL = 'serotine://app/'
const RELEASE_URL = 'https://github.com/taco-jpg/serotine/releases'
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_REQUEST_BYTES = 8 * 1024 * 1024
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
const ROUTES = new Map([
  ['/api/relay', ['POST']], ['/api/calls', ['POST']], ['/api/direct', ['POST']],
  ['/api/groups', ['POST']], ['/api/retention', ['POST']], ['/api/files', ['GET', 'POST', 'PUT']],
  ['/api/plugins/summary', ['POST']], ['/api/giphy/config', ['GET']],
])
const ALLOWED_HEADERS = new Set(['accept', 'content-type', 'x-serotine-events', 'x-serotine-file-request'])

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function trustedURL(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'serotine:' && url.hostname === 'app' && !url.port && !url.username && !url.password
  } catch { return false }
}
function assertSender(event, window) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || !event.senderFrame
    || event.senderFrame !== window.webContents.mainFrame || !trustedURL(event.senderFrame.url)) {
    throw new Error('Untrusted native request.')
  }
}
function validateConfig(value) {
  if (!object(value) || typeof value.relayOrigin !== 'string' || typeof value.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value.version) || typeof value.development !== 'boolean') {
    throw new Error('Missing or invalid packaged native configuration. Rebuild the native client.')
  }
  const url = new URL(value.relayOrigin)
  if (url.protocol !== 'https:' || url.origin !== value.relayOrigin || url.username || url.password
    || url.hostname === 'localhost' || /^(?:127\.|0\.|169\.254\.|\[)/.test(url.hostname)) {
    throw new Error('The native relay must be an explicitly configured HTTPS origin.')
  }
  return Object.freeze({ relayOrigin: url.origin, version: value.version, development: value.development })
}
function decodeBase64(value, limit) {
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) {
    throw new Error('Invalid native binary payload.')
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > limit || bytes.toString('base64') !== value) throw new Error('Native payload is too large or invalid.')
  return bytes
}
function validateRequest(value, relayOrigin) {
  if (!object(value) || typeof value.path !== 'string' || !ROUTES.get(value.path)?.includes(value.method)) {
    throw new Error('This native relay endpoint or method is not allowed.')
  }
  const headers = { origin: relayOrigin }
  if (value.headers !== undefined) {
    if (!object(value.headers) || Object.keys(value.headers).length > ALLOWED_HEADERS.size) throw new Error('Invalid native request headers.')
    for (const [key, content] of Object.entries(value.headers)) {
      const name = key.toLowerCase()
      if (!ALLOWED_HEADERS.has(name) || typeof content !== 'string' || content.length > 16384 || /[\r\n\0]/.test(content)) {
        throw new Error('This native request header is not allowed.')
      }
      headers[name] = content
    }
  }
  const body = value.bodyBase64 === undefined ? undefined : decodeBase64(value.bodyBase64, MAX_REQUEST_BYTES)
  if (value.method === 'GET' && body?.length) throw new Error('GET requests cannot contain a body.')
  return { url: new URL(value.path, relayOrigin), method: value.method, headers, body }
}
function externalURL(value) {
  if (typeof value !== 'string' || value.length > 8192 || [...value].some(char => char.charCodeAt(0) <= 32)) throw new Error('Invalid external link.')
  const url = new URL(value)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only web links can be opened externally.')
  return url.href
}
function safeFilename(value) {
  if (typeof value !== 'string' || !value || value.length > 180 || value !== path.basename(value)
    || /[<>:"/\\|?*]/.test(value) || [...value].some(char => char.charCodeAt(0) < 32) || /[. ]$/.test(value) || /^\.{1,2}$/.test(value)
    || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value)) throw new Error('Invalid download filename.')
  return value
}
function validateReset(value) {
  if (!object(value) || Object.keys(value).length !== 1 || value.confirmation !== 'DELETE LOCAL DATA') {
    throw new Error('Type DELETE LOCAL DATA to confirm removing this app’s local data.')
  }
}
function bundlePath(root, value) {
  if (!trustedURL(value)) return null
  let pathname
  try { pathname = decodeURIComponent(new URL(value).pathname) } catch { return null }
  if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) return null
  const relative = pathname.replace(/^\/+/, '') || 'index.html'
  const resolved = path.resolve(root, relative)
  if (!resolved.startsWith(path.resolve(root) + path.sep)) return null
  return resolved
}
module.exports = { APP_URL, RELEASE_URL, MAX_SNAPSHOT_BYTES, MAX_FILE_BYTES, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES,
  trustedURL, assertSender, validateConfig, validateRequest, decodeBase64, externalURL, safeFilename, validateReset, bundlePath, object }
