"use client"

import { useEffect, useState } from "react"
import { BarChart3, Check, Loader2, Plus, UserMinus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { MAX_MESSAGE_LENGTH } from "@/lib/protocol"

const errorText = (error: unknown) => error instanceof Error ? error.message : "This change could not be saved. Try again."

export function PollCreator({ open, onOpenChange, onCreate }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreate: (question: string, options: string[]) => Promise<void>
}) {
  const [question, setQuestion] = useState("")
  const [options, setOptions] = useState(["", ""])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const valid = !!question.trim() && options.every(option => !!option.trim())
    && new Set(options.map(option => option.trim().toLocaleLowerCase())).size === options.length
  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!valid || busy) return
    setBusy(true); setError("")
    try {
      await onCreate(question.trim(), options.map(option => option.trim()))
      setQuestion(""); setOptions(["", ""]); onOpenChange(false)
    } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(false) }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value) }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Create a poll</DialogTitle><DialogDescription>Everyone in this conversation can choose one answer and change their vote.</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => void submit(event)}>
      <div className="space-y-2"><Label htmlFor="poll-question">Question</Label><Input id="poll-question" required maxLength={240} value={question} disabled={busy} onChange={event => setQuestion(event.target.value)} placeholder="When should we meet?" /></div>
      <fieldset disabled={busy} className="space-y-2"><legend className="mb-2 text-sm font-medium">Answers</legend>{options.map((option, index) => <div key={index} className="flex items-center gap-2"><Input aria-label={`Answer ${index + 1}`} required maxLength={120} value={option} placeholder={`Answer ${index + 1}`} onChange={event => setOptions(current => current.map((item, i) => i === index ? event.target.value : item))} />{options.length > 2 && <Button type="button" size="icon" variant="ghost" aria-label={`Remove answer ${index + 1}`} onClick={() => setOptions(current => current.filter((_, i) => i !== index))}><X className="size-4" /></Button>}</div>)}</fieldset>
      {options.length < 10 && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setOptions(current => [...current, ""])}><Plus className="size-4" />Add answer</Button>}
      {options.every(option => option.trim()) && new Set(options.map(option => option.trim().toLocaleLowerCase())).size !== options.length && <p className="text-sm text-amber-200">Give each answer different text.</p>}
      {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !valid}>{busy ? <Loader2 className="size-4 animate-spin" /> : <BarChart3 className="size-4" />}Send poll</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>
}

