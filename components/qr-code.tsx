"use client"

import { useEffect, useState } from "react"
import { Download, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

/** The PNG encodes value verbatim; generation never contacts a QR service. */
export function QrCodeCard({ value, title = "Contact QR code" }: { value: string; title?: string }) {
  const [result, setResult] = useState<{ value: string; url: string } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    void import("qrcode").then(qr => qr.toDataURL(value, {
      errorCorrectionLevel: "M", margin: 4, width: 600,
      color: { dark: "#000000ff", light: "#ffffffff" },
    })).then(url => { if (active) { setResult({ value, url }); setFailure(null) } })
      .catch(() => { if (active) setFailure(value) })
    return () => { active = false }
  }, [value])
  const url = result?.value === value ? result.url : null
  return <div className="flex min-w-0 flex-col items-center gap-2">
    {url ? <img src={url} alt={title} width={240} height={240} className="aspect-square w-full max-w-60 rounded-lg border border-border bg-white" />
      : failure === value ? <p role="alert" className="text-sm text-destructive">The QR code could not be created. You can still copy the address.</p>
        : <div role="status" className="flex h-40 items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Creating QR code…</div>}
    <p className="text-center text-xs text-muted-foreground">This QR code contains the full public address. Scan it in Serotine to add the contact.</p>
    {url && <Button asChild type="button" variant="outline" size="sm"><a href={url} download="serotine-contact-qr.png"><Download className="size-4" />Save QR image</a></Button>}
  </div>
}
