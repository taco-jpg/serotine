const https = require('node:https')
const { validateRequest, MAX_RESPONSE_BYTES } = require('./security.cjs')

/** A bounded, single-attempt HTTPS request. Redirects and renderer-supplied origins/cookies are never forwarded. */
function relayRequest(value, relayOrigin, request = https.request) {
  const options = validateRequest(value, relayOrigin)
  return new Promise((resolve, reject) => {
    const pending = request(options.url, { method: options.method, headers: options.headers }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy(); reject(new Error('The configured relay attempted a redirect. Update Serotine using the official release channel.')); return
      }
      const declared = response.headers['content-length']
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
        response.destroy(); reject(new Error('The relay response exceeds the native size limit.')); return
      }
      const pieces = []; let total = 0
      response.on('data', bytes => {
        total += bytes.length
        if (total > MAX_RESPONSE_BYTES) { response.destroy(); reject(new Error('The relay response exceeds the native size limit.')); return }
        pieces.push(bytes)
      })
      response.on('end', () => {
        const headers = {}
        for (const name of ['content-type', 'content-length', 'retry-after', 'x-serotine-client-version']) {
          if (typeof response.headers[name] === 'string') headers[name] = response.headers[name]
        }
        resolve({ status: response.statusCode, headers, bodyBase64: Buffer.concat(pieces).toString('base64') })
      })
      response.on('error', () => reject(new Error('The relay response was interrupted. Retry explicitly.')))
      response.on('aborted', () => reject(new Error('The relay response was interrupted. Retry explicitly.')))
    })
    const timer = setTimeout(() => pending.destroy(new Error('timeout')), 120000)
    pending.on('error', () => reject(new Error('The configured relay is unavailable. Check your connection and retry.')))
    pending.on('close', () => clearTimeout(timer))
    pending.end(options.body)
  })
}
module.exports = { relayRequest }
