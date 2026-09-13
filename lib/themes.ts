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
  // A shared ink-and-paper foundation, with one considered accent per palette.
  // Keep the default colors and derived tokens in sync with globals.css.
  preset('default', 'Default',
    ['#eeefe7', '#171b14', '#f6f7ef', '#e5e8dd', '#3c5f22', '#5d6655', '#f3f4ec', '#171b14', '#dce8ce', '#233019'],
    ['#0b0e0b', '#eeefe7', '#131812', '#0f130e', '#ccff89', '#a1aa99', '#171d14', '#eeefe7', '#24301c', '#eff5e7']),
  preset('forest', 'Forest',
    ['#eaefe7', '#17251c', '#f3f6ee', '#e0e7dc', '#285c3b', '#56665a', '#f0f4eb', '#17251c', '#d7e5d6', '#1d3525'],
    ['#0b100d', '#e8eee5', '#121b15', '#0e1510', '#a6deb3', '#9eafa2', '#18221a', '#e8eee5', '#243629', '#e8f3e8']),
  preset('ocean', 'Ocean',
    ['#e9efed', '#18272b', '#f2f6f2', '#dfe7e4', '#245c6b', '#57676b', '#eef4f0', '#18272b', '#d5e6e5', '#20383d'],
    ['#0b1012', '#e6eeeb', '#121b1e', '#0d1518', '#9ddde9', '#9bafb2', '#172327', '#e6eeeb', '#22363c', '#e6f2f1']),
  preset('lavender', 'Lavender',
    ['#eeecef', '#28222f', '#f6f3f5', '#e5e1e8', '#614578', '#68606f', '#f2eef3', '#28222f', '#e3daeb', '#352a42'],
    ['#100e13', '#eee9ee', '#1a161f', '#151118', '#ceb7f4', '#ada2b6', '#221c29', '#eee9ee', '#32283e', '#f0e9f7']),
  preset('rose', 'Rose',
    ['#f0ece8', '#302225', '#f7f3ed', '#e9e1dc', '#824553', '#756064', '#f4efe9', '#302225', '#ebdcd9', '#432b31'],
    ['#130e10', '#f0e9e5', '#201719', '#181214', '#eeb6c5', '#b9a4a7', '#281e21', '#f0e9e5', '#3d2b30', '#f7ebec']),
  preset('monochrome', 'Monochrome',
    ['#eeeee8', '#22231f', '#f6f6f0', '#e3e4dc', '#494c41', '#616458', '#f2f3ec', '#22231f', '#dee0d6', '#2b2e25'],
    ['#0e0f0d', '#eeefe7', '#181a16', '#121410', '#e5e7dc', '#a5aa9b', '#1f221c', '#eeefe7', '#30352a', '#f2f3eb']),
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
      throw new Error(`${label}.${key} must be a six-digit hex color, such as #ccff89.`)
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
  const border = mix(c.background, c.foreground, 0.14)
  const destructive = luminance(c.background) < 0.3 ? '#fb7185' : '#b91c1c'
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
    '--input': mix(c.background, c.foreground, 0.2),
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
    '--sidebar-border': mix(c.sidebar, c.foreground, 0.14),
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
