const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const output = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/themes.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const themeModule = { exports: {} }
new Function('module', 'exports', output)(themeModule, themeModule.exports)
const {
  PRESET_THEMES, DEFAULT_THEME_ID, MAX_CUSTOM_THEMES, MAX_THEME_FILE_SIZE,
  defaultThemePreferences, parseThemePreferences, getColorTheme, normalizeCustomTheme,
  parseThemeFile, serializeThemeFile, themeVariables, getContrastWarnings,
} = themeModule.exports

const custom = () => ({ ...structuredClone(PRESET_THEMES[1]), id: 'custom-fixture', name: 'My forest' })
const file = () => ({ version: 1, name: 'Shared forest', baseId: 'forest', light: {}, dark: {} })

test('all built-in variants remain readable and expose color-only semantic tokens', () => {
  for (const theme of PRESET_THEMES) {
    for (const mode of ['light', 'dark']) {
      const colors = theme[mode]
      assert.deepEqual(getContrastWarnings(colors), [], `${theme.id} ${mode}`)
      const variables = themeVariables(colors)
      const errorTextWarnings = getContrastWarnings({ ...colors, foreground: variables['--destructive'] })
        .filter(warning => ['Main text', 'Surface text', 'Sidebar text'].includes(warning.label))
      assert.deepEqual(errorTextWarnings, [], `${theme.id} ${mode} error text must meet 4.5:1 contrast`)
      assert.equal(variables['--background'], colors.background)
      assert.equal(variables['--sidebar'], colors.sidebar)
      assert.equal(variables['--message-outgoing'], colors.outgoing)
      assert.equal(variables['--theme-chrome'], colors.background)
      assert.ok(Object.values(variables).every(color => /^#[0-9a-f]{6}$/.test(color)))
      assert.ok(Object.keys(variables).every(key => !/radius|spacing|font|height|width/.test(key)))
    }
  }
  const warnings = getContrastWarnings({ ...PRESET_THEMES[0].light, foreground: PRESET_THEMES[0].light.background })
  assert.ok(warnings.some(warning => warning.label === 'Main text' && warning.ratio === 1))
})

test('saved preferences recover usable themes, reject damaged entries and bound custom count', () => {
  for (const raw of [null, '', '{broken', 'null', '[]', '{"__proto__":{}}']) {
    assert.deepEqual(parseThemePreferences(raw), defaultThemePreferences())
  }
  const valid = custom()
  const incomplete = { ...valid, id: 'custom-incomplete', light: { accent: '#ABCDEF' } }
  const prefs = parseThemePreferences(JSON.stringify({
    selectedId: valid.id,
    customThemes: [valid, { ...valid, id: 'custom-bad', dark: { accent: 'url(https://example.com)' } }, valid, incomplete],
  }))
  assert.equal(prefs.selectedId, valid.id)
  assert.deepEqual(prefs.customThemes.map(theme => theme.id), ['custom-fixture', 'custom-incomplete'])
  assert.equal(prefs.customThemes[1].light.background, PRESET_THEMES[1].light.background)
  assert.equal(prefs.customThemes[1].light.accent, '#abcdef')
  assert.equal(getColorTheme(prefs).id, valid.id)
  assert.equal(getColorTheme(prefs, 'missing').id, DEFAULT_THEME_ID)
  assert.equal(parseThemePreferences(JSON.stringify({ selectedId: 'gone' })).selectedId, DEFAULT_THEME_ID)
  const many = Array.from({ length: 30 }, (_, i) => ({ ...valid, id: `custom-${i}` }))
  assert.equal(parseThemePreferences(JSON.stringify({ customThemes: many })).customThemes.length, MAX_CUSTOM_THEMES)
  assert.throws(() => normalizeCustomTheme({ ...valid, id: 'default' }), /invalid ID/)
})

test('theme sharing round trips only allowlisted data and imports receive fresh local identities', () => {
  const imported = parseThemeFile(JSON.stringify(file()))
  assert.deepEqual(imported.light, PRESET_THEMES[1].light)
  assert.deepEqual(imported.dark, PRESET_THEMES[1].dark)
  assert.match(imported.id, /^custom-[a-f0-9-]{36}$/)
  const exported = serializeThemeFile({ ...imported, credentials: 'never-export', messages: ['private'] })
  assert.deepEqual(Object.keys(JSON.parse(exported)), ['version', 'name', 'baseId', 'light', 'dark'])
  assert.ok(!exported.includes('never-export') && !exported.includes('private') && !exported.includes(imported.id))
  const second = parseThemeFile(exported)
  assert.notEqual(second.id, imported.id)
  assert.deepEqual(second.light, imported.light)
})

test('invalid or executable-looking imports fail without changing current preferences', () => {
  const prefs = { selectedId: 'forest', customThemes: [custom()] }
  const before = structuredClone(prefs)
  const invalid = [
    { ...file(), version: 2 }, { ...file(), dark: undefined },
    { ...file(), baseId: '__proto__' }, { ...file(), name: 'x'.repeat(41) },
    { ...file(), id: 'forest' }, { ...file(), css: 'body { display: none }' },
    { ...file(), light: { accent: 'red' } },
    { ...file(), light: { background: 'url(https://example.com/image.png)' } },
    { ...file(), dark: { background: '#000000;display:none' } },
    { ...file(), light: { fontSize: '1px' } },
  ]
  for (const entry of invalid) assert.throws(() => parseThemeFile(JSON.stringify(entry)))
  assert.throws(() => parseThemeFile('{"version":1,"name":"Bad","baseId":"forest","light":{"__proto__":{}},"dark":{}}'))
  assert.throws(() => parseThemeFile(' '.repeat(MAX_THEME_FILE_SIZE + 1)), /too large/)
  assert.throws(() => parseThemeFile('{broken'), /valid JSON/)
  assert.throws(() => normalizeCustomTheme({ ...custom(), light: Object.assign(Object.create({ accent: '#ffffff' }), {}) }))
  assert.deepEqual(prefs, before)
})
