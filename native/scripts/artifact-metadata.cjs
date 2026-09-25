'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const root = path.resolve(__dirname, '../..')
const [directory, platform, architecture, channel] = process.argv.slice(2)
if (!directory || !['windows', 'macos', 'android', 'ios'].includes(platform)
  || !['x64', 'arm64', 'universal'].includes(architecture) || !['development', 'release'].includes(channel)) {
  throw new Error('Usage: artifact-metadata.cjs DIRECTORY windows|macos|android|ios x64|arm64|universal development|release')
}
const destination = path.resolve(directory)
const expectedExtension = {windows: '.exe', macos: '.dmg', android: '.apk', ios: '.ipa'}[platform]
const names = fs.readdirSync(destination).filter(name => path.extname(name) === expectedExtension).sort()
if (!names.length) throw new Error(`No ${expectedExtension} artifacts found in ${directory}`)
const files = names.map(name => {
  if (!/^[\w. ()+-]+$/.test(name)) throw new Error('Unsafe artifact filename')
  const file = path.join(destination, name)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Artifacts must be regular files')
  return {name, bytes: stat.size, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}
})
const metadata = {
  schema: 1,
  version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
  buildNumber: process.env.SEROTINE_BUILD_NUMBER || null,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  platform, architecture, channel,
  appId: channel === 'release' ? 'app.serotine.client' : 'app.serotine.client.dev',
  validation: 'Build artifact only; physical-device qualification and distribution approval are separate.',
  files,
}
fs.writeFileSync(path.join(destination, 'ARTIFACTS.json'), JSON.stringify(metadata, null, 2) + '\n')
fs.writeFileSync(path.join(destination, 'SHA256SUMS'), files.map(file => `${file.sha256}  ${file.name}\n`).join(''))
process.stdout.write(`Wrote metadata and SHA-256 checksums for ${files.length} artifact(s)\n`)
