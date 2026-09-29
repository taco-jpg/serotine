const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { validateConfig } = require('./security.cjs')
const config = validateConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '../web/dist/native-config.json'), 'utf8')))
const release = process.env.SEROTINE_DESKTOP_RELEASE === '1'
const requestedArch = () => process.argv.includes('--arm64') ? ['arm64'] : process.argv.includes('--x64') ? ['x64'] : ['x64', 'arm64']
const macEntitlements = release ? 'entitlements.mac.plist' : 'entitlements.mac.dev.plist'
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
  artifactName: 'serotine-${version}-preview-${os}-${arch}-unsigned.${ext}',
  win: { artifactName: release ? 'serotine-${version}-windows-${arch}.${ext}' : 'serotine-${version}-preview-windows-${arch}-unsigned.${ext}', target: [{ target: 'nsis', arch: requestedArch() }], icon: 'icon.ico', signAndEditExecutable: true,
    signtoolOptions: { signingHashAlgorithms: ['sha256'] } },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false },
  mac: { artifactName: release ? 'serotine-${version}-macos-${arch}.${ext}' : 'serotine-${version}-preview-macos-${arch}-unsigned.${ext}', target: [{ target: 'dmg', arch: requestedArch() }, { target: 'zip', arch: requestedArch() }], icon: 'icon.icns', category: 'public.app-category.social-networking',
    hardenedRuntime: true, gatekeeperAssess: false, notarize: release,
    ...(release ? {} : { identity: '-' }),
    entitlements: macEntitlements, entitlementsInherit: macEntitlements,
    extendInfo: { NSCameraUsageDescription: 'Serotine uses your camera only when you start video or scan a contact QR code.',
      NSMicrophoneUsageDescription: 'Serotine uses your microphone when you join a voice or video call.' } },
  afterSign: async context => {
    if (context.electronPlatformName !== 'darwin') return
    const appName = release ? 'Serotine' : 'Serotine Dev'
    const appBundle = path.join(context.appOutDir, `${appName}.app`)
    const result = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appBundle], { encoding: 'utf8' })
    if (result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      throw new Error(`macOS app signature verification failed${detail ? `:\n${detail}` : '.'}`)
    }
  },
  dmg: { sign: release },
  publish: [{ provider: 'github', owner: 'taco-jpg', repo: 'serotine', releaseType: 'release' }],
}
