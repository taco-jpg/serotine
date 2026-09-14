const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function callingFixture(page, origin, title) {
  // Use a real local response to preserve Chromium's address-space metadata.
  // A fulfilled synthetic navigation has no remote IP and can incorrectly
  // trigger Local Network Access checks for an otherwise same-origin socket.
  const response = await page.goto(`${origin}/messaging-sw.js`)
  assert.equal(response.status(), 200, 'Fixture reached the actual local Worker')
  await page.setContent(`<!doctype html><title>${title}</title>`)
}

// Calling upgrades run in the custom Worker, so Next's development server alone
// cannot exercise this path. Build first, or point at an already running local
// workerd instance with SEROTINE_BROWSER_ORIGIN.
async function callingRuntime(root, port, artifacts) {
  const external = process.env.SEROTINE_BROWSER_ORIGIN
  const origin = external || `http://localhost:${port}`
  const url = new URL(origin)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Smoke tests only create test identities on a local runtime')
  const logPath = path.join(artifacts, 'server.log')
  let server, log, serverError
  if (!external) {
    assert.ok(fs.existsSync(path.join(root, '.open-next/worker.js')), 'Run npm run build before calling browser tests, or set SEROTINE_BROWSER_ORIGIN to local workerd')
    log = fs.openSync(logPath, 'w')
    server = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0'], { cwd: root, stdio: ['ignore', log, log] })
    server.on('error', error => { serverError = error })
  }
  const stop = async () => {
    if (server) {
      server.kill('SIGTERM')
      await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(5000)])
      if (server.exitCode === null) server.kill('SIGKILL')
    }
    if (log !== undefined) fs.closeSync(log)
  }
  try {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (serverError || (server && server.exitCode !== null)) throw new Error(`Worker failed: ${serverError?.message || fs.readFileSync(logPath, 'utf8').slice(-4000)}`)
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(3000) })).ok) return { origin, stop } } catch { /* Wait for workerd. */ }
      await pause(500)
    }
    throw new Error(`Worker did not become ready: ${external || logPath}`)
  } catch (error) { await stop(); throw error }
}

function signalingObserver() {
  const http = [], frames = [], sockets = []
  function observe(page) {
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/calls') || /turn|cloudflare.*realtime/i.test(url.href)) http.push({ url: url.href, method: request.method(), body: request.postData() })
    })
    page.on('websocket', socket => {
      if (!new URL(socket.url()).pathname.startsWith('/api/calls')) return
      sockets.push(socket.url())
      for (const direction of ['framesent', 'framereceived']) socket.on(direction, frame => {
        assert.equal(typeof frame.payload, 'string', 'Calling socket carries JSON signaling, never binary media')
        frames.push({ direction, body: frame.payload })
      })
    })
  }
  function verify(requiredActions = []) {
    assert.ok(sockets.length > 0, 'Used real browser WebSocket connections to the calling Worker')
    assert.ok(frames.length > 0, 'Exchanged actual WebSocket signaling frames')
    assert.deepEqual(http, [], 'Browser calling makes no HTTP polling or direct TURN credential-provider requests')
    assert.ok(frames.every(({ body }) => !body.includes('a=fingerprint:') && !body.includes('a=ice-pwd:') && !body.includes('candidate:')), 'SDP and ICE remain encrypted inside signaling frames')
    for (const action of requiredActions) assert.ok(frames.some(({ direction, body }) => direction === 'framesent' && body.includes(action)), `Sent ${action} through WebSocket`)
  }
  return { observe, verify, http, frames, sockets }
}

async function verifyDirectConfiguration(page, field = 'peerConnections') {
  // Return only booleans to the test process, never ICE credentials.
  const configurations = await page.evaluate(field => window[field].map(pc => {
    const configuration = pc.getConfiguration()
    return {
      directAllowed: configuration.iceTransportPolicy === 'all',
      hasStun: configuration.iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^stuns?:/.test(url))),
      managedOnly: configuration.iceServers.every(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).every(url => /^stuns?:/.test(url) || /^turns?:turn\.cloudflare\.com:/.test(url))),
    }
  }), field)
  assert.ok(configurations.length > 0, 'Created native WebRTC peer connections')
  for (const configuration of configurations) {
    assert.equal(configuration.directAllowed, true, 'Standard ICE keeps direct routing enabled')
    assert.equal(configuration.hasStun, true, 'STUN is configured for NAT discovery')
    assert.equal(configuration.managedOnly, true, 'Only managed Cloudflare TURN can supplement STUN')
  }
}

async function verifySocketRejections(context, origin, signedCommand) {
  const page = await context.newPage()
  try {
    await callingFixture(page, origin, 'Signaling admission checks')
    const codes = await page.evaluate(async signedCommand => {
      const endpoint = new URL('/api/calls/socket', location.href)
      endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      async function rejected(payload) {
        return new Promise((resolve, reject) => {
          const socket = new WebSocket(endpoint)
          const timeout = setTimeout(() => { socket.close(); reject(new Error('Invalid signaling socket was not closed')) }, 5000)
          socket.onopen = () => socket.send(payload)
          socket.onclose = event => { clearTimeout(timeout); resolve(event.code) }
          socket.onerror = () => { clearTimeout(timeout); reject(new Error('Socket never opened')) }
        })
      }
      return [await rejected(signedCommand), await rejected(new Uint8Array([1, 2, 3]))]
    }, signedCommand)
    assert.deepEqual(codes, [1008, 1003], 'Real workerd rejects unauthenticated operations and binary media')
  } finally { await page.close() }
}

module.exports = { callingFixture, callingRuntime, signalingObserver, verifyDirectConfiguration, verifySocketRejections }
