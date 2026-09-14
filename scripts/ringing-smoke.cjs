/* eslint-disable no-console */
/* global SerotineRinging */
// Verify real Web Audio output and the browser's actual user-gesture requirement.
// This uses an isolated document and never opens microphones or network calls.
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require('playwright')
const esbuild = require('esbuild')

function setupRingingPage() {
  window.ringer = new SerotineRinging.CallRinger({ createContext() {
    const context = new AudioContext()
    window.ringAudio = context
    window.ringAnalyser = context.createAnalyser()
    const createGain = context.createGain.bind(context)
    context.createGain = () => {
      const gain = createGain()
      gain.connect(window.ringAnalyser)
      return gain
    }
    return context
  } })
  window.ringState = { callId: 'real-browser-incoming', phase: 'incoming', direction: 'incoming', settings: { silenceIncoming: false, relayOnly: true } }
  document.getElementById('enable').onclick = () => window.ringer.unlock()
  window.ringAmplitude = () => {
    const samples = new Float32Array(window.ringAnalyser.fftSize)
    window.ringAnalyser.getFloatTimeDomainData(samples)
    return Math.max(...samples.map(Math.abs))
  }
  window.ringer.setCall(window.ringState)
}

async function main() {
  const root = path.resolve(__dirname, '..')
  const bundle = (await esbuild.build({ entryPoints: [path.join(root, 'lib/call-ringer.ts')], bundle: true,
    write: false, platform: 'browser', format: 'iife', globalName: 'SerotineRinging' })).outputFiles[0].text
  const browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=document-user-activation-required'] })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('http://localhost:3211/**', route => route.fulfill({ contentType: 'text/html',
      body: `<!doctype html><title>Ringing verification</title><button id="enable">Enable call sounds</button><script>${bundle}</script><script>(${setupRingingPage.toString()})()</script>` }))
    await page.goto('http://localhost:3211/')

    assert.equal(await page.evaluate(() => window.ringer.getStatus()), 'blocked')
    assert.equal(await page.evaluate(() => window.ringAudio.state), 'suspended')
    assert.equal(await page.evaluate(() => window.ringAmplitude()), 0)
    await page.getByRole('button', { name: 'Enable call sounds' }).click()
    await page.waitForFunction(() => window.ringer.getStatus() === 'ready' && window.ringAmplitude() > 0.005)
    console.log('PASS incoming audio is blocked before a gesture and produces real samples after enabling')
    await page.evaluate(() => window.ringer.setCall({ ...window.ringState, phase: 'preparing' }))
    await page.waitForFunction(() => window.ringAmplitude() < 0.00001)
    console.log('PASS answering immediately silences the ringtone before capture or connection')
    await page.evaluate(() => window.ringer.setCall({ ...window.ringState, callId: 'outgoing', phase: 'ringing', direction: 'outgoing' }))
    await page.waitForFunction(() => window.ringAmplitude() > 0.005)
    await page.evaluate(() => window.ringer.setCall({ ...window.ringState, phase: 'connecting', direction: 'outgoing' }))
    await page.waitForFunction(() => window.ringAmplitude() < 0.00001)
    await page.evaluate(() => window.ringer.dispose())
    assert.equal(await page.evaluate(() => window.ringAudio.state), 'closed')
    assert.deepEqual(errors, [])
    console.log('PASS outgoing wait tone produces real samples and releases audio on connection/disposal')
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
