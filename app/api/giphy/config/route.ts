import { getCloudflareContext } from "@opennextjs/cloudflare"

export const dynamic = "force-dynamic"

/** Public app configuration only; never serialize the Worker environment. */
export async function GET(): Promise<Response> {
  let apiKey = process.env.NEXT_PUBLIC_GIPHY_API_KEY?.trim() || null
  try {
    const { env } = await getCloudflareContext({ async: true })
    const value = (env as { NEXT_PUBLIC_GIPHY_API_KEY?: unknown }).NEXT_PUBLIC_GIPHY_API_KEY
    if (typeof value === "string" && value.trim()) apiKey = value.trim()
  } catch {
    if (!apiKey) return Response.json({ apiKey: null }, { status: 503, headers: { "Cache-Control": "no-store, max-age=0" } })
  }
  if (apiKey && apiKey.length > 512) apiKey = null
  return Response.json({ apiKey }, { headers: { "Cache-Control": "no-store, max-age=0" } })
}
