const fs = require('node:fs')
const path = require('node:path')

/** Offline Wrangler startup and an isolated synthetic D1 for browser suites. */
async function localBrowserEnvironment(root, artifacts) {
  const environment = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_SEND_ERROR_REPORTS: 'false',
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    SEROTINE_LOCAL_TEST_CONFIG: path.join(root, 'tests/fixtures/wrangler-browser.toml'),
    SEROTINE_LOCAL_TEST_STATE: path.join(artifacts, 'worker-state'),
  }
  // Wrangler reads these at module load time, before the local proxy is created.
  for (const name of ['WRANGLER_SEND_METRICS', 'WRANGLER_SEND_ERROR_REPORTS', 'CLOUDFLARE_CF_FETCH_ENABLED']) process.env[name] = environment[name]
  const { getPlatformProxy } = await import('wrangler')
  const proxy = await getPlatformProxy({ configPath: environment.SEROTINE_LOCAL_TEST_CONFIG, remoteBindings: false, persist: { path: environment.SEROTINE_LOCAL_TEST_STATE } })
  try {
    for (const file of fs.readdirSync(path.join(root, 'migrations')).filter(file => file.endsWith('.sql')).sort()) {
      const sql = fs.readFileSync(path.join(root, 'migrations', file), 'utf8')
      const statements = sql.replace(/--[^\n]*/g, '').split(';').map(statement => statement.trim()).filter(Boolean)
      await proxy.env.serotine_db.batch(statements.map(statement => proxy.env.serotine_db.prepare(statement)))
    }
  } finally { await proxy.dispose() }
  return environment
}

module.exports = { localBrowserEnvironment }
