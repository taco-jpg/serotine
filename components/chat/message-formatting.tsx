"use client"

import { useDeferredValue, useEffect, useId, useRef, useState, type RefObject } from "react"
import { Code2, Sigma } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { RichMessage } from "@/components/chat/rich-message"
import { insertFormattedContent, type FormattedInsertion } from "@/lib/composer-formatting"
import { hasRichFormatting, serializeCode, serializeMath } from "@/lib/message-format"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"

type EditorSession = { kind: "math" | "code"; before: string; start: number; end: number }

/** The same editor serves direct chats, groups, communities, and message edits. */
export function MessageFormattingTools({ content, inputRef, disabled = false, onInsert }: {
  content: string
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled?: boolean
  onInsert: (result: FormattedInsertion) => void
}) {
  const [session, setSession] = useState<EditorSession | null>(null)
  const [source, setSource] = useState("")
  const [language, setLanguage] = useState("")
  const [display, setDisplay] = useState(true)
  const sourceInput = useRef<HTMLTextAreaElement>(null)
  const restoreCaret = useRef<number | null>(null)
  const sourceId = useId(), languageId = useId(), displayId = useId()
  useEffect(() => { if (disabled) setSession(null) }, [disabled])
  let formatted = "", issue = ""
  if (session && source.trim()) {
    try {
      if (session.kind === "math" && source.length > (display ? 2000 : 1000)) throw new Error(`Use ${display ? "2,000" : "1,000"} characters or fewer for this formula.`)
      if (session.kind === "code" && language.trim() && !/^[\w#+.-]{1,30}$/.test(language.trim())) throw new Error("Use a language name such as javascript, python, or c++.")
      formatted = session.kind === "math" ? serializeMath(source, display) : serializeCode(source, language)
      insertFormattedContent(content, session, formatted, session.kind === "code" || display, MAX_MESSAGE_LENGTH)
    } catch (cause) { issue = cause instanceof Error ? cause.message : "This selection could not be inserted." }
  }
  if (session && session.before !== content) issue = "Your message changed while this editor was open. Close it and reopen Math or Code to keep the latest draft."
  const preview = useDeferredValue(formatted)

  function open(kind: EditorSession["kind"]) {
    if (disabled) return
    const node = inputRef.current
    const start = node?.selectionStart ?? content.length, end = node?.selectionEnd ?? start
    setSource(content.slice(start, end)); setLanguage(""); setDisplay(true)
    restoreCaret.current = null
    setSession({ kind, before: content, start, end })
  }
  function insert() {
    if (!session || disabled || issue || !formatted) return
    const result = insertFormattedContent(content, session, formatted, session.kind === "code" || display, MAX_MESSAGE_LENGTH)
    onInsert(result)
    restoreCaret.current = result.caret
    setSession(null)
  }

  return <>
    <Button type="button" variant="ghost" size="sm" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => open("math")}><Sigma className="size-4" />Math</Button>
    <Button type="button" variant="ghost" size="sm" disabled={disabled} onPointerDown={event => event.preventDefault()} onClick={() => open("code")}><Code2 className="size-4" />Code</Button>
    <Dialog open={!!session && !disabled} onOpenChange={value => { if (!value) setSession(null) }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" onOpenAutoFocus={event => { event.preventDefault(); sourceInput.current?.focus() }} onCloseAutoFocus={event => {
        event.preventDefault()
        const node = inputRef.current
        if (!node?.isConnected || node.disabled) return
        node.focus()
        if (restoreCaret.current !== null) node.setSelectionRange(restoreCaret.current, restoreCaret.current)
      }}>
        <DialogHeader><DialogTitle>{session?.kind === "math" ? "Add math" : "Add code"}</DialogTitle><DialogDescription>{session?.kind === "math" ? "Type a LaTeX formula and check the preview as you type." : "Paste or type code and check exactly how it will appear."}</DialogDescription></DialogHeader>
        <div className="min-w-0 space-y-3" onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); insert() }
        }}>
          {session?.kind === "math" ? <div className="flex flex-wrap items-center gap-2"><Label htmlFor={displayId}>Layout</Label><select id={displayId} value={display ? "block" : "inline"} onChange={event => setDisplay(event.target.value === "block")} className="h-9 rounded-md border border-input bg-background px-2 text-sm"><option value="block">On its own line</option><option value="inline">In text</option></select></div> : <div className="space-y-1"><Label htmlFor={languageId}>Language (optional)</Label><Input id={languageId} value={language} maxLength={30} placeholder="e.g. javascript or python" onChange={event => setLanguage(event.target.value)} /></div>}
          <div className="space-y-1"><Label htmlFor={sourceId}>{session?.kind === "math" ? "LaTeX formula" : "Code"}</Label><Textarea id={sourceId} ref={sourceInput} value={source} rows={5} maxLength={session?.kind === "math" ? 2000 : MAX_MESSAGE_LENGTH} autoComplete="off" autoCorrect="off" spellCheck={false} className="max-h-64 resize-y font-mono text-base md:text-sm" placeholder={session?.kind === "math" ? "\\frac{x^2}{2}" : "Paste your code here"} onChange={event => setSource(event.target.value)} /></div>
          <div role="region" aria-label="Formatting preview" className="min-w-0 rounded-md border border-border bg-muted/30 p-3"><p className="mb-2 text-xs font-medium text-muted-foreground">Live preview</p><div className="max-h-60 overflow-auto">{preview ? <RichMessage preview text={preview} /> : <p className="text-sm text-muted-foreground">{session?.kind === "math" ? "Your formula will appear here." : "Your code will appear here."}</p>}</div></div>
          {issue && <p role="alert" className="text-sm text-destructive">{issue}</p>}
        </div>
        <DialogFooter><Button type="button" variant="outline" onClick={() => setSession(null)}>Cancel</Button><Button type="button" disabled={disabled || !!issue || !formatted} onClick={insert}>Insert {session?.kind === "math" ? "math" : "code"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

export function MessageFormattingPreview({ content }: { content: string }) {
  const deferred = useDeferredValue(content)
  if (!hasRichFormatting(content)) return null
  return <div role="region" aria-label="Message preview" className="mt-2 min-w-0 rounded-md border border-border bg-muted/20 px-3 py-2"><p className="mb-1 text-[11px] font-medium text-muted-foreground">Live preview</p><div className="max-h-40 overflow-auto text-sm"><RichMessage preview text={deferred} /></div></div>
}
