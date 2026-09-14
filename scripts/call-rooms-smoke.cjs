/* eslint-disable no-console */
/* global SerotineRooms */
// Three real browser identities, authenticated WebSockets/D1, and fake local devices.
// The default requires received RTP on every peer connection. Restricted runners
// may explicitly choose signaling/capture/UI coverage; that never claims RTP.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { callingFixture, callingRuntime, signalingObserver, verifyDirectConfiguration } = require('./calling-smoke-support.cjs')
const { chromium } = require('playwright')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3184'
assert.match(port, /^\d+$/)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const signalingOnly = process.env.SEROTINE_CALL_SMOKE_SIGNALING_ONLY === '1'

async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }
}

async function main() {
  const bundle = (await esbuild.build({ stdin: {
    contents: 'export * from "./lib/identity"; export * from "./lib/call-room-engine"; export * from "./lib/messaging"; export * from "./lib/messaging-store"; export * from "./lib/community-protocol";', resolveDir: root,
  }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineRooms', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-call-rooms-')
  fs.mkdirSync(artifacts, { recursive: true })
  const runtime = await callingRuntime(root, port, artifacts)
  const { origin } = runtime
  const wire = signalingObserver()
  const pages = [], errors = []
  let browser
  try {
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, headless: true, args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    ] })
    const identities = await Promise.all([identity(), identity(), identity()])
    const labels = ['Alice', 'Bob', 'Charlie']
    const contexts = await Promise.all(identities.map(() => browser.newContext({ permissions: ['microphone', 'camera'], viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })))
    function observe(page) {
      page.setDefaultTimeout(30000)
      page.on('pageerror', error => errors.push(error.stack || error.message))
      wire.observe(page)
    }
    for (let index = 0; index < contexts.length; index++) {
      const page = await contexts[index].newPage()
      pages.push(page); observe(page)
      await callingFixture(page, origin, 'Call room smoke fixture')
      await page.addScriptTag({ content: bundle })
      await page.evaluate(({ owner, contacts }) => {
        localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
        localStorage.setItem(`serotine_call_settings:${owner.publicKey}`, JSON.stringify({ relayOnly: true })) // Legacy preferences must not re-enable TURN.
        SerotineRooms.saveContacts(owner.publicKey, contacts)
        window.captureRequests = []; window.capturedTracks = []; window.peerConnections = []
        const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async constraints => {
          window.captureRequests.push(constraints)
          const stream = await nativeCapture(constraints)
          window.capturedTracks.push(...stream.getTracks())
          return stream
        }
        const NativeConnection = window.RTCPeerConnection
        window.RTCPeerConnection = new Proxy(NativeConnection, { construct(target, args) {
          const connection = Reflect.construct(target, args)
          window.peerConnections.push(connection)
          return connection
        } })
      }, { owner: identities[index], contacts: identities.filter((_, i) => i !== index).map(owner => ({ pub: owner.publicKey, alias: labels[identities.indexOf(owner)] })) })
    }
    const [a, b, c] = pages
    const fixture = await a.evaluate(async identities => {
      const owner = identities[0], now = Date.now() - 1000
      const group = await SerotineRooms.signGroup({ id: `group:${crypto.randomUUID()}`, name: 'Room smoke group', admin: owner.publicKey, members: identities.map(value => value.publicKey), epoch: 1, updatedAt: now }, owner)
      const uiGroup = await SerotineRooms.signGroup({ ...group, id: `group:${crypto.randomUUID()}`, name: 'Study group' }, owner)
      const community = await SerotineRooms.signCommunityState({ version: 2, id: `community:${owner.publicKey}:${crypto.randomUUID()}`, owner: owner.publicKey, signer: owner.publicKey, name: 'Study community', description: 'Call room smoke fixture', epoch: 1, updatedAt: now, members: identities.map(value => value.publicKey), moderators: [], coOwners: [], transfers: [], deleted: false, bans: [], admission: 'direct', joiningPaused: false, inviteGeneration: 1, channels: [
        { id: crypto.randomUUID(), name: 'general', posting: 'members' },
        { id: crypto.randomUUID(), name: 'Lounge', posting: 'members', kind: 'voice' },
      ] }, owner)
      const events = []
      for (const data of [
        { conversationId: uiGroup.id, kind: 'group', payload: {}, group: uiGroup },
        { conversationId: uiGroup.id, kind: 'message', payload: { content: 'Keep chatting during your group call.' }, group: uiGroup },
        { conversationId: community.id, kind: 'community', payload: { community: { type: 'state', state: community } } },
      ]) events.push(await SerotineRooms.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: owner.publicKey, recipients: identities.slice(1).map(value => value.publicKey), timestamp: Date.now(), ...data }, owner))
      return { group, uiGroup, community, events }
    }, identities)
    for (let index = 0; index < pages.length; index++) await pages[index].evaluate(async ({ fixture, owner, labels, identities }) => {
      window.roomTarget = { kind: 'group', group: fixture.group }
      for (const event of fixture.events) await SerotineRooms.saveStoredEvent(owner.publicKey, { key: SerotineRooms.eventStorageKey(event), event, local: event.author === owner.publicKey, delivered: event.recipients, receivedAt: event.timestamp })
      window.rooms = new SerotineRooms.CallRoomEngine({ identity: owner, getTarget: () => window.roomTarget, getPeerLabel: pub => labels[identities.findIndex(value => value.publicKey === pub)] || pub })
    }, { fixture, owner: identities[index], labels, identities })

    async function state(page) {
      return page.evaluate(() => {
        const snapshot = window.rooms.getSnapshot()
        return { phase: snapshot.phase, error: snapshot.error, notice: snapshot.notice, muted: snapshot.microphoneMuted, camera: snapshot.cameraEnabled,
          participants: snapshot.participants.map(peer => ({ publicKey: peer.publicKey, phase: peer.phase, error: peer.error })), captureRequests: window.captureRequests.length,
          liveTracks: window.capturedTracks.filter(track => track.readyState === 'live').map(track => ({ kind: track.kind, enabled: track.enabled })),
          connections: window.peerConnections.map(pc => ({ state: pc.connectionState, ice: pc.iceConnectionState, gathering: pc.iceGatheringState, signaling: pc.signalingState, local: !!pc.localDescription, remote: !!pc.remoteDescription })),
        }
      })
    }
    async function until(check, label, timeout = 30000) {
      const end = Date.now() + timeout
      while (Date.now() < end) { if (await check()) return; await pause(150) }
      throw new Error(`${label}: ${JSON.stringify(await Promise.all(pages.map(state)))}`)
    }
    const released = page => until(async () => (await state(page)).liveTracks.length === 0, 'Captured tracks released')
    const prepare = async (page, mode = 'audio') => {
      await page.evaluate(async mode => { window.rooms.dismiss(); await window.rooms.prepare(window.roomTarget, mode) }, mode)
      assert.equal((await state(page)).phase, 'preview')
    }
    const join = async page => {
      await page.evaluate(() => window.rooms.joinPreview())
      const snapshot = await state(page)
      assert.equal(snapshot.phase, 'joined', `Room join failed: ${JSON.stringify(snapshot)}`)
    }
    const mesh = async expected => {
      await until(async () => (await Promise.all(pages.slice(0, expected + 1).map(state))).every(snapshot => snapshot.participants.length === expected
        && snapshot.connections.filter(pc => pc.state !== 'closed').length === expected
        && snapshot.connections.filter(pc => pc.state !== 'closed').every(pc => pc.local && pc.remote && pc.signaling === 'stable')), 'All room peers installed authenticated SDP')
      if (!signalingOnly) await until(async () => (await Promise.all(pages.slice(0, expected + 1).map(page => page.evaluate(async () => {
        const active = window.peerConnections.filter(pc => pc.connectionState !== 'closed')
        return (await Promise.all(active.map(async pc => [...(await pc.getStats()).values()].some(report => report.type === 'inbound-rtp' && report.kind === 'audio' && report.packetsReceived > 0)))).every(Boolean)
      })))).every(Boolean), 'Every room peer received real RTP audio')
    }

    const beforePreview = wire.frames.length
    await prepare(a, 'video')
    assert.equal((await state(a)).connections.length, 0, 'Preview creates no peer transports')
    assert.deepEqual((await state(a)).liveTracks.map(track => track.kind).sort(), ['audio', 'video'])
    assert.ok(wire.frames.slice(beforePreview).every(({ body }) => !body.includes('room:join')), 'Preview does not join the server room')
    assert.equal((await state(b)).captureRequests, 0)
    assert.equal((await state(c)).captureRequests, 0)
    await join(a)
    assert.equal((await state(a)).participants.length, 0)
    await prepare(b); await join(b)
    await prepare(c); await join(c)
    await mesh(2)
    console.log(`PASS explicit preview then three-member group ${signalingOnly ? 'authenticated SDP mesh (RTP not verified)' : 'RTP media mesh'}`)

    await a.evaluate(() => window.rooms.toggleMicrophone())
    assert.equal((await state(a)).muted, true)
    assert.ok((await state(a)).liveTracks.filter(track => track.kind === 'audio').every(track => !track.enabled))
    await a.evaluate(() => window.rooms.toggleCamera())
    assert.equal((await state(a)).camera, false)
    assert.equal((await state(a)).liveTracks.filter(track => track.kind === 'video').length, 0)
    await c.evaluate(() => window.rooms.leave())
    await released(c)
    await until(async () => (await Promise.all([state(a), state(b)])).every(snapshot => snapshot.participants.length === 1), 'Leave updates the remaining room roster')
    assert.equal((await state(a)).muted, true, 'Roster change preserves microphone mute')
    await prepare(c); await join(c); await mesh(2)
    const removedGroup = await a.evaluate(async ({ group, owner, removed }) => SerotineRooms.signGroup({ ...group, epoch: 2, updatedAt: Date.now(), members: group.members.filter(pub => pub !== removed) }, owner), { group: fixture.group, owner: identities[0], removed: identities[2].publicKey })
    for (const page of pages) await page.evaluate(group => { window.roomTarget = { kind: 'group', group } }, removedGroup)
    await released(c)
    await until(async () => (await Promise.all([state(a), state(b)])).every(snapshot => snapshot.participants.length === 1 && snapshot.connections.filter(pc => pc.state !== 'closed').length === 1), 'Signed membership removal tears down removed peer media')
    await Promise.all([a, b].map(page => page.evaluate(() => window.rooms.leave())))
    await Promise.all(pages.map(released))
    console.log('PASS actual track mute/camera release, leave/rejoin, and signed membership removal cleanup')

    // A voice channel has its own room and uses the signed community membership.
    for (const page of [a, b]) {
      await page.evaluate(community => { window.roomTarget = { kind: 'channel', community, channelId: community.channels[1].id } }, fixture.community)
      await prepare(page); await join(page)
    }
    await mesh(1)
    await Promise.all([a, b].map(page => page.evaluate(() => window.rooms.leave())))
    await Promise.all(pages.map(released))
    for (const page of pages) await page.evaluate(() => window.rooms.dispose())
    console.log(`PASS signed community voice channel ${signalingOnly ? 'SDP exchange' : 'real RTP'} and release`)

    for (const page of [a, b]) await page.evaluate(() => {
      const owner = JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey
      localStorage.setItem(`serotine_call_settings:${owner}`, JSON.stringify({ relayOnly: true }))
    })

    const uiPages = await Promise.all(contexts.slice(0, 2).map(context => context.newPage()))
    const [uiA, uiB] = uiPages
    for (const page of uiPages) {
      observe(page)
      await page.addInitScript(() => {
        window.uiCaptureCount = 0; window.uiTracks = []
        const nativeCapture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async constraints => { window.uiCaptureCount++; const stream = await nativeCapture(constraints); window.uiTracks.push(...stream.getTracks()); return stream }
      })
    }
    await Promise.all(uiPages.map(page => page.goto(`${origin}/chat/${fixture.uiGroup.id}`)))
    await uiB.getByRole('button', { name: 'Group voice and video call options', exact: true }).click()
    assert.equal(await uiB.getByRole('menuitem', { name: 'Join group voice call', exact: true }).getAttribute('aria-disabled'), 'true', 'A group invitation cannot start calls before acceptance')
    await uiB.keyboard.press('Escape')
    await uiB.getByRole('button', { name: 'Accept', exact: true }).click()
    await uiB.getByRole('button', { name: 'Accept', exact: true }).waitFor({ state: 'detached' })
    const openGroup = async page => {
      await page.getByRole('button', { name: 'Group voice and video call options', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Join group voice call', exact: true }).click()
      assert.equal(await page.getByRole('button', { name: /Retry relay|Allow direct connections/ }).count(), 0, 'No TURN routing prompt')
      return page.getByRole('dialog', { name: 'Join Study group', exact: true })
    }
    const preview = await openGroup(uiA)
    await preview.getByRole('button', { name: 'Join call', exact: true }).waitFor()
    assert.equal(await uiB.evaluate(() => window.uiCaptureCount), 0, 'Other group member is not captured or joined automatically')
    await preview.getByRole('button', { name: 'Join call', exact: true }).click()
    await (await openGroup(uiB)).getByRole('button', { name: 'Join call', exact: true }).click()
    const bar = page => page.getByRole('region', { name: 'Current group call', exact: true })
    for (const page of uiPages) await bar(page).getByRole('button', { name: 'Leave call', exact: true }).waitFor()
    await bar(uiA).getByRole('button', { name: 'Show call participants and devices', exact: true }).click()
    const participants = uiA.getByRole('dialog', { name: 'Study group', exact: true })
    await participants.getByText(/^2\/8 participants/).waitFor()
    await participants.getByText('Bob', { exact: true }).waitFor()
    await participants.getByRole('button', { name: 'Collapse call', exact: true }).click()
    const screenshots = { animations: 'disabled', style: 'nextjs-portal { display: none; }' }
    const verifyLayout = async (page, label) => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const composer = await page.getByRole('textbox', { name: 'Message', exact: true }).boundingBox()
      const header = await page.getByRole('button', { name: 'Group voice and video call options', exact: true }).boundingBox()
      const callBar = await bar(page).boundingBox()
      assert.ok(composer && header && callBar, `${label}: call bar, header and composer rendered`)
      assert.ok(callBar.y >= 0 && header.y >= callBar.y + callBar.height - 1 && header.y + header.height <= composer.y && composer.y + composer.height <= page.viewportSize().height + 2, `${label}: all controls visible: ${JSON.stringify({ composer, header, callBar })}`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && window.scrollY === 0), `${label}: no page overflow`)
    }
    await verifyLayout(uiA, 'Desktop')
    await uiA.screenshot({ path: path.join(artifacts, 'group-call-desktop.png'), ...screenshots })
    await uiA.setViewportSize({ width: 320, height: 740 })
    await uiA.getByRole('textbox', { name: 'Message', exact: true }).fill('Typing during a group call')
    await verifyLayout(uiA, '320px mobile after typing')
    await uiA.screenshot({ path: path.join(artifacts, 'group-call-mobile-320.png'), ...screenshots })
    for (const page of uiPages) await bar(page).getByRole('button', { name: 'Leave call', exact: true }).click()
    console.log('PASS group entry/preview/join/leave controls and desktop/320px composer layout')

    // Owners can create a voice channel in the real settings flow, then enter it.
    await uiA.setViewportSize({ width: 1280, height: 900 })
    await uiA.goto(`${origin}/chat/communities#${new URLSearchParams({ id: fixture.community.id, channel: fixture.community.channels[0].id })}`)
    await uiA.getByRole('button', { name: 'Community settings', exact: true }).click()
    const settings = uiA.getByRole('dialog', { name: 'Community settings', exact: true })
    await settings.getByRole('button', { name: 'Add voice channel', exact: true }).click()
    const newName = settings.getByRole('textbox', { name: /^Channel name voice-/ })
    await newName.fill('Study voice')
    await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
    await settings.getByRole('button', { name: 'Close', exact: true }).click()
    await uiA.getByRole('navigation', { name: 'Community channels', exact: true }).getByRole('button', { name: /Study voice/ }).click()
    await uiA.getByRole('button', { name: 'Join voice channel', exact: true }).click()
    const voicePreview = uiA.getByRole('dialog', { name: /Join .*Study voice/ })
    await voicePreview.getByRole('button', { name: 'Join call', exact: true }).waitFor()
    assert.equal(await voicePreview.getByRole('button', { name: 'Turn camera on', exact: true }).count(), 0, 'Voice channels expose audio controls only')
    await voicePreview.getByRole('button', { name: 'Join call', exact: true }).click()
    await bar(uiA).getByRole('button', { name: 'Leave call', exact: true }).waitFor()
    await uiA.setViewportSize({ width: 320, height: 740 })
    assert.ok(await uiA.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Voice channel has no horizontal overflow at 320px')
    await uiA.screenshot({ path: path.join(artifacts, 'voice-channel-mobile-320.png'), ...screenshots })
    await uiB.goto(`${origin}/chat/communities#${new URLSearchParams({ id: fixture.community.id, channel: fixture.community.channels[0].id })}`)
    await uiB.getByRole('navigation', { name: 'Community channels', exact: true }).getByRole('button', { name: /Study voice/ }).click()
    await uiB.getByRole('button', { name: 'Join voice channel', exact: true }).click()
    await uiB.getByRole('dialog', { name: /Join .*Study voice/ }).getByRole('button', { name: 'Join call', exact: true }).click()
    await bar(uiA).getByRole('status').filter({ hasText: /2\/8 people/ }).waitFor()
    await uiA.setViewportSize({ width: 1280, height: 900 })
    await uiA.getByRole('button', { name: 'Community settings', exact: true }).click()
    const updatedSettings = uiA.getByRole('dialog', { name: 'Community settings', exact: true })
    await updatedSettings.getByRole('button', { name: 'Remove channel Study voice', exact: true }).click()
    await updatedSettings.getByRole('button', { name: 'Save settings', exact: true }).click()
    // Removing the selected channel may unmount its settings immediately.
    await uiA.keyboard.press('Escape')
    for (const page of uiPages) {
      await page.waitForFunction(() => window.uiTracks.every(track => track.readyState === 'ended'))
      assert.equal(await bar(page).getByRole('button', { name: 'Leave call', exact: true }).count(), 0, 'Deleted voice channel cannot keep a room joined')
    }
    console.log('PASS owner creates voice channel, another member joins, and signed channel deletion releases both participants\' capture')

    wire.verify(['call:socket', 'room:join', 'room:send', 'room:leave'])
    for (const page of pages) await verifyDirectConfiguration(page)
    assert.deepEqual(errors, [], 'No uncaught browser errors')
    console.log(`Call rooms browser smoke ${signalingOnly ? '(signaling/capture/UI only; RTP not verified) ' : ''}passed. Logs: ${artifacts}`)
  } catch (error) {
    console.error(`Call rooms smoke artifacts: ${artifacts}`)
    for (let index = 0; index < (browser?.contexts() || []).length; index++) for (const page of browser.contexts()[index].pages().slice(-1)) {
      try { fs.writeFileSync(path.join(artifacts, `failure-${index}.txt`), await page.locator('body').innerText()); await page.screenshot({ path: path.join(artifacts, `failure-${index}.png`), fullPage: true }) } catch { /* Preserve the original failure. */ }
    }
    throw error
  } finally {
    if (browser) await browser.close()
    await runtime.stop()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
