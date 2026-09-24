const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { trustedURL, assertSender, validateConfig, validateRequest, decodeBase64, bundlePath, safeFilename, externalURL, validateReset } = require('./security.cjs')
const relay = 'https://relay.example.com'

test('only the exact bundled main frame owns privileged IPC', () => {
  const frame = { url: 'serotine://app/chat' }, contents = { mainFrame: frame }
  const window = { isDestroyed: () => false, webContents: contents }
  assert.doesNotThrow(() => assertSender({ sender: contents, senderFrame: frame }, window))
  for (const url of ['https://app/', 'serotine://app.evil/', 'serotine://evil@app/', 'file:///app/', 'serotine://app:12/']) assert.equal(trustedURL(url), false)
  assert.throws(() => assertSender({ sender: contents, senderFrame: { url: frame.url } }, window), /Untrusted/)
  assert.throws(() => assertSender({ sender: {}, senderFrame: frame }, window), /Untrusted/)
  frame.url = 'https://relay.example.com'
  assert.throws(() => assertSender({ sender: contents, senderFrame: frame }, window), /Untrusted/)
})
test('native relay allowlist rejects host, path, method, query and header escapes', () => {
  for (const input of [
    { path: 'https://evil.example/api/relay', method: 'POST' }, { path: '//evil.example/api/relay', method: 'POST' },
    { path: '/api/relay?host=evil', method: 'POST' }, { path: '/api/relay/../files', method: 'POST' },
    { path: '/api/relay', method: 'DELETE' }, { path: '/api/files', method: 'POST', headers: { cookie: 'secret' } },
    { path: '/api/files', method: 'POST', headers: { Origin: 'https://evil.example' } },
    { path: '/api/files', method: 'POST', headers: { authorization: 'token' } },
    { path: '/api/files', method: 'POST', headers: { accept: 'x\r\nevil' } },
  ]) assert.throws(() => validateRequest(input, relay))
  const result = validateRequest({ path: '/api/files', method: 'PUT', headers: { 'X-Serotine-File-Request': '{"proof":"signed"}' }, bodyBase64: 'AP9h' }, relay)
  assert.equal(result.url.href, relay + '/api/files')
  assert.equal(result.headers.origin, relay)
  assert.deepEqual([...result.body], [0, 255, 97])
})
test('native config requires an explicit HTTPS origin, version and channel', () => {
  const config = { relayOrigin: relay, version: '1.0.0-beta.1', development: true }
  assert.deepEqual(validateConfig(config), config)
  for (const origin of ['http://relay.example.com', relay + '/', relay + '/api', 'https://u:p@relay.example.com', 'https://127.0.0.1']) {
    assert.throws(() => validateConfig({ ...config, relayOrigin: origin }))
  }
  assert.throws(() => validateConfig({ ...config, development: undefined }))
})
test('binary payloads are canonical and bounded', () => {
  assert.equal(decodeBase64('YQ==', 1).toString(), 'a')
  for (const value of ['YQ=', 'Y Q==', 'YQ==\n', 'YR==', 'YWFh']) assert.throws(() => decodeBase64(value, 1))
  const chunk = Buffer.alloc(4 * 1024 * 1024 + 16, 0xab)
  assert.deepEqual(decodeBase64(chunk.toString('base64'), chunk.length), chunk)
})
test('bundle path and filename validation prevent filesystem traversal', () => {
  const root = path.resolve('test-bundle')
  assert.equal(bundlePath(root, 'serotine://app/app.js'), path.join(root, 'app.js'))
  for (const url of ['serotine://app/%2e%2e%2fsecret', 'serotine://app/%5csecret', 'serotine://app/%00', 'file:///secret']) assert.equal(bundlePath(root, url), null)
  for (const name of ['../id.json', '/id.json', 'foo\\bar', 'CON.json', 'foo.', 'id\n.json']) assert.throws(() => safeFilename(name))
  assert.equal(safeFilename('serotine-backup.json'), 'serotine-backup.json')
})
test('external opening accepts only ordinary web links', () => {
  assert.equal(externalURL('https://example.com/path'), 'https://example.com/path')
  for (const url of ['file:///secret', 'javascript:alert(1)', 'ms-settings:privacy', 'https://u:p@example.com', 'https://example.com/\nevil']) assert.throws(() => externalURL(url))
})
test('recovery accepts only the exact typed phrase and no filesystem parameters', () => {
  assert.doesNotThrow(() => validateReset({ confirmation: 'DELETE LOCAL DATA' }))
  for (const value of [null, {}, { confirmation: true }, { confirmation: 'delete local data' },
    { confirmation: 'DELETE LOCAL DATA', path: '/other/user/data' }]) assert.throws(() => validateReset(value))
})
