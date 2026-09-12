"use client"

import { useEffect, useRef, useState } from "react"
import { Loader2, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { fetchGiphyPage, giphyPageUrl, hasGiphyApiKey, type GiphyGif } from "@/lib/giphy"
import { GiphyAttribution } from "./giphy-attribution"

export function GifPicker({ disabled = false, onSelectGif }: { disabled?: boolean; onSelectGif: (url: string) => void }) {
  const [open, setOpen] = useState(false)
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label="Search GIFs" title="Search GIFs" className="font-bold">GIF</Button></DialogTrigger>
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>Find a GIF</DialogTitle>
        <DialogDescription>Choose a GIF to add to your message, then press Send.</DialogDescription>
      </DialogHeader>
      {/* Closing unmounts search results and aborts in-flight requests. */}
      {open && <GifSearch disabled={disabled} onSelect={url => { if (!disabled) { onSelectGif(url); setOpen(false) } }} />}
    </DialogContent>
  </Dialog>
}

function GifSearch({ disabled, onSelect }: { disabled: boolean; onSelect: (url: string) => void }) {
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState<{ query: string; offset: number; attempt: number } | null>(null)
  const [gifs, setGifs] = useState<GiphyGif[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const requestId = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const configured = hasGiphyApiKey()

  useEffect(() => {
    if (!search || !configured) return
    const controller = new AbortController()
    controllerRef.current = controller
    const attempt = ++requestId.current
    setBusy(true)
    setError("")
    void fetchGiphyPage({ query: search.query, offset: search.offset, signal: controller.signal }).then(page => {
      if (controller.signal.aborted || requestId.current !== attempt) return
      setGifs(previous => search.offset ? [...previous, ...page.gifs] : page.gifs)
      setNextOffset(page.nextOffset)
    }).catch(cause => {
      if (!controller.signal.aborted && requestId.current === attempt) setError(cause instanceof Error ? cause.message : "Unable to load GIFs. Please try again.")
    }).finally(() => {
      if (!controller.signal.aborted && requestId.current === attempt) setBusy(false)
    })
    return () => { controller.abort(); if (controllerRef.current === controller) controllerRef.current = null }
  }, [search, configured])

  function startSearch(value: string) {
    if (!configured || disabled) return
    controllerRef.current?.abort()
    requestId.current++
    setGifs([])
    setNextOffset(null)
    setError("")
    setBusy(true)
    setSearch(previous => ({ query: value, offset: 0, attempt: (previous?.attempt || 0) + 1 }))
  }

  return <div className="min-w-0 space-y-3">
    <p className="text-xs text-muted-foreground">GIPHY can see your searches and the GIFs you load. Your conversations are not sent to GIPHY.</p>
    {configured ? <>
      <form className="flex gap-2" onSubmit={event => { event.preventDefault(); startSearch(query) }}>
        <Input value={query} onChange={event => setQuery(event.target.value)} maxLength={50} placeholder="Search GIPHY" aria-label="Search GIPHY" disabled={disabled} className="min-w-0" />
        <Button type="submit" disabled={disabled} aria-label="Search"><Search aria-hidden="true" /></Button>
      </form>
      {!search && <div className="rounded-lg border border-dashed p-5 text-center">
        <p className="mb-3 text-sm text-muted-foreground">Search for a reaction, or browse trending GIFs.</p>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => { setQuery(""); startSearch("") }}>Browse trending</Button>
      </div>}
      <div aria-busy={busy} className="max-h-[min(45dvh,24rem)] min-w-0 overflow-y-auto overscroll-contain">
        {gifs.length > 0 && <div className="grid grid-cols-2 items-start gap-2 sm:grid-cols-3">{gifs.map((gif, index) => <button key={`${gif.id}-${index}`} type="button" disabled={disabled || busy} className="group overflow-hidden rounded-lg border bg-muted/30 text-left focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50" aria-label={`Choose ${gif.title}`} onClick={() => onSelect(giphyPageUrl(gif.id))}>
          <img src={gif.previewUrl} alt={gif.alt} referrerPolicy="no-referrer" loading="lazy" decoding="async" className="h-32 w-full object-contain transition-opacity group-hover:opacity-80" />
          {gif.creator && <span className="block truncate px-2 py-1 text-xs text-muted-foreground">@{gif.creator}</span>}
        </button>)}</div>}
        {busy && <p role="status" className="flex items-center justify-center gap-2 p-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden="true" />Loading GIFs…</p>}
        {search && !busy && !error && !gifs.length && <p role="status" className="p-5 text-center text-sm text-muted-foreground">No GIFs found. Try another search.</p>}
      </div>
      {error && <div role="alert" className="space-y-2 text-sm"><p className="text-destructive">{error}</p><Button type="button" size="sm" variant="outline" disabled={disabled || busy} onClick={() => setSearch(previous => previous && { ...previous, attempt: previous.attempt + 1 })}>Try again</Button></div>}
      {nextOffset !== null && !error && <Button type="button" variant="outline" size="sm" disabled={busy || disabled} onClick={() => setSearch(previous => previous && { ...previous, offset: nextOffset, attempt: previous.attempt + 1 })}>Load more</Button>}
    </> : <div className="space-y-2 rounded-lg border p-4 text-sm">
      <p>GIF search hasn’t been enabled on this site yet. You can still upload GIFs or reuse them from your File bank.</p>
      <p className="text-xs text-muted-foreground">The site owner can enable GIPHY in the setup instructions in the project README.</p>
    </div>}
    <a href="https://giphy.com" target="_blank" rel="noopener noreferrer" className="inline-block"><GiphyAttribution /></a>
  </div>
}
