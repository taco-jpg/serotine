"use client"

import { useEffect, useRef, useState } from "react"
import type { ProfileMedia } from "@/lib/profile-media"
import type { ProfileValues } from "@/lib/profiles"
import { shortAddress } from "@/lib/identity"

export function ProfileImage({ media, alt, className = "" }: { media: ProfileMedia; alt: string; className?: string }) {
  const node = useRef<HTMLImageElement>(null)
  const [visible, setVisible] = useState(false)
  const [animate, setAnimate] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
    const preference = matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => { let enabled; try { enabled = localStorage.getItem("serotine.profile-animation") !== "off" } catch { enabled = false }; setAnimate(enabled && !preference.matches && document.visibilityState === "visible") }
    update(); preference.addEventListener("change", update); window.addEventListener("serotine:profile-animation", update); window.addEventListener("storage", update); document.addEventListener("visibilitychange", update)
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
    if (node.current) observer.observe(node.current)
    return () => { observer.disconnect(); preference.removeEventListener("change", update); window.removeEventListener("serotine:profile-animation", update); window.removeEventListener("storage", update); document.removeEventListener("visibilitychange", update) }
  }, [media])
  if (failed) return <span aria-label={`${alt} unavailable`} className={`block bg-muted ${className}`} />
  const useFullImage = !media.animated || (visible && animate)
  // Profile bytes only: no user-supplied URL is ever requested by a viewer.
  return <img ref={node} alt={alt} loading="lazy" decoding="async" src={`data:${useFullImage ? media.mime : "image/png"};base64,${useFullImage ? media.data : media.still}`} onError={() => setFailed(true)} className={`object-cover ${className}`} style={{ objectPosition: `center ${media.position ?? 50}%` }} />
}

export function FallbackProfileIcon({ pubKey, size = 32 }: { pubKey: string; size?: number }) {
  const hash = [...pubKey].reduce((sum, letter) => sum + letter.charCodeAt(0), 0), hue = hash % 360
  return <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border p-1" style={{ width: size, height: size, background: `linear-gradient(135deg,hsl(${hue},65%,50%),hsl(${(hue + 40) % 360},65%,35%))` }}><span className="size-full rounded-full bg-black/20" /></span>
}

export function ProfileCard({ values, pubKey, fallbackName }: { values: ProfileValues; pubKey: string; fallbackName?: string }) {
  const background = values.colors?.background
  const light = background ? [1, 3, 5].reduce((sum, index, channel) => sum + parseInt(background.slice(index, index + 2), 16) * [0.299, 0.587, 0.114][channel], 0) > 150 : undefined
  return <article aria-label="Profile card" className="overflow-hidden rounded-xl border border-border bg-card" style={background ? { backgroundColor: background, color: light ? "#111111" : "#ffffff" } : undefined}>
    {values.banner ? <ProfileImage media={values.banner} alt="Profile banner" className="aspect-[3/1] w-full" /> : <div className="h-14 bg-muted/40" />}
    <div className="space-y-3 p-4"><div className="flex items-center gap-3">{values.avatar ? <ProfileImage media={values.avatar} alt="Profile picture" className="size-16 shrink-0 rounded-full" /> : <FallbackProfileIcon pubKey={pubKey} size={64} />}<div className="min-w-0"><h3 className="break-words text-lg font-semibold">{values.displayName || fallbackName || shortAddress(pubKey)}</h3><p className="break-all text-xs opacity-75">{shortAddress(pubKey)}</p></div></div>{values.colors && <div className="h-1 rounded-full" style={{ backgroundColor: values.colors.accent }} />}{values.status && <p className="break-words text-sm">{values.status}</p>}{values.bio && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{values.bio}</p>}<p className="text-xs opacity-70">Pictures and profile names do not verify identity.</p></div>
  </article>
}
