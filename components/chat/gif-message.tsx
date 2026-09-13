"use client"

import { useEffect, useRef, useState } from "react"
import { ExternalLink, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { fetchGiphyGif, giphyPageUrl, type GiphyGif } from "@/lib/giphy"
import { GiphyAttribution } from "./giphy-attribution"

export function GifMessage({ id }: { id: string }) {
  // A different reference starts with fresh visibility, media, and retry state.
  return <GiphyCard key={id} id={id} />
}

function GiphyCard({ id }: { id: string }) {
  const card = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [hidden, setHidden] = useState(false)
  const [gif, setGif] = useState<GiphyGif | null>(null)
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const load = nearViewport && !hidden

  useEffect(() => {
    if (!card.current) return
    // Resolve only GIFs approaching the viewport, not an entire chat history.
    if (typeof IntersectionObserver === "undefined") {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setNearViewport(true)
        observer.disconnect()
      }
    }, { rootMargin: "200px" })
    observer.observe(card.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!load) return
    const controller = new AbortController()
    setGif(null)
    setError("")
    void fetchGiphyGif(id, controller.signal).then(result => {
      if (!controller.signal.aborted) setGif(result)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to load this GIF.")
    })
    return () => controller.abort()
  }, [id, load, attempt])

  return <div ref={card} className="w-96 max-w-full overflow-hidden rounded-lg">
    {load && gif && !error ? <>
      <img src={gif.imageUrl} alt={gif.alt} width={gif.width} height={gif.height} referrerPolicy="no-referrer" decoding="async" onError={() => setError("This GIF could not be displayed. Try again or open it on GIPHY.")} className="max-h-[min(16rem,35dvh)] w-full rounded-md object-contain" />
    </> : <div className="space-y-2 p-2">
      <p className="text-sm font-medium">GIF from GIPHY</p>
      {hidden ? <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => setHidden(false)}>Show GIF</Button> : !error && <p role="status" className="flex items-center gap-2 text-xs">{load ? <><Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading GIF…</> : "GIF loads automatically when in view."}</p>}
      {error && <div role="alert" className="space-y-2"><p className="text-xs text-destructive">{error}</p><Button type="button" size="sm" variant="outline" className="min-h-11" onClick={() => { setGif(null); setError(""); setAttempt(value => value + 1) }}>Try again</Button></div>}
    </div>}
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <a href={giphyPageUrl(id)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md focus-visible:outline-2"><GiphyAttribution /><ExternalLink className="size-3" aria-hidden="true" /><span className="sr-only">Open GIF on GIPHY</span></a>
      {load && gif && !error && gif.creator && <p title={`@${gif.creator}`} className="min-w-0 flex-1 truncate">@{gif.creator}</p>}
      {load && <button type="button" className="ml-auto min-h-11 min-w-11 shrink-0 rounded-md hover:underline focus-visible:outline-2" onClick={() => { setHidden(true); setGif(null); setError("") }}>Hide GIF</button>}
    </div>
  </div>
}
