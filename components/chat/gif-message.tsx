"use client"

import { useEffect, useState } from "react"
import { ExternalLink, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { fetchGiphyGif, giphyPageUrl, hasGiphyApiKey, type GiphyGif } from "@/lib/giphy"
import { GiphyAttribution } from "./giphy-attribution"

export function GifMessage({ id }: { id: string }) {
  // The key prevents a previous GIF's consent or media leaking into a new message.
  return <GiphyCard key={id} id={id} />
}

function GiphyCard({ id }: { id: string }) {
  const [load, setLoad] = useState(false)
  const [gif, setGif] = useState<GiphyGif | null>(null)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const configured = hasGiphyApiKey()

  useEffect(() => {
    if (!load || !configured) return
    const controller = new AbortController()
    setGif(null)
    setError("")
    void fetchGiphyGif(id, controller.signal).then(result => {
      if (!controller.signal.aborted) setGif(result)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load this GIF.")
    })
    return () => controller.abort()
  }, [id, load, configured, attempt])

  return <div className="w-96 max-w-full space-y-2 overflow-hidden rounded-lg border bg-muted/20 p-2">
    {load && gif && !error ? <>
      <img src={gif.imageUrl} alt={gif.alt} width={gif.width} height={gif.height} referrerPolicy="no-referrer" decoding="async" onError={() => setError("This GIF could not be displayed. Try again or open it on GIPHY.")} className="max-h-80 w-full rounded-md object-contain" />
      {gif.creator && <p className="truncate text-xs text-muted-foreground">@{gif.creator}</p>}
    </> : <div className="space-y-2 p-2">
      <p className="text-sm font-medium">GIF from GIPHY</p>
      <p className="text-xs text-muted-foreground">Loading this GIF connects to GIPHY, which can see your IP address and the GIF you view.</p>
      {configured ? !load ? <Button type="button" variant="outline" size="sm" onClick={() => setLoad(true)}>Load GIF</Button> : !error && <p role="status" className="flex items-center gap-2 text-xs"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading GIF…</p> : <p className="text-xs text-muted-foreground">Inline GIF viewing hasn’t been enabled on this site yet.</p>}
      {error && <div role="alert" className="space-y-2"><p className="text-xs text-destructive">{error}</p><Button type="button" size="sm" variant="outline" onClick={() => { setGif(null); setError(""); setAttempt(value => value + 1) }}>Try again</Button></div>}
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs text-muted-foreground">
      <a href={giphyPageUrl(id)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1"><GiphyAttribution /><ExternalLink className="size-3" aria-hidden="true" /><span className="sr-only">Open GIF on GIPHY</span></a>
      {load && <button type="button" className="hover:underline" onClick={() => { setLoad(false); setGif(null); setError("") }}>Hide GIF</button>}
    </div>
  </div>
}
