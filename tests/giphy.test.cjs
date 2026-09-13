const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const tick = () => new Promise(resolve => setImmediate(resolve))

function sample(id = 'abc123', overrides = {}) {
  const rendition = { url: `https://media2.giphy.com/media/${id}/giphy.gif?cid=keep-this&rid=giphy.gif`, width: '400', height: '300' }
  return { id, title: 'Dancing cat', alt_text: 'A cat dancing', username: 'artist', rating: 'g', images: { fixed_height: rendition, downsized: rendition }, ...overrides }
}
function response(data, total = data.length) {
  return { ok: true, status: 200, json: async () => ({ data, meta: { status: 200 }, pagination: { total_count: total } }) }
}
function configResponse(apiKey) { return { ok: true, status: 200, json: async () => ({ apiKey }) } }
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  return typeof node === 'string' || typeof node === 'number' ? String(node) : text(node?.props?.children || [])
}
function nodes(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, predicate))
  if (!node || typeof node !== 'object') return []
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)]
}

function runtime(fetch, key = 'test-only-key', supportsObserver = true, cloudflareContext = async () => ({ env: {} })) {
  let active
  const cache = new Map()
  const observers = []
  class ViewportObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this) }
    observe(target) { this.targets.add(target) }
    disconnect() { this.targets.clear() }
  }
  const react = Object.fromEntries(['useState', 'useRef', 'useEffect'].map(name => [name, (...args) => active[name](...args)]))
  function load(filename) {
    if (!path.extname(filename)) filename += fs.existsSync(filename + '.tsx') ? '.tsx' : '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    new Function('require', 'module', 'exports', 'fetch', 'process', 'IntersectionObserver', code)(specifier => {
      if (specifier === 'react') return react
      if (specifier === '@opennextjs/cloudflare') return { getCloudflareContext: cloudflareContext }
      if (specifier === '@/components/ui/button') return { Button: 'button' }
      if (specifier === '@/components/ui/input') return { Input: 'input' }
      if (specifier === '@/components/ui/dialog') return Object.fromEntries(['Dialog', 'DialogContent', 'DialogDescription', 'DialogHeader', 'DialogTitle', 'DialogTrigger'].map(name => [name, name]))
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return require(specifier)
    }, module, module.exports, fetch, { env: { NEXT_PUBLIC_GIPHY_API_KEY: key } }, supportsObserver ? ViewportObserver : undefined)
    return module.exports
  }
  function mount(Component, props) {
    const slots = [], effects = []
    let cursor = 0, unmounted = false, lateUpdates = 0
    const hooks = {
      useState(initial) {
        const index = cursor++
        if (!(index in slots)) slots[index] = initial
        return [slots[index], value => { if (unmounted) lateUpdates++; slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
      },
      useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
      useEffect(effect, dependencies) {
        const index = cursor++, previous = slots[index]
        if (!previous || dependencies.some((dependency, i) => dependency !== previous.dependencies[i])) {
          previous?.cleanup?.()
          const slot = { dependencies, cleanup: null }; slots[index] = slot
          effects.push(() => { slot.cleanup = effect() })
        }
      },
    }
    function view() {
      active = hooks; cursor = 0
      const result = Component(props)
      for (const node of nodes(result, node => typeof node.type === 'string' && node.props.ref)) node.props.ref.current ||= {}
      while (effects.length) effects.shift()()
      return result
    }
    return {
      view,
      intersect(isIntersecting = true) {
        const targets = nodes(view(), node => node.props.ref).map(node => node.props.ref.current)
        for (const observer of observers) {
          const entries = targets.filter(target => observer.targets.has(target)).map(target => ({ target, isIntersecting }))
          if (entries.length) observer.callback(entries)
        }
        view()
      },
      click(label) {
        const button = nodes(view(), node => node.type === 'button' && (node.props['aria-label'] || text(node)) === label)[0]
        assert.ok(button, `button: ${label}`); assert.ok(!button.props.disabled)
        button.props.onClick()
      },
      search(query) {
        nodes(view(), node => node.type === 'input')[0].props.onChange({ target: { value: query } })
        nodes(view(), node => node.type === 'form')[0].props.onSubmit({ preventDefault() {} })
        view()
      },
      unmount() { for (const slot of slots) slot?.cleanup?.(); unmounted = true },
      get lateUpdates() { return lateUpdates },
    }
  }
  return { lib: load(path.join(root, 'lib/giphy.ts')), load, mount }
}

test('recognizes only complete GIPHY page/embed links and persists a canonical ID URL', () => {
  const { lib } = runtime(() => { throw Error('no network') })
  for (const link of ['https://giphy.com/gifs/abc123', 'https://www.giphy.com/gifs/dancing-cat-abc123?source=share', ' https://giphy.com/embed/abc123/ ']) assert.equal(lib.parseGiphyUrl(link), 'abc123')
  for (const link of ['https://giphy.com.evil.test/gifs/abc123', 'https://giphy.com@evil.test/gifs/abc123', 'http://giphy.com/gifs/abc123', 'https://giphy.com:443/gifs/abc123', 'https://giphy.com/gifs/a%2Fb', 'https://giphy.com/gifs/abc123\nmore text', 'See https://giphy.com/gifs/abc123', 'https://giphy.com/gifs/abc123/extra', 'javascript:alert(1)']) assert.equal(lib.parseGiphyUrl(link), null, link)
  assert.equal(lib.giphyPageUrl('abc123'), 'https://giphy.com/gifs/abc123')
  assert.throws(() => lib.giphyPageUrl('../a'))
})

test('search is directly fetched with an exact encoded query, G rating, and no browser credentials', async () => {
  const calls = [], controller = new AbortController()
  const { lib } = runtime(async (...args) => { calls.push(args); return response([sample()], 2) })
  const result = await lib.fetchGiphyPage({ query: 'cat & dog + @artist', signal: controller.signal })
  const [url, options] = calls[0]
  assert.equal(url.origin, 'https://api.giphy.com')
  assert.equal(url.pathname, '/v1/gifs/search')
  assert.equal(url.searchParams.get('q'), 'cat & dog + @artist')
  assert.equal(url.searchParams.get('rating'), 'g')
  assert.equal(url.searchParams.get('customer_id'), null)
  assert.equal(options.credentials, 'omit')
  assert.equal(options.referrerPolicy, 'no-referrer')
  assert.equal(options.cache, 'no-store')
  assert.equal(options.signal, controller.signal)
  assert.equal(result.nextOffset, 1)
  assert.equal(result.gifs[0].imageUrl, sample().images.downsized.url)
})

test('trending pagination stops at the provider limit and preserves provider order', async () => {
  const calls = []
  const { lib } = runtime(async url => { calls.push(url); return response([sample('second'), sample('first')], 900) })
  const page = await lib.fetchGiphyPage({ offset: 498 })
  assert.equal(calls[0].pathname, '/v1/gifs/trending')
  assert.equal(calls[0].searchParams.has('q'), false)
  assert.deepEqual(page.gifs.map(gif => gif.id), ['second', 'first'])
  assert.equal(page.nextOffset, null)
  await assert.rejects(lib.fetchGiphyPage({ offset: 500 }), /No more/)
  await assert.rejects(lib.fetchGiphyPage({ query: 'a'.repeat(51) }), /50 characters/)
  assert.equal(calls.length, 1)
})

test('missing build keys consult only public configuration and provider rate/auth failures are actionable', async () => {
  const missing = runtime(async url => { assert.equal(url, '/api/giphy/config'); return configResponse(null) }, '').lib
  await assert.rejects(missing.fetchGiphyPage({}), /haven’t been enabled/)
  await assert.rejects(runtime(async () => ({ ok: false, status: 429 })).lib.fetchGiphyPage({}), /search limit/)
  await assert.rejects(runtime(async () => ({ ok: false, status: 403 })).lib.fetchGiphyPage({}), /current GIPHY key/)
})

test('runtime public configuration enables direct GIF requests when the build has no key', async () => {
  const calls = [], controller = new AbortController()
  const { lib } = runtime(async (url, options) => {
    calls.push({ url, options })
    return typeof url === 'string' ? configResponse(' runtime-public-key ') : response(sample())
  }, '')
  assert.equal((await lib.fetchGiphyGif('abc123', controller.signal)).id, 'abc123')
  assert.equal(calls[0].url, '/api/giphy/config')
  assert.equal(calls[0].options.credentials, 'omit')
  assert.equal(calls[0].options.cache, 'no-store')
  assert.equal(calls[0].options.referrerPolicy, 'no-referrer')
  assert.equal(calls[0].options.body, undefined)
  assert.equal(calls[1].url.origin, 'https://api.giphy.com')
  assert.equal(calls[1].url.searchParams.get('api_key'), 'runtime-public-key')
  assert.equal(calls[1].options.signal, controller.signal)
  await lib.fetchGiphyGif('abc123')
  assert.equal(calls.length, 3, 'successful public key is reused without caching any GIF metadata')
})

test('concurrent GIFs share configuration while each caller cancels independently', async () => {
  const calls = [], first = new AbortController(), second = new AbortController()
  const { lib } = runtime((url, options) => {
    if (typeof url === 'string') return new Promise(resolve => calls.push({ url, options, resolve }))
    calls.push({ url, options })
    return Promise.resolve(response(sample(url.pathname.split('/').at(-1))))
  }, '')
  const hidden = lib.fetchGiphyGif('first', first.signal)
  const rejected = assert.rejects(hidden, { name: 'AbortError' })
  const visible = lib.fetchGiphyGif('second', second.signal)
  assert.equal(calls.length, 1)
  first.abort()
  await rejected
  assert.equal(calls[0].options.signal.aborted, false)
  calls[0].resolve(configResponse('runtime-key'))
  assert.equal((await visible).id, 'second')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url.pathname, '/v1/gifs/second')
})

