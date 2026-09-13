/** Local, data-only color palettes. Appearance mode and layout stay independent. */
export type ThemeMode = 'light' | 'dark'

export type ThemeColors = {
  background: string
  foreground: string
  surface: string
  sidebar: string
  accent: string
  mutedText: string
  incoming: string
  incomingText: string
  outgoing: string
  outgoingText: string
}

export type ColorTheme = {
  id: string
  name: string
  baseId: string
  light: ThemeColors
  dark: ThemeColors
}

export type ThemePreferences = { selectedId: string; customThemes: ColorTheme[] }

export const DEFAULT_THEME_ID = 'default'
export const THEME_STORAGE_KEY = 'serotine:palettes:v1'
export const MAX_CUSTOM_THEMES = 20
export const MAX_THEME_NAME_LENGTH = 40
export const MAX_THEME_FILE_SIZE = 16_384

export const THEME_COLOR_KEYS: (keyof ThemeColors)[] = [
  'background', 'foreground', 'surface', 'sidebar', 'accent', 'mutedText',
  'incoming', 'incomingText', 'outgoing', 'outgoingText',
]

function palette(values: string[]): ThemeColors {
  return Object.fromEntries(THEME_COLOR_KEYS.map((key, i) => [key, values[i]])) as ThemeColors
}

function preset(id: string, name: string, light: string[], dark: string[]): ColorTheme {
  return { id, name, baseId: id, light: palette(light), dark: palette(dark) }
}

export const PRESET_THEMES: ColorTheme[] = [
  // These editable colors match globals.css. The default theme itself leaves
  // root variables untouched, preserving every original derived color too.
  preset('default', 'Default',
    ['#f8fafc', '#1e293b', '#ffffff', '#eef2f7', '#4f46e5', '#526176', '#ffffff', '#1e293b', '#dfe6ff', '#283967'],
    ['#151922', '#e5eaf2', '#1d2430', '#10151e', '#a5b4fc', '#a3afc2', '#222b39', '#e5eaf2', '#303d66', '#edf2ff']),
  preset('forest', 'Forest',
    ['#f4faf6', '#183b2a', '#ffffff', '#e8f2ec', '#17623d', '#496758', '#ffffff', '#183b2a', '#d9efe0', '#173d2a'],
    ['#121e18', '#e3f1e7', '#1b2c22', '#0e1913', '#8cdbab', '#a4bfae', '#23372b', '#e3f1e7', '#2b503a', '#ebfff1']),
  preset('ocean', 'Ocean',
    ['#f3f9fc', '#193b4b', '#ffffff', '#e7f1f7', '#12648b', '#476776', '#ffffff', '#193b4b', '#d8edf8', '#173e53'],
    ['#111d26', '#e2eef6', '#1a2b38', '#0d1720', '#89cee9', '#a5bbc9', '#203545', '#e2eef6', '#254860', '#ebf8ff']),
  preset('lavender', 'Lavender',
    ['#faf7fd', '#362b49', '#ffffff', '#f0eaf7', '#6d3ca1', '#6b587c', '#ffffff', '#362b49', '#eadff7', '#452961'],
    ['#1c1725', '#f0e8fa', '#292134', '#16121e', '#cbb0f2', '#c1afcf', '#33283f', '#f0e8fa', '#4a365e', '#f7edff']),
  preset('rose', 'Rose',
    ['#fff7f8', '#4b2933', '#ffffff', '#f8e9ed', '#a32951', '#7e5361', '#ffffff', '#4b2933', '#f8dfe7', '#682840'],
    ['#25171d', '#fae8ef', '#34212a', '#1d1117', '#f5abc2', '#cfafbb', '#402833', '#fae8ef', '#613246', '#ffedf4']),
  preset('monochrome', 'Monochrome',
    ['#f8f8f8', '#242424', '#ffffff', '#ededed', '#3d3d3d', '#606060', '#ffffff', '#242424', '#e2e2e2', '#292929'],
    ['#191919', '#ededed', '#252525', '#121212', '#dddddd', '#b4b4b4', '#2d2d2d', '#ededed', '#424242', '#fafafa']),
]