export function PollCard({ question, options, votes, myPub, disabled, onVote }: {
  question: string
  options: { id: string; text: string }[]
  votes: Record<string, string>
  myPub: string
  disabled?: boolean
  onVote: (option: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const validVotes = Object.values(votes).filter(id => options.some(option => option.id === id))
  const total = validVotes.length
  return <div className="min-w-48 space-y-3 sm:min-w-64"><div className="flex items-start gap-2"><BarChart3 className="mt-0.5 size-4 shrink-0" /><p className="font-medium">{question}</p></div><div role="group" aria-label={question} className="space-y-2">{options.map(option => {
    const count = validVotes.filter(id => id === option.id).length
    const percentage = total ? Math.round(count / total * 100) : 0
    const selected = votes[myPub] === option.id
    return <button key={option.id} type="button" disabled={disabled || busy} aria-pressed={selected} onClick={async () => {
      if (selected) return
      setBusy(true); setError("")
      try { await onVote(option.id) } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
    }} className="relative flex min-h-11 w-full items-center gap-2 overflow-hidden rounded-lg border border-current/20 px-3 py-2 text-left text-sm disabled:cursor-default"><span className="absolute inset-y-0 left-0 bg-current opacity-10 transition-all" style={{ width: `${percentage}%` }} /><span className="relative flex-1 break-words">{option.text}</span>{selected && <Check className="relative size-3.5 shrink-0" />}<span className="relative shrink-0 tabular-nums opacity-70">{count} · {percentage}%</span></button>
  })}</div><p className="text-xs opacity-65">{busy ? "Saving vote…" : `${total} vote${total === 1 ? "" : "s"} · Choose one answer`}</p>{error && <p role="alert" className="text-xs">{error}</p>}</div>
}

export function EditMessageDialog({ message, onClose, onSave }: {
  message: { id: string; content: string } | null
  onClose: () => void
  onSave: (id: string, content: string) => Promise<void>
}) {
  const [content, setContent] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => { setContent(message?.content || ""); setError("") }, [message])
  return <Dialog open={!!message} onOpenChange={open => { if (!open && !busy) onClose() }}><DialogContent><DialogHeader><DialogTitle>Edit message</DialogTitle><DialogDescription>The message will show an edited label for everyone in this conversation.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={async event => {
    event.preventDefault()
    if (!message || busy || !content.trim()) return
    setBusy(true); setError("")
    try { await onSave(message.id, content); onClose() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }}><Textarea aria-label="Edited message" rows={5} maxLength={MAX_MESSAGE_LENGTH} disabled={busy} value={content} onChange={event => setContent(event.target.value)} />{error && <p role="alert" className="text-sm text-red-300">{error}</p>}<DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !content.trim() || content === message?.content}>{busy && <Loader2 className="size-4 animate-spin" />}Save changes</Button></DialogFooter></form></DialogContent></Dialog>
}

export interface MemberLabel { pub: string; label: string }
export function GroupSettings({ groupName, members, candidates, canManage, left, ownerPub, myPub, onRename, onAdd, onRemove, onLeave }: {
  groupName: string
  members: MemberLabel[]
  candidates: MemberLabel[]
  canManage: boolean
  left: boolean
  ownerPub: string
  myPub: string
  onRename: (name: string) => Promise<void>
  onAdd: (pub: string) => Promise<void>
  onRemove: (pub: string) => Promise<void>
  onLeave: () => Promise<void>
}) {
  const [name, setName] = useState(groupName)
  const [newPub, setNewPub] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [remove, setRemove] = useState<MemberLabel | null>(null)
  const act = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError("")
    try { await action() } catch (cause) { setError(errorText(cause)) } finally { setBusy(false) }
  }
  return <div className="space-y-5">
    {canManage && !left && <form className="space-y-2" onSubmit={event => { event.preventDefault(); void act(() => onRename(name.trim())) }}><Label htmlFor="group-rename">Group name</Label><div className="flex gap-2"><Input id="group-rename" value={name} maxLength={80} required disabled={busy} onChange={event => setName(event.target.value)} /><Button type="submit" disabled={busy || !name.trim() || name.trim() === groupName}>Save</Button></div></form>}
    <div><h3 className="mb-3 text-sm font-medium">Members · {members.length}</h3><ul className="space-y-2">{members.map(member => <li key={member.pub} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 px-3 py-2"><div className="min-w-0"><p className="truncate text-sm">{member.pub === myPub ? "You" : member.label}</p><p className="text-xs text-zinc-500">{member.pub === ownerPub ? "Group admin" : "Member"}</p></div>{canManage && !left && member.pub !== myPub && <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${member.label} from group`} disabled={busy} onClick={() => setRemove(member)}><UserMinus className="size-4" /></Button>}</li>)}</ul></div>
    {canManage && !left && <form className="space-y-2" onSubmit={event => { event.preventDefault(); void act(async () => { await onAdd(newPub.trim()); setNewPub("") }) }}><Label htmlFor="group-add-member">Invite a member</Label><Input id="group-add-member" list="group-contact-candidates" required disabled={busy} value={newPub} onChange={event => setNewPub(event.target.value)} placeholder="Paste a contact’s address" maxLength={150} /><datalist id="group-contact-candidates">{candidates.map(contact => <option key={contact.pub} value={contact.pub}>{contact.label}</option>)}</datalist><Button type="submit" variant="outline" disabled={busy || !newPub.trim()}><Plus className="size-4" />Add to group</Button></form>}
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {left ? <p className="text-sm text-zinc-400">{members.length === 0 ? "This group is closed. Saved messages are still available here." : "You left this group. Saved messages are still available here."}</p> : <div className="border-t border-zinc-800 pt-4">{confirmLeave ? <div className="space-y-3"><p className="text-sm text-zinc-300">{canManage ? "Close this group for everyone? All members will stop receiving group messages. Saved history remains on each device." : "Leave this group? Your saved messages will remain on this device."}</p><div className="flex gap-2"><Button variant="outline" disabled={busy} onClick={() => setConfirmLeave(false)}>Stay</Button><Button variant="destructive" disabled={busy} onClick={() => void act(onLeave)}>{busy && <Loader2 className="size-4 animate-spin" />}{canManage ? "Close group" : "Leave group"}</Button></div></div> : <Button variant="outline" className="text-red-300" onClick={() => setConfirmLeave(true)}>{canManage ? "Close group" : "Leave group"}</Button>}</div>}
    <Dialog open={!!remove} onOpenChange={open => { if (!open && !busy) setRemove(null) }}><DialogContent><DialogHeader><DialogTitle>Remove group member?</DialogTitle><DialogDescription>{remove?.label} will no longer receive new group messages.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemove(null)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void act(async () => { if (remove) { await onRemove(remove.pub); setRemove(null) } })}>Remove member</Button></DialogFooter></DialogContent></Dialog>
  </div>
}
