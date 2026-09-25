import { build } from 'esbuild'
import postcss from 'postcss'
import tailwind from '@tailwindcss/postcss'
import { readFile, writeFile, mkdir, rm, cp, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateNativeOrigin } from './native-config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'native/web/dist')
const development = !process.argv.includes('--release')
const relayValue = process.env.SEROTINE_RELAY_ORIGIN
if (!relayValue) throw new Error('Set SEROTINE_RELAY_ORIGIN to the HTTPS origin of your Serotine relay before building.')
const relayOrigin = validateNativeOrigin(relayValue, { development })
const version = process.env.SEROTINE_APP_VERSION || JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('SEROTINE_APP_VERSION must have the form major.minor.patch.')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(path.join(root, 'public'), output, { recursive: true })
// Service workers are for the hosted browser app; native startup uses bundled code.
await rm(path.join(output, 'messaging-sw.js'), { force: true })
const originalIdb = path.join(root, 'node_modules/idb/build/index.js')
const result = await build({
  absWorkingDir: root,
  entryPoints: ['native/web/bootstrap.tsx'],
  outfile: path.join(output, 'app.js'),
  bundle: true, minify: true, sourcemap: false, metafile: true,
  platform: 'browser', format: 'esm', target: ['chrome120', 'safari16.4'], jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  alias: { 'next/link': path.join(root, 'native/web/router.tsx'), 'next/navigation': path.join(root, 'native/web/router.tsx'), 'next-themes': path.join(root, 'native/web/themes.tsx') },
  plugins: [{ name: 'native-persistence', setup(builder) {
    builder.onResolve({ filter: /^idb$/ }, args => ({ path: args.importer.endsWith('persistence-idb.ts') ? originalIdb : path.join(root, 'native/shared/persistence-idb.ts') }))
  } }],
})
const serverInputs = Object.keys(result.metafile.inputs).filter(name => /(?:app\/api\/|app\/actions|@opennextjs|node:)/.test(name))
if (serverInputs.length) throw new Error('Installed renderer unexpectedly includes server code: ' + serverInputs.join(', '))
const css = await postcss([tailwind({ base: root })]).process(await readFile(path.join(root, 'app/globals.css'), 'utf8'), { from: path.join(root, 'app/globals.css'), to: path.join(output, 'theme.css') })
await writeFile(path.join(output, 'theme.css'), css.css + '\n' + await readFile(path.join(root, 'native/web/native.css'), 'utf8'))
await writeFile(path.join(output, 'native-config.json'), JSON.stringify({ relayOrigin, version, development }, null, 2) + '\n')
const files = await readdir(output)
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self' blob: data: https://api.giphy.com https://*.giphy.com; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"
await writeFile(path.join(output, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content"><meta name="color-scheme" content="light dark"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Serotine</title><link rel="stylesheet" href="/theme.css">${files.includes('app.css') ? '<link rel="stylesheet" href="/app.css">' : ''}</head><body><div id="root"><p class="native-failure" role="status">Opening your saved data…</p></div><script type="module" src="/app.js"></script></body></html>`)
await writeFile(path.join(output, 'bundle-inputs.json'), JSON.stringify(Object.keys(result.metafile.inputs), null, 2))
process.stdout.write(`Bundled Serotine ${version} (${development ? 'development' : 'release'}) for ${relayOrigin}\n`)