const hexColor = /^#[\da-f]{6}$/i
const customId = /^custom-[a-zA-Z0-9-]{1,80}$/
const own = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key)

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function allowKeys(value: Record<string, unknown>, keys: readonly string[], label: string) {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw new Error(`${label} contains an unsupported property.`)
  }
}

function readName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_THEME_NAME_LENGTH
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error(`Theme name must be 1–${MAX_THEME_NAME_LENGTH} characters without control characters.`)
  }
  return value.trim()
}

function readBase(value: unknown): ColorTheme {
  const base = PRESET_THEMES.find(theme => theme.id === value)
  if (!base) throw new Error('Choose a supported built-in base palette.')
  return base
}

function readColors(value: unknown, fallback: ThemeColors, label: string): ThemeColors {
  const input = record(value, label)
  allowKeys(input, THEME_COLOR_KEYS, label)
  const colors = { ...fallback }
  for (const key of THEME_COLOR_KEYS) {
    if (!own(input, key)) continue
    const color = input[key]
    if (typeof color !== 'string' || !hexColor.test(color)) {
      throw new Error(`${label}.${key} must be a six-digit hex color, such as #4f46e5.`)
    }
    colors[key] = color.toLowerCase()
  }
  return colors
}

export function normalizeCustomTheme(input: ColorTheme): ColorTheme {
  const value = record(input, 'Theme')
  allowKeys(value, ['id', 'name', 'baseId', 'light', 'dark'], 'Theme')
  if (typeof value.id !== 'string' || !customId.test(value.id)) {
    throw new Error('Custom theme has an invalid ID.')
  }
  const base = readBase(value.baseId)
  return {
    id: value.id,
    name: readName(value.name),
    baseId: base.id,
    light: readColors(value.light, base.light, 'Light colors'),
    dark: readColors(value.dark, base.dark, 'Dark colors'),
  }
}

export function defaultThemePreferences(): ThemePreferences {
  return { selectedId: DEFAULT_THEME_ID, customThemes: [] }
}

export function parseThemePreferences(raw: string | null): ThemePreferences {
  if (!raw || raw.length > MAX_CUSTOM_THEMES * MAX_THEME_FILE_SIZE) return defaultThemePreferences()
  try {
    const value = record(JSON.parse(raw), 'Theme preferences')
    allowKeys(value, ['selectedId', 'customThemes'], 'Theme preferences')
    const customs: ColorTheme[] = []
    const seen = new Set<string>()
    if (Array.isArray(value.customThemes)) {
      for (const candidate of value.customThemes.slice(0, MAX_CUSTOM_THEMES)) {
        try {
          const theme = normalizeCustomTheme(candidate)
          if (!seen.has(theme.id)) {
            customs.push(theme)
            seen.add(theme.id)
          }
        } catch {
          // Discard only the damaged custom entry; keep other saved palettes.
        }
      }
    }
    const selectedId = typeof value.selectedId === 'string'
      && (PRESET_THEMES.some(theme => theme.id === value.selectedId) || seen.has(value.selectedId))
      ? value.selectedId : DEFAULT_THEME_ID
    return { selectedId, customThemes: customs }
  } catch {
    return defaultThemePreferences()
  }
}

export function getColorTheme(preferences: ThemePreferences, id = preferences.selectedId): ColorTheme {
  return PRESET_THEMES.find(theme => theme.id === id)
    ?? preferences.customThemes.find(theme => theme.id === id)
    ?? PRESET_THEMES[0]
}

export function parseThemeFile(raw: string): ColorTheme {
  if (raw.length > MAX_THEME_FILE_SIZE) throw new Error('Theme file is too large (maximum 16 KB).')
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Theme file must contain valid JSON.') }
  const value = record(parsed, 'Theme file')
  allowKeys(value, ['version', 'name', 'baseId', 'light', 'dark'], 'Theme file')
  if (value.version !== 1) throw new Error('Unsupported theme file version. Expected version 1.')
  const base = readBase(value.baseId)
  const name = readName(value.name)
  const light = readColors(value.light, base.light, 'Light colors')
  const dark = readColors(value.dark, base.dark, 'Dark colors')
  return { id: `custom-${crypto.randomUUID()}`, name, baseId: base.id, light, dark }
}

