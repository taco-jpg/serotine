/* eslint-disable no-console */
/* global SerotineCalling */
// Real browser capture, RTCPeerConnection, authenticated WebSockets and local D1.
// Fake devices keep this test independent of microphones/cameras on the runner.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { callingFixture, callingRuntime, signalingObserver, verifyDirectConfiguration, verifySocketRejections } = require('./calling-smoke-support.cjs')
const { chromium } = require('playwright')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3183'
assert.match(port, /^\d+$/)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
// Restricted runners may be unable to gather even localhost ICE candidates.
// This opt-in mode exercises signaling/capture/UI, and never claims RTP passed.
const signalingOnly = process.env.SEROTINE_CALL_SMOKE_SIGNALING_ONLY === '1'
const blockDirect = process.env.SEROTINE_CALL_SMOKE_BLOCK_DIRECT === '1'
assert.ok(!(blockDirect && signalingOnly), 'TURN fallback verification requires actual received RTP')

async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }
}

async function main() {
  const bundle = (await esbuild.build({ stdin: {
    contents: 'export * from "./lib/identity"; export * from "./lib/call-engine"; export * from "./lib/messaging-store";', resolveDir: root,
  }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineCalling', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-calling-')
  fs.mkdirSync(artifacts, { recursive: true })
  const runtime = await callingRuntime(root, port, artifacts)
  const { origin } = runtime
  const wire = signalingObserver()
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, headless: true, args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    ] })
    const errors = [], pages = []
    const [alice, bob] = await Promise.all([identity(), identity()])
    const contexts = await Promise.all([0, 1].map(() => browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })))

    async function fixture(context, owner, contact) {
      const page = await context.newPage()
      pages.push(page)
      page.on('pageerror', error => errors.push(error.stack || error.message))
      wire.observe(page)
      await callingFixture(page, origin, 'Calling smoke fixture')
      await page.addScriptTag({ content: bundle })
      await page.evaluate(async ({ owner, contact, blockDirect }) => {
        localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
        SerotineCalling.saveContacts(owner.publicKey, [{ pub: contact.publicKey, alias: contact.alias }])
        window.captureRequests = []
        window.capturedTracks = []
        window.peerConnections = []
        window.completedCalls = []
        window.denyCapture = false
        window.peerPolicy = { accepted: true, label: contact.alias }
        const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async constraints => {
          window.captureRequests.push(constraints)
          if (window.denyCapture) throw new DOMException('Synthetic permission denial', 'NotAllowedError')
          const stream = await nativeCapture(constraints)
          window.capturedTracks.push(...stream.getTracks())
          return stream
        }
        const NativeConnection = window.RTCPeerConnection
        window.RTCPeerConnection = new Proxy(NativeConnection, { construct(target, args) {
          const connection = Reflect.construct(target, args)
          if (blockDirect) {
            // Test-only network constraint: neither peer learns a usable direct
            // candidate. Production still uses ordinary, unfiltered ICE and all.
            const add = connection.addIceCandidate.bind(connection)
            const remote = connection.setRemoteDescription.bind(connection)
            connection.addIceCandidate = candidate => !candidate?.candidate || /\btyp relay\b/.test(candidate.candidate) ? add(candidate) : Promise.resolve()
            connection.setRemoteDescription = description => remote({ ...description, sdp: description.sdp?.split('\r\n').filter(line => !line.startsWith('a=candidate:') || /\btyp relay\b/.test(line)).join('\r\n') })
          }
          window.peerConnections.push(connection)
          return connection
        } })
        window.calls = new SerotineCalling.CallEngine({
          identity: await SerotineCalling.loadIdentity(),
          getPeerPolicy: peer => peer === contact.publicKey ? window.peerPolicy : { accepted: false },
          onCompleted: async call => { window.completedCalls.push(call); await SerotineCalling.saveCallHistory(owner.publicKey, call) },
        }, { reconnectTimeoutMs: 1000 })
        await window.calls.start()
      }, { owner, contact, blockDirect })
      return page
    }

    const a = await fixture(contexts[0], alice, { ...bob, alias: 'Bob (test)' })
    const b = await fixture(contexts[1], bob, { ...alice, alias: 'Alice (test)' })
    async function state(page) {
      return page.evaluate(() => {
        const s = window.calls.getSnapshot()
        return { phase: s.phase, error: s.error, notice: s.notice, camera: s.cameraEnabled, muted: s.microphoneMuted,
          captureRequests: window.captureRequests.length, liveTracks: window.capturedTracks.filter(t => t.readyState === 'live').map(t => ({ kind: t.kind, enabled: t.enabled })),
          connections: window.peerConnections.map(pc => ({ state: pc.connectionState, ice: pc.iceConnectionState, signaling: pc.signalingState,
            localDescription: !!pc.localDescription, remoteDescription: !!pc.remoteDescription, senders: pc.getSenders().filter(s => s.track).length })),
        }
      })
    }
    async function until(check, label, timeout = 30000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        if (await check()) return
        await pause(200)
      }
      throw new Error(`${label}: ${JSON.stringify(await Promise.all(pages.map(state)))}`)
    }
    const phase = (page, expected) => until(async () => (await state(page)).phase === expected, `Expected ${expected}`)
    const released = page => until(async () => (await state(page)).liveTracks.length === 0, 'All captured tracks released')
    const start = async (page, peer, mode) => {
      await page.evaluate(async ({ peer, mode }) => { window.calls.dismiss(); await window.calls.prepareOutgoing(peer, mode) }, { peer, mode })
      await phase(page, 'preview')
      await page.evaluate(() => window.calls.connectPreview())
      await phase(page, 'ringing')
    }
    const accept = async (page, mode) => {
      await page.evaluate(mode => window.calls.prepareIncoming(mode), mode)
      await phase(page, 'preview')
      await page.evaluate(() => window.calls.connectPreview())
    }
    await until(async () => await a.evaluate(peer => window.calls.availability(peer), bob.publicKey) === 'available', 'Peer advertises calling support')

    // Ringing must not acquire the recipient's media, or connect the caller's
    // preview to a sender. Cancellation must stop the preview and other tabs.
    const b2 = await fixture(contexts[1], bob, { ...alice, alias: 'Alice (test)' })
    await start(a, bob.publicKey, 'audio')
    await Promise.all([phase(b, 'incoming'), phase(b2, 'incoming')])
    assert.equal((await state(a)).camera, false)
    assert.deepEqual((await state(a)).liveTracks.map(track => track.kind), ['audio'])
    assert.equal((await state(a)).connections.length, 0, 'No media transport before acceptance')
    assert.equal((await state(b)).captureRequests, 0, 'Incoming invitation did not request media')
    assert.equal((await state(b2)).captureRequests, 0, 'Second tab did not request media')
    await a.evaluate(() => window.calls.end())
    await until(async () => (await state(b)).phase !== 'incoming' && (await state(b2)).phase !== 'incoming', 'Cancel dismissed every ringing tab')
    await released(a)
    console.log('PASS explicit audio preview, no recipient capture before acceptance, and cross-tab cancellation')

    // An explicit rejection is delivered promptly over the signaling socket.
    await start(a, bob.publicKey, 'audio')
    await phase(b, 'incoming')
    await b.evaluate(() => window.calls.decline())
    await phase(a, 'declined')
    await released(a)
    await until(async () => (await state(b2)).phase !== 'incoming', 'Reject dismisses the other recipient tab')
    console.log('PASS recipient rejection terminates ringing and capture')

    // A video invitation can be accepted with audio only. Actual RTC stats
    // prove media packets cross the browser connection after acceptance.
    await start(a, bob.publicKey, 'video')
    await Promise.all([phase(b, 'incoming'), phase(b2, 'incoming')])
    await accept(b, 'audio')
    if (signalingOnly) {
      await until(async () => (await Promise.all([state(a), state(b)])).every(s => s.phase === 'connecting'
        && s.connections.some(pc => pc.localDescription && pc.remoteDescription && pc.signaling === 'stable')), 'Both peers installed authenticated SDP')
    } else await Promise.all([phase(a, 'connected'), phase(b, 'connected')])
    await until(async () => !['incoming', 'preview', 'connecting'].includes((await state(b2)).phase), 'Accept dismissed the other recipient tab')
    assert.equal((await state(b2)).captureRequests, 0, 'Unselected tab never captured media')
    assert.deepEqual((await state(b)).liveTracks.map(track => track.kind), ['audio'], 'Audio-only acceptance did not request a camera')
    if (!signalingOnly) await until(async () => await b.evaluate(async () => {
      for (const pc of window.peerConnections) for (const report of (await pc.getStats()).values()) {
        if (report.type === 'inbound-rtp' && report.kind === 'audio' && report.packetsReceived > 0) return true
      }
      return false
    }), 'Real RTP audio reached the other peer')
    if (!signalingOnly) {
      await until(async () => await b.evaluate(async () => {
        for (const pc of window.peerConnections) for (const report of (await pc.getStats()).values()) {
          if (report.type === 'inbound-rtp' && report.kind === 'video' && report.framesDecoded > 0) return true
        }
        return false
      }), 'Real video frames decoded at the recipient')
      if (blockDirect) {
        await until(async () => (await Promise.all([a, b].map(page => page.evaluate(() => window.calls.getSnapshot().connection?.route)))).every(route => route === 'turn'), 'Selected ICE pairs use TURN when direct candidates are unavailable')
        console.log('PASS automatic TURN route selected with direct candidates blocked and real audio/video received')
      }
    }
    await a.evaluate(() => window.calls.toggleMicrophone())
    assert.equal((await state(a)).muted, true)
    assert.ok((await state(a)).liveTracks.filter(t => t.kind === 'audio').every(t => !t.enabled), 'Mute disables actual audio tracks')
    await a.evaluate(() => window.calls.toggleCamera())
    assert.equal((await state(a)).camera, false)
    assert.equal((await state(a)).liveTracks.filter(t => t.kind === 'video').length, 0, 'Camera off stops capture')
    const privateCallId = await a.evaluate(async () => {
      const callId = window.calls.getSnapshot().callId
      // Set privacy and hang up in the same task, before a periodic signal can
      // advertise the change. Both history writers must still suppress it.
      window.peerPolicy.private = true
      await window.calls.end()
      return callId
    })
    await Promise.all([released(a), released(b)])
    await until(async () => (await state(b)).phase === 'ended', 'Remote hangup ended call')
    assert.ok(await a.evaluate(() => window.completedCalls.some(call => call.outcome === 'ended')), 'Completed call was reported')
    await until(async () => await b.evaluate(id => window.completedCalls.some(call => call.id === id), privateCallId), 'Remote completion saved')
    for (const page of [a, b]) {
      assert.equal(await page.evaluate(id => window.completedCalls.find(call => call.id === id)?.private, privateCallId), true, 'Immediate private hangup reached both participants')
      assert.equal(await page.evaluate(async id => {
        const owner = (await SerotineCalling.loadIdentity()).publicKey
        return (await SerotineCalling.exportMessagingSnapshot(owner)).callHistory?.records.some(call => call.id === id) ?? false
      }, privateCallId), false, 'Private call absent from persistent history and backups')
    }
    await a.evaluate(() => { window.peerPolicy.private = false })
    console.log(`PASS ${signalingOnly ? 'authenticated SDP exchange' : 'real video/audio WebRTC'}, audio-only answer, single selected tab, mute, camera stop and hangup cleanup`)
    console.log('PASS immediate private switch and hangup suppresses both participants\' persistent and backup history')

    // Trigger a native connection-state failure after real negotiation. The
    // engine gets one direct ICE retry, then its real deadline must release all
    // devices and report the network limitation without changing transports.
    await start(a, bob.publicKey, 'audio')
    await phase(b, 'incoming')
    await accept(b, 'audio')
    await until(async () => (await state(a)).connections.some(pc => pc.state !== 'closed' && pc.localDescription && pc.remoteDescription && pc.signaling === 'stable'), 'Negotiation completes before simulated network failure')
    await a.evaluate(() => {
      const pc = window.peerConnections.at(-1)
      Object.defineProperty(pc, 'connectionState', { configurable: true, get: () => 'failed' })
      pc.dispatchEvent(new Event('connectionstatechange'))
    })
    await phase(a, 'failed')
    assert.match((await state(a)).error || '', /WebRTC connection failed|direct connection.*could not be established/i)
    await Promise.all([released(a), released(b)])
    console.log('PASS direct ICE retry times out gracefully, ends the remote call, and stops every captured track')

    await a.evaluate(async peer => { window.calls.dismiss(); window.denyCapture = true; await window.calls.prepareOutgoing(peer, 'audio') }, bob.publicKey)
    await phase(a, 'failed')
    await released(a)
    assert.match((await state(a)).error || '', /microphone|permission|allow/i)
    assert.notEqual((await state(b)).phase, 'incoming', 'Permission denial did not ring recipient')
    console.log('PASS denied permission leaves no capture or invitation')

    for (const page of pages) await page.evaluate(() => window.calls.dispose())

    // Exercise real chat controls. Routing is automatic with no TURN setup prompt.
    const uiPages = await Promise.all(contexts.map(context => context.newPage()))
    const [uiA, uiB] = uiPages
    for (const page of uiPages) {
      page.setDefaultTimeout(30000)
      page.on('pageerror', error => errors.push(error.stack || error.message))
      wire.observe(page)
      await page.addInitScript(() => {
        window.uiCaptureCount = 0
        const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async constraints => { window.uiCaptureCount++; return nativeCapture(constraints) }
      })
    }
    await Promise.all([uiA.goto(`${origin}/chat/${bob.publicKey}`), uiB.goto(`${origin}/chat/${alice.publicKey}`)])
    await Promise.all(uiPages.map(page => page.getByRole('textbox', { name: 'Message', exact: true }).waitFor()))
    const openVoice = async page => {
      await page.getByRole('button', { name: 'Voice and video call options', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Voice call', exact: true }).click()
    }
    await openVoice(uiA)
    const preview = uiA.getByRole('dialog', { name: /Call Bob/ })
    await preview.getByRole('button', { name: 'Turn camera on', exact: true }).waitFor()
    assert.equal(await uiB.evaluate(() => window.uiCaptureCount), 0)
    await preview.getByRole('button', { name: 'Start call', exact: true }).click()
    const remoteBar = uiB.getByRole('region', { name: 'Current call', exact: true })
    await remoteBar.getByRole('button', { name: 'Answer', exact: true }).click()
    const answerPreview = uiB.getByRole('dialog', { name: /Answer Alice/ })
    assert.equal(await uiB.getByRole('dialog').count(), 1, 'Incoming preview uses one dialog')
    await answerPreview.getByRole('button', { name: 'Accept and connect', exact: true }).click()
    for (const page of uiPages) await page.getByRole('region', { name: 'Current call', exact: true }).getByRole('status').filter({ hasText: signalingOnly ? /^(Connecting|Connected)/ : /^Connected/ }).waitFor()
    const screenshotOptions = { animations: 'disabled', style: 'nextjs-portal { display: none; }' }
    const verifyLayout = async (page, label) => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const composerBounds = await page.getByRole('textbox', { name: 'Message', exact: true }).boundingBox()
      const headerBounds = await page.getByRole('button', { name: 'Voice and video call options', exact: true }).boundingBox()
      const barBounds = await page.getByRole('region', { name: 'Current call', exact: true }).boundingBox()
      assert.ok(composerBounds && headerBounds && barBounds, `${label}: controls rendered`)
      assert.ok(barBounds.y >= 0 && headerBounds.y >= barBounds.y + barBounds.height - 1
        && headerBounds.y + headerBounds.height <= composerBounds.y
        && composerBounds.y + composerBounds.height <= page.viewportSize().height + 2,
      `${label}: call bar, header and composer all visible without scrolling: ${JSON.stringify({ composerBounds, headerBounds, barBounds })}`)
      assert.equal(await page.evaluate(() => window.scrollY), 0, `${label}: page did not scroll to hide the header`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: no horizontal overflow`)
    }
    await verifyLayout(uiA, 'Desktop')
    await uiA.screenshot({ path: path.join(artifacts, 'calling-desktop.png'), ...screenshotOptions })
    await uiA.setViewportSize({ width: 390, height: 844 })
    await verifyLayout(uiA, 'Mobile before typing')
    const composer = uiA.getByRole('textbox', { name: 'Message', exact: true })
    await composer.fill('Typing while the call stays connected')
    await verifyLayout(uiA, 'Mobile after typing')
    await uiA.screenshot({ path: path.join(artifacts, 'calling-mobile.png'), ...screenshotOptions })
    await uiA.setViewportSize({ width: 320, height: 740 })
    await verifyLayout(uiA, 'Narrow mobile')
    await uiA.screenshot({ path: path.join(artifacts, 'calling-mobile-320.png'), ...screenshotOptions })
    await uiA.getByRole('button', { name: 'End call', exact: true }).click()
    await remoteBar.getByRole('status').filter({ hasText: /^Call ended/ }).waitFor()
    console.log('PASS chat calling controls and narrow composer layout')

    wire.verify(['call:socket', 'call:invite', 'call:claim', 'call:send', 'call:finish'])
    const signedCommand = wire.frames.find(({ direction, body }) => direction === 'framesent' && JSON.parse(body).type === 'request')?.body
    assert.ok(signedCommand, 'Captured an actual signed calling command')
    await verifySocketRejections(contexts[0], origin, signedCommand)
    console.log('PASS workerd rejects unauthenticated commands and binary media frames')
    for (const page of [a, b]) await verifyDirectConfiguration(page)
    assert.deepEqual(errors, [], 'No uncaught browser errors')
    console.log(`Calling browser smoke ${signalingOnly ? '(signaling/capture/UI only; RTP not verified) ' : ''}passed. Logs: ${artifacts}`)
  } catch (error) {
    console.error(`Calling smoke artifacts: ${artifacts}`)
    console.error('Signaling responses:', JSON.stringify(wire.frames.filter(frame => frame.direction === 'framereceived').map(frame => {
      const value = JSON.parse(frame.body)
      return { type: value.type, status: value.status, error: value.body?.error, success: value.body?.success }
    }).slice(-8)))
    throw error
  } finally {
    if (browser) await browser.close()
    await runtime.stop()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