test('all callers cancelling aborts shared configuration and an abandoned response cannot poison retry', async () => {
  const calls = [], controller = new AbortController()
  const { lib } = runtime((url, options) => {
    if (typeof url === 'string') return new Promise(resolve => calls.push({ url, options, resolve }))
    calls.push({ url, options })
    return Promise.resolve(response(sample()))
  }, '')
  const pending = lib.fetchGiphyGif('abc123', controller.signal)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort()
  await rejected
  assert.equal(calls[0].options.signal.aborted, true)
  calls[0].resolve(configResponse('abandoned-key'))
  await tick()
  const retry = lib.fetchGiphyGif('abc123')
  assert.equal(calls.length, 2)
  calls[1].resolve(configResponse('current-key'))
  await retry
  assert.equal(calls[2].url.searchParams.get('api_key'), 'current-key')
})

test('absent or temporarily unavailable runtime configuration can recover on retry', async () => {
  for (const firstResponse of [configResponse(null), { ok: false, status: 503 }]) {
    let lookups = 0
    const { lib } = runtime(async url => typeof url === 'string'
      ? ++lookups === 1 ? firstResponse : configResponse('fixed-key')
      : response(sample()), '')
    await assert.rejects(lib.fetchGiphyGif('abc123'), /haven’t been enabled|Unable to load GIF settings/)
    assert.equal((await lib.fetchGiphyGif('abc123')).id, 'abc123')
    assert.equal(lookups, 2)
  }
})

