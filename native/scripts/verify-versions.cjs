'use strict'

const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')
const packages = ['package.json', 'native/desktop/package.json', 'native/mobile/package.json']
const version = JSON.parse(fs.readFileSync(path.join(root, packages[0]), 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Native packages require a numeric major.minor.patch version')
for (const file of packages) {
  if (JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).version !== version) {
    throw new Error(`${file} must match the root version ${version}`)
  }
}
if (process.argv.includes('--release')) {
  if (process.env.EXPECTED_VERSION !== version) throw new Error('The requested release version must match all three package.json files')
  const build = process.env.SEROTINE_BUILD_NUMBER || ''
  if (!/^[1-9]\d*$/.test(build) || Number(build) > 2100000000) throw new Error('SEROTINE_BUILD_NUMBER must be an increasing positive integer <= 2100000000')
  const previous = process.env.NATIVE_LAST_RELEASE_BUILD_NUMBER || ''
  if (!/^\d+$/.test(previous) || Number(previous) >= Number(build)) throw new Error('Set NATIVE_LAST_RELEASE_BUILD_NUMBER to the last distributed build (0 for the first); the new build must be greater')
}
process.stdout.write(`Native package version: ${version}\n`)
