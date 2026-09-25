/* Materialize public build settings only; signing material is never copied. */
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
function validateOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port && url.port !== '443' || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error('SEROTINE_RELAY_ORIGIN must be a bare HTTPS origin on port 443')
  if (url.hostname === 'localhost' || !url.hostname.includes('.') || /^(\d+\.){3}\d+$/.test(url.hostname) || url.hostname.endsWith('.local')) throw new Error('Use the deployed HTTPS relay hostname')
  return url.origin
}
function prepare() {
  const relayOrigin = validateOrigin(process.env.SEROTINE_RELAY_ORIGIN || '')
  if (!fs.existsSync(path.join(root, '../web/dist/index.html'))) throw new Error('Build the shared native renderer first: npm run native:build')
  const destination = path.join(root, 'android/app/src/main/assets')
  fs.mkdirSync(destination, {recursive:true})
  const renderer = JSON.parse(fs.readFileSync(path.join(root, '../web/dist/native-config.json'), 'utf8'))
  if (renderer.relayOrigin !== relayOrigin || renderer.version !== require('../package.json').version || typeof renderer.development !== 'boolean') throw new Error('Renderer relay/version differs from mobile settings; rebuild the native renderer')
  const settings = JSON.stringify(renderer, null, 2)+'\n'
  fs.writeFileSync(path.join(destination, 'serotine-config.json'), settings)
  // Xcode treats // as comments even in quotes; the empty substitution preserves https://.
  fs.writeFileSync(path.join(root, 'ios/relay.generated.xcconfig'), `SEROTINE_RELAY_ORIGIN = ${relayOrigin.replace('://', ':/$()/')}\nSEROTINE_APP_VERSION = ${renderer.version}\n`)
}
if (require.main === module) prepare()
module.exports = {validateOrigin}