test('public config route reads a runtime binding, disables caching, and exposes no other environment fields', async () => {
  const env = { NEXT_PUBLIC_GIPHY_API_KEY: ' runtime-only-key ', GIPHY_API_KEY: 'private-secret', CLOUDFLARE_API_TOKEN: 'private-token' }
  const r = runtime(() => { throw Error('must not fetch') }, '', true, async options => {
    assert.deepEqual(options, { async: true })
    return { env }
  })
  const route = r.load(path.join(root, 'app/api/giphy/config/route.ts'))
  assert.equal(route.dynamic, 'force-dynamic')
  const result = await route.GET()
  assert.equal(result.status, 200)
  assert.match(result.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await result.json(), { apiKey: 'runtime-only-key' })
})

test('public config route allows only the named public key and retains a build-key fallback', async () => {
  for (const [env, buildKey, expected] of [
    [{ GIPHY_API_KEY: 'must-remain-private' }, '', null],
    [{ NEXT_PUBLIC_GIPHY_API_KEY: 123 }, '', null],
    [{ NEXT_PUBLIC_GIPHY_API_KEY: ' ' }, 'build-key', 'build-key'],
    [{ NEXT_PUBLIC_GIPHY_API_KEY: 'runtime-key' }, 'build-key', 'runtime-key'],
  ]) {
    const r = runtime(() => { throw Error('must not fetch') }, buildKey, true, async () => ({ env }))
    const result = await r.load(path.join(root, 'app/api/giphy/config/route.ts')).GET()
    assert.deepEqual(await result.json(), { apiKey: expected })
  }
  const unavailable = runtime(() => { throw Error('must not fetch') }, '', true, async () => { throw Error('unavailable') })
  const result = await unavailable.load(path.join(root, 'app/api/giphy/config/route.ts')).GET()
  assert.equal(result.status, 503)
  assert.match(result.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await result.json(), { apiKey: null })
})

test('provider content fails closed on ratings, unexpected IDs, and unsafe media origins', async () => {
  for (const rating of ['r', 'pg-13', undefined]) await assert.rejects(runtime(async () => response(sample('abc123', { rating }))).lib.fetchGiphyGif('abc123'), /content filter/)
  await assert.rejects(runtime(async () => response(sample('other'))).lib.fetchGiphyGif('abc123'), /different GIF/)
  const bad = sample('abc123', { images: { fixed_height: { url: 'https://media2.giphy.com.evil.test/gif', width: 10, height: 10 } } })
  await assert.rejects(runtime(async () => response(bad)).lib.fetchGiphyGif('abc123'), /unavailable image/)
  await assert.rejects(runtime(() => { throw Error('must not fetch') }).lib.fetchGiphyGif('../search'), /Invalid GIF ID/)
})

