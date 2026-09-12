// GIPHY requires direct client requests and forbids storing media URLs/assets.
// Persist only the public GIF page URL in a message, then resolve its ID on demand.
// https://developers.giphy.com/docs/api/#best-practices
const GIPHY_API = "https://api.giphy.com/v1/gifs"
const GIF_ID = /^[a-zA-Z0-9]{1,64}$/
export const GIPHY_PAGE_SIZE = 24

export type GiphyGif = {
  id: string
  title: string
  alt: string
  previewUrl: string
  imageUrl: string
  width: number
  height: number
  creator: string
}

export type GiphyPage = { gifs: GiphyGif[]; nextOffset: number | null }

export function hasGiphyApiKey(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_GIPHY_API_KEY?.trim())
}

export function giphyPageUrl(id: string): string {
  if (!GIF_ID.test(id)) throw new Error("Invalid GIF ID.")
  return `https://giphy.com/gifs/${id}`
}

/** Recognize a whole message, never an arbitrary embedded or lookalike URL. */
export function parseGiphyUrl(text: string): string | null {
  const value = text.trim()
  if (!/^https:\/\/(?:www\.)?giphy\.com\//i.test(value) || /\s/.test(value)) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || !["giphy.com", "www.giphy.com"].includes(url.hostname) || url.port || url.username || url.password) return null
    const path = url.pathname.match(/^\/(?:gifs|embed)\/([a-zA-Z0-9-]+)\/?$/)
    if (!path) return null
    const id = path[1].split("-").at(-1) || ""
    return GIF_ID.test(id) ? id : null
  } catch { return null }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function safeMediaUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 4096) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || !/^(?:media\d*|i)\.giphy\.com$/.test(url.hostname) || url.username || url.password || url.port) return null
    return value // Preserve every provider query parameter exactly as supplied.
  } catch { return null }
}

function rendition(value: unknown) {
  const data = object(value)
  const url = safeMediaUrl(data?.url)
  const width = Number(data?.width), height = Number(data?.height)
  if (!url || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width > 16384 || height > 16384) return null
  return { url, width, height }
}

function parseGif(value: unknown): GiphyGif {
  const gif = object(value)
  // Fail closed even if an upstream response ignores our explicit rating.
  if (!gif || typeof gif.id !== "string" || !GIF_ID.test(gif.id) || gif.rating !== "g") throw new Error("This GIF is unavailable with the current content filter.")
  const images = object(gif.images)
  const preview = rendition(images?.fixed_height) || rendition(images?.fixed_width) || rendition(images?.downsized)
  const full = rendition(images?.downsized) || rendition(images?.original) || preview
  if (!preview || !full) throw new Error("GIPHY returned an unavailable image. Please try again.")
  return {
    id: gif.id,
    title: typeof gif.title === "string" ? gif.title.slice(0, 200) : "GIF",
    alt: typeof gif.alt_text === "string" && gif.alt_text ? gif.alt_text.slice(0, 1000) : typeof gif.title === "string" ? gif.title.slice(0, 200) : "GIF from GIPHY",
    previewUrl: preview.url,
    imageUrl: full.url,
    width: full.width,
    height: full.height,
    creator: typeof gif.username === "string" ? gif.username.slice(0, 100) : "",
  }
}

async function request(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const key = process.env.NEXT_PUBLIC_GIPHY_API_KEY?.trim()
  if (!key) throw new Error("GIF search has not been enabled on this site yet.")
  const url = new URL(`${GIPHY_API}${path}`)
  url.search = new URLSearchParams({ api_key: key, ...params, rating: "g" }).toString()
  const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error" })
  if (response.status === 429) throw new Error("GIPHY’s search limit has been reached. Please try again later.")
  if (response.status === 401 || response.status === 403) throw new Error("GIF search is not available with this site’s current GIPHY key.")
  if (!response.ok) throw new Error("GIPHY is unavailable right now. Please try again.")
  const body = object(await response.json())
  const meta = object(body?.meta)
  if (!body || (meta?.status !== undefined && meta.status !== 200)) throw new Error("GIPHY is unavailable right now. Please try again.")
  return body
}

export async function fetchGiphyPage({ query = "", offset = 0, signal }: { query?: string; offset?: number; signal?: AbortSignal }): Promise<GiphyPage> {
  const searching = query.trim().length > 0
  const maxOffset = searching ? 4999 : 499
  if (query.length > 50) throw new Error("Search using 50 characters or fewer.")
  if (!Number.isInteger(offset) || offset < 0 || offset > maxOffset) throw new Error("No more GIFs are available.")
  const body = await request(searching ? "/search" : "/trending", { ...(searching ? { q: query } : {}), limit: String(GIPHY_PAGE_SIZE), offset: String(offset) }, signal)
  if (!Array.isArray(body.data)) throw new Error("GIPHY returned an invalid response. Please try again.")
  // Preserve provider order and fail the response rather than mixing/filtering it.
  const gifs = body.data.map(parseGif)
  const pagination = object(body.pagination)
  const total = Number(pagination?.total_count)
  const next = offset + body.data.length
  const more = body.data.length > 0 && next <= maxOffset && (Number.isFinite(total) ? next < total : body.data.length === GIPHY_PAGE_SIZE)
  return { gifs, nextOffset: more ? next : null }
}

export async function fetchGiphyGif(id: string, signal?: AbortSignal): Promise<GiphyGif> {
  if (!GIF_ID.test(id)) throw new Error("Invalid GIF ID.")
  const body = await request(`/${id}`, {}, signal)
  const gif = parseGif(body.data)
  if (gif.id !== id) throw new Error("GIPHY returned a different GIF. Please try again.")
  return gif
}
