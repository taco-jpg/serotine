// Capacitor sync regenerates this manifest. Keep native code exact-pinned too.
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(__dirname, '../ios/App/CapApp-SPM/Package.swift')
const version = require('../package.json').dependencies['@capacitor/ios']
const text = fs.readFileSync(file, 'utf8')
const pinned = text.replace(/\.iOS\(\.v\d+\)/, '.iOS("16.4")').replace(/(capacitor-swift-pm\.git",\s*)(?:from|exact):\s*"[^"]+"/, `$1exact: "${version}"`)
if (!pinned.includes(`exact: "${version}"`)) throw new Error('Unable to pin Capacitor Swift dependency')
fs.writeFileSync(file, pinned)
