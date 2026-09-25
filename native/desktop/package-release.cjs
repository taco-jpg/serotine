const { spawnSync } = require('node:child_process')
const path = require('node:path')
if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Produce signed desktop releases on Windows or macOS.')
if (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD) throw new Error('Signed release requires CSC_LINK and CSC_KEY_PASSWORD in the protected release environment.')
if (process.platform === 'darwin' && !(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER)
  && !(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID)) {
  throw new Error('macOS release requires App Store Connect notarization credentials (API key or Apple ID, app-specific password and team ID).')
}
const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), '--config', 'electron-builder.cjs',
  process.platform === 'darwin' ? '--mac' : '--win', '--publish', 'never', ...process.argv.slice(2)], {
  cwd: path.resolve(__dirname), stdio: 'inherit', env: { ...process.env, SEROTINE_DESKTOP_RELEASE: '1' },
})
process.exit(result.status ?? 1)
