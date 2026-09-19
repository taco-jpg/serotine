"use client"

import type { SharedMessages } from "@/lib/shared-messages"

/** Plain text only: quoted links and file metadata never initiate a fetch. */
export function SharedMessageBundle({ bundle }: { bundle: SharedMessages }) {
  return <details className="min-w-0 max-w-full rounded-md border border-current/20 p-3">
    <summary className="cursor-pointer text-sm font-medium">Shared {bundle.items.length} message{bundle.items.length === 1 ? "" : "s"}</summary>
    <p className="mt-2 text-xs opacity-80">A shared copy. Quoted authorship is not verified. The original conversation is not accessible.</p>
    <ol className="mt-3 space-y-3">{bundle.items.map((item, index) => <li key={index} className="min-w-0 border-t border-current/15 pt-2">
      <p className="break-all text-xs opacity-80">{item.sender} · <time dateTime={new Date(item.timestamp).toISOString()}>{new Date(item.timestamp).toLocaleString()}</time></p>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm">{item.text}</p>
      {item.attachment && <p className="mt-2 break-words text-xs opacity-80">File: {item.attachment.name} · {item.attachment.size.toLocaleString()} bytes. Metadata only; file not included.</p>}
    </li>)}</ol>
  </details>
}
