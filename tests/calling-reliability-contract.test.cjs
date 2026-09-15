const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const protocol = fs.readFileSync(path.join(root, 'lib/call-protocol.ts'), 'utf8')
const provider = fs.readFileSync(path.join(root, 'components/calling-provider.tsx'), 'utf8')

function numericConstant(source, name) {
  const match = source.match(new RegExp(`export const ${name} = ([0-9_]+)`))
  assert.ok(match, `${name} must remain an explicit numeric protocol constant`)
  return Number(match[1].replaceAll('_', ''))
}

test('fallback signaling has recovery margin before WebRTC timeout', () => {
  const signalTtl = numericConstant(protocol, 'CALL_SIGNAL_TTL_MS')
  const poll = provider.match(/pollIntervalMs:\s*([0-9_]+)/)
  assert.ok(poll, 'calling provider must declare a bounded fallback poll interval')
  const pollMs = Number(poll[1].replaceAll('_', ''))
  assert.ok(pollMs <= 10_000, `fallback polling must recover well before the 30s connect deadline; got ${pollMs}ms`)
  assert.ok(signalTtl >= pollMs * 6, `negotiation signals need multiple fallback opportunities; ttl=${signalTtl}, poll=${pollMs}`)
  assert.ok(signalTtl >= 90_000, `negotiation signals should survive timer throttling and missed WSS wakeups; got ${signalTtl}ms`)
})