test('GIFs load automatically on entering the viewport; hiding and unmounting abort late loads', async () => {
  const calls = []
  const r = runtime((url, options) => new Promise(resolve => calls.push({ url, options, resolve })))
  const { GifMessage } = r.load(path.join(root, 'components/chat/gif-message.tsx'))
  const element = GifMessage({ id: 'abc123' }), h = r.mount(element.type, element.props)
  h.view()
  assert.equal(calls.length, 0)
  assert.equal(nodes(h.view(), node => ['img', 'video', 'iframe'].includes(node.type)).length, 0)
  h.intersect(false)
  assert.equal(calls.length, 0, 'offscreen history waits until visible')
  h.intersect()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url.pathname, '/v1/gifs/abc123')
  h.click('Hide GIF'); h.view()
  assert.equal(calls[0].options.signal.aborted, true)
  calls[0].resolve(response(sample()))
  await tick()
  assert.equal(nodes(h.view(), node => node.type === 'img').length, 0)
  h.intersect(false); h.intersect()
  assert.equal(calls.length, 1, 'scrolling never overrides an explicit Hide GIF')
  h.click('Show GIF'); h.view()
  h.unmount()
  assert.equal(calls[1].options.signal.aborted, true)
  calls[1].resolve(response(sample()))
  await tick()
  assert.equal(h.lateUpdates, 0)
})

test('received GIF renders at a useful size after loading and recovers from broken media', async () => {
  const r = runtime(async () => response(sample()))
  const { GifMessage } = r.load(path.join(root, 'components/chat/gif-message.tsx'))
  const element = GifMessage({ id: 'abc123' }), h = r.mount(element.type, element.props)
  h.intersect(); await tick()
  const img = nodes(h.view(), node => node.type === 'img')[0]
  assert.equal(img.props.src, sample().images.downsized.url)
  assert.equal(img.props.width, 400)
  assert.equal(img.props.referrerPolicy, 'no-referrer')
  img.props.onError()
  assert.match(text(h.view()), /could not be displayed/)
  assert.equal(nodes(h.view(), node => node.type === 'img').length, 0)
  h.click('Try again'); h.view(); await tick()
  assert.equal(nodes(h.view(), node => node.type === 'img').length, 1)
  h.unmount()
})

test('automatic GIF viewing still handles unconfigured sites and browsers without visibility observers', async () => {
  const missing = runtime(async url => { assert.equal(url, '/api/giphy/config'); return configResponse(null) }, '')
  const { GifMessage: MissingGif } = missing.load(path.join(root, 'components/chat/gif-message.tsx'))
  const missingElement = MissingGif({ id: 'abc123' }), disabled = missing.mount(missingElement.type, missingElement.props)
  disabled.intersect()
  assert.match(text(disabled.view()), /Loading GIF/)
  assert.doesNotMatch(text(disabled.view()), /haven’t been enabled/)
  await tick()
  assert.match(text(disabled.view()), /haven’t been enabled/)
  assert.equal(nodes(disabled.view(), node => node.type === 'img').length, 0)
  disabled.unmount()

  const fallback = runtime(async () => response(sample()), 'test-only-key', false)
  const { GifMessage } = fallback.load(path.join(root, 'components/chat/gif-message.tsx'))
  const element = GifMessage({ id: 'abc123' }), h = fallback.mount(element.type, element.props)
  h.view(); h.view(); await tick()
  assert.equal(nodes(h.view(), node => node.type === 'img').length, 1, 'no click needed without IntersectionObserver')
  h.unmount()
})

test('picker only searches on intent, ignores stale responses, and stages a canonical URL', async () => {
  const calls = [], selected = []
  const r = runtime((url, options) => new Promise(resolve => calls.push({ url, options, resolve })))
  const { GifPicker } = r.load(path.join(root, 'components/chat/gif-picker.tsx'))
  const outer = r.mount(GifPicker, { onSelectGif: url => selected.push(url) })
  outer.view().props.onOpenChange(true)
  const element = nodes(outer.view(), node => typeof node.type === 'function' && node.type.name === 'GifSearch')[0]
  const h = r.mount(element.type, element.props)
  h.view()
  assert.equal(calls.length, 0)
  h.search('old'); h.search('new')
  assert.equal(calls[0].options.signal.aborted, true)
  calls[1].resolve(response([sample('new123')], 1)); await tick()
  calls[0].resolve(response([sample('old123')], 1)); await tick()
  assert.deepEqual(nodes(h.view(), node => node.type === 'img').map(node => node.props.src), [sample('new123').images.fixed_height.url])
  assert.deepEqual(selected, [])
  h.click('Choose Dancing cat')
  assert.deepEqual(selected, ['https://giphy.com/gifs/new123'])
  assert.equal(outer.view().props.open, false)
  h.unmount(); outer.unmount()
  assert.equal(h.lateUpdates, 0)
})