export function serializeThemeFile(theme: ColorTheme): string {
  // Pick explicit fields, never serialize a whole application object.
  const base = readBase(theme.baseId)
  return JSON.stringify({
    version: 1,
    name: readName(theme.name),
    baseId: base.id,
    light: readColors(theme.light, base.light, 'Light colors'),
    dark: readColors(theme.dark, base.dark, 'Dark colors'),
  }, null, 2)
}

function rgb(color: string): number[] {
  return [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16))
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map(channel => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(first: string, second: string): number {
  const a = luminance(first), b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function mix(first: string, second: string, amount: number): string {
  const a = rgb(first), b = rgb(second)
  return '#' + a.map((channel, i) => Math.round(channel * (1 - amount) + b[i] * amount)
    .toString(16).padStart(2, '0')).join('')
}

function readable(background: string, preferred?: string): string {
  if (preferred && contrast(background, preferred) >= 4.5) return preferred
  return contrast(background, '#ffffff') >= contrast(background, '#000000') ? '#ffffff' : '#000000'
}

export function themeVariables(colors: ThemeColors): Record<string, string> {
  const c = readColors(colors, PRESET_THEMES[0].light, 'Colors')
  const muted = mix(c.surface, c.foreground, 0.07)
  const accent = mix(c.surface, c.accent, 0.12)
  const sidebarAccent = mix(c.sidebar, c.accent, 0.16)
  const border = mix(c.background, c.foreground, 0.2)
  const destructive = luminance(c.background) < 0.3 ? '#fb7185' : '#dc2626'
  return {
    '--background': c.background,
    '--foreground': c.foreground,
    '--card': c.surface,
    '--card-foreground': c.foreground,
    '--popover': c.surface,
    '--popover-foreground': c.foreground,
    '--primary': c.accent,
    '--primary-foreground': readable(c.accent),
    '--secondary': muted,
    '--secondary-foreground': readable(muted, c.foreground),
    '--muted': muted,
    '--muted-foreground': c.mutedText,
    '--accent': accent,
    '--accent-foreground': readable(accent, c.accent),
    '--destructive': destructive,
    '--destructive-foreground': readable(destructive),
    '--border': border,
    '--input': mix(c.background, c.foreground, 0.26),
    '--ring': c.accent,
    '--chart-1': c.accent,
    '--chart-2': mix(c.accent, c.foreground, 0.25),
    '--chart-3': mix(c.accent, c.foreground, 0.5),
    '--chart-4': mix(c.accent, c.background, 0.25),
    '--chart-5': mix(c.accent, c.background, 0.5),
    '--sidebar': c.sidebar,
    '--sidebar-foreground': c.foreground,
    '--sidebar-primary': c.accent,
    '--sidebar-primary-foreground': readable(c.accent),
    '--sidebar-accent': sidebarAccent,
    '--sidebar-accent-foreground': readable(sidebarAccent, c.accent),
    '--sidebar-border': mix(c.sidebar, c.foreground, 0.2),
    '--sidebar-ring': c.accent,
    '--message-incoming': c.incoming,
    '--message-incoming-foreground': c.incomingText,
    '--message-outgoing': c.outgoing,
    '--message-outgoing-foreground': c.outgoingText,
    '--theme-chrome': c.background,
  }
}

export function getContrastWarnings(colors: ThemeColors): Array<{ label: string; ratio: number }> {
  const c = readColors(colors, PRESET_THEMES[0].light, 'Colors')
  const pairs: [string, string, string][] = [
    ['Main text', c.foreground, c.background],
    ['Surface text', c.foreground, c.surface],
    ['Sidebar text', c.foreground, c.sidebar],
    ['Muted text on the background', c.mutedText, c.background],
    ['Muted text on surfaces', c.mutedText, c.surface],
    ['Muted text in the sidebar', c.mutedText, c.sidebar],
    ['Incoming message text', c.incomingText, c.incoming],
    ['Outgoing message text', c.outgoingText, c.outgoing],
    ['Accent links on the background', c.accent, c.background],
    ['Accent links on surfaces', c.accent, c.surface],
    ['Accent links in incoming messages', c.accent, c.incoming],
    ['Accent links in outgoing messages', c.accent, c.outgoing],
  ]
  return pairs.map(([label, first, second]) => ({ label, ratio: contrast(first, second) }))
    .filter(warning => warning.ratio < 4.5)
}
