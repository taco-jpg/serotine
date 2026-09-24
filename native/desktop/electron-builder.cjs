const fs = require('node:fs')
const path = require('node:path')
const { validateConfig } = require('./security.cjs')
const config = validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '../web/dist/native-config.json'), 'utf8')))
const release = process.env.SEROTINE_DESKTOP_RELEASE === '1'
if (release && config.development) throw new Error('Build the shared native client with --release before packaging a release.')
if (!release && !config.development) throw new Error('Unsigned packages must use a development bundle and the separate development application ID.')

module.exports = {
  appId: release ? 'app.serotine.client' : 'app.serotine.client.dev',
  productName: release ? 'Serotine' : 'Serotine Dev',
  electronVersion: '44.4.5',
  extraMetadata: { version: config.version },
  directories: { output: 'dist' },
  files: ['main.cjs', 'preload.cjs', 'security.cjs', 'encrypted-store.cjs', 'transport.cjs', 'package.json', 'icon.png',
    { from: '../web/dist', to: 'web', filter: ['**/*', '!**/*.map'] }],
  asar: true,
  electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true, grantFileProtocolExtraPrivileges: false },
  npmRebuild: false,
  forceCodeSigning: release,
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  win: { target: [{ target: 'nsis', arch: ['x64', 'arm64'] }], icon: 'icon.ico', signAndEditExecutable: true,
    signtoolOptions: { signingHashAlgorithms: ['sha256'] } },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
  mac: { target: [{ target: 'dmg', arch: ['x64', 'arm64'] }], icon: 'icon.icns', category: 'public.app-category.social-networking',
    hardenedRuntime: true, gatekeeperAssess: false, notarize: release,
    ...(release ? {} : { identity: null }),
    entitlements: 'entitlements.mac.plist', entitlementsInherit: 'entitlements.mac.plist',
    extendInfo: { NSCameraUsageDescription: 'Serotine uses your camera only when you start video or scan a contact QR code.',
      NSMicrophoneUsageDescription: 'Serotine uses your microphone when you join a voice or video call.' } },
  dmg: { sign: release },
  publish: null,
}
