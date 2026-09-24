const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { relayRequest } = require('./transport.cjs')
const { MAX_RESPONSE_BYTES } = require('./security.cjs')
function mock(status, headers, chunks, inspect = () => {}) {
  return (url, options, callback) => {
    const request = new EventEmitter()
    request.end = bytes => {
      inspect(url, options, bytes)
      const response = new EventEmitter()
      response.statusCode = status; response.headers = headers
      response.destroy = () => { response.destroyed = true; request.emit('close') }
      callback(response)
      if (!response.destroyed) {
        for (const chunk of chunks) { response.emit('data', chunk); if (response.destroyed) break }
        if (!response.destroyed) response.emit('end')
      }
      request.emit('close')
    }
    request.destroy = error => { request.emit('error', error); request.emit('close') }
    return request
  }
}
test('binary file request/response retains every byte and signed envelope', async () => {
  const bytes = Buffer.from([0, 255, 128, 1])
  const response = await relayRequest({ path: '/api/files', method: 'PUT', bodyBase64: bytes.toString('base64'),
    headers: { 'X-Serotine-File-Request': 'signed-proof', 'Content-Type': 'application/octet-stream' } }, 'https://relay.example',
  mock(200, { 'content-type': 'application/octet-stream', 'set-cookie': 'private' }, [bytes], (url, options, body) => {
    assert.equal(url.href, 'https://relay.example/api/files')
    assert.equal(options.headers.origin, 'https://relay.example')
    assert.equal(options.headers['x-serotine-file-request'], 'signed-proof')
    assert.deepEqual(body, bytes)
  }))
  assert.equal(response.bodyBase64, bytes.toString('base64'))
  assert.equal(response.headers['set-cookie'], undefined)
})
test('redirects never cause a second request', async () => {
  let count = 0
  await assert.rejects(relayRequest({ path: '/api/files', method: 'GET' }, 'https://relay.example',
    mock(302, { location: 'https://evil.example' }, [], () => count++)), /redirect/)
  assert.equal(count, 1)
})
test('declared and streaming oversized responses are rejected', async () => {
  const input = { path: '/api/files', method: 'GET' }
  await assert.rejects(relayRequest(input, 'https://relay.example', mock(200, { 'content-length': String(MAX_RESPONSE_BYTES + 1) }, [])), /size limit/)
  await assert.rejects(relayRequest(input, 'https://relay.example', mock(200, {}, [Buffer.alloc(MAX_RESPONSE_BYTES), Buffer.from('x')])), /size limit/)
})
