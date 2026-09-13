"use client"

import { useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useLocalNickname } from "@/hooks/use-local-nickname"
import { MAX_LOCAL_NICKNAME_LENGTH, normalizeLocalNickname, saveLocalNickname } from "@/lib/local-nickname"

export function LocalNicknameSetting({ owner }: { owner: string }) {
  return <NicknameEditor key={owner} owner={owner} />
}

function NicknameEditor({ owner }: { owner: string }) {
  const id = useId()
  const nickname = useLocalNickname(owner)
  const [draft, setDraft] = useState<{ base: string; value: string } | null>(null)
  const [status, setStatus] = useState<{ message: string; error: boolean } | null>(null)
  // A new identity remounts the editor; changes from another tab replace a stale draft.
  const value = draft?.base === nickname ? draft.value : nickname

  function save(valueToSave: string) {
    try {
      const saved = saveLocalNickname(owner, valueToSave)
      setDraft(null)
      setStatus({ message: saved ? "Private nickname saved." : "Private nickname reset to You.", error: false })
    } catch (cause) {
      setStatus({ message: cause instanceof Error ? cause.message : "Could not save your private nickname.", error: true })
    }
  }

  return <section className="space-y-2">
    <label htmlFor={id} className="text-sm font-medium">Private nickname</label>
    <p id={`${id}-description`} className="text-sm text-muted-foreground">Only you see this; saved in this browser and never sent to other people.</p>
    <form className="space-y-2" onSubmit={event => { event.preventDefault(); save(value) }}>
      <Input id={id} value={value} placeholder="You" maxLength={MAX_LOCAL_NICKNAME_LENGTH} autoComplete="off" spellCheck={false} disabled={!owner} aria-describedby={`${id}-description`} onChange={event => { setDraft({ base: nickname, value: event.target.value }); setStatus(null) }} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!owner || normalizeLocalNickname(value) === nickname}>Save</Button>
        <Button type="button" size="sm" variant="outline" disabled={!owner || (!nickname && !value)} onClick={() => save("")}>Reset</Button>
      </div>
    </form>
    {status && <p role={status.error ? "alert" : "status"} className={`text-sm ${status.error ? "text-destructive" : "text-muted-foreground"}`}>{status.message}</p>}
  </section>
}
