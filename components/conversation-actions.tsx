"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Archive, ArchiveRestore, Loader2, MoreHorizontal, Trash2 } from "lucide-react"
import { useMessaging } from "@/components/messaging-provider"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { conversationFromPathname } from "@/lib/conversation-route"
import type { ConversationRecord } from "@/lib/messaging-types"

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : "This chat could not be updated. Please try again."

export function ConversationActions({ conversation, disabled = false, children, onError, onNotice }: {
  conversation: ConversationRecord
  disabled?: boolean
  children?: React.ReactNode
  onError: (message: string) => void
  onNotice?: (message: string) => void
}) {
  const messaging = useMessaging()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState("")
  const actionLock = useRef(false)
  const openDeleteAfterMenu = useRef(false)
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const restoreLabel = conversation.blocked ? "Unarchive chat" : conversation.request ? "Restore to requests" : "Restore to inbox"

  async function archive() {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(true); onError("")
    try {
      await messaging.archiveConversation(conversation.id, !conversation.archived)
      onNotice?.(conversation.archived
        ? conversation.blocked ? "Chat unarchived. This person is still blocked." : conversation.request ? "Chat restored to message requests." : "Chat restored to your inbox."
        : "Chat archived. Its messages are saved in Archived.")
      if (!conversation.archived && conversationFromPathname(window.location.pathname) === conversation.id) router.replace("/chat")
    } catch (cause) { onError(errorText(cause)) }
    finally { actionLock.current = false; setBusy(false) }
  }

  async function deleteChat() {
    if (actionLock.current) return
    actionLock.current = true
    setBusy(true); setDeleteError(""); onError("")
    try {
      await messaging.deleteConversation(conversation.id)
      setDeleteOpen(false)
      onNotice?.("Chat and saved history deleted from this device.")
      if (conversationFromPathname(window.location.pathname) === conversation.id) router.replace("/chat")
    } catch (cause) { setDeleteError(errorText(cause)) }
    finally { actionLock.current = false; setBusy(false) }
  }

  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="mr-1 size-11 shrink-0 text-muted-foreground md:size-8" aria-label={`Options for ${conversation.name}`} title="Chat options" aria-busy={busy} disabled={disabled || busy || !messaging.ready}>{busy ? <Loader2 className="size-4 animate-spin" /> : <MoreHorizontal className="size-4" />}</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="[&_[role=menuitem]]:min-h-11" onCloseAutoFocus={event => {
        if (!openDeleteAfterMenu.current) return
        event.preventDefault()
        openDeleteAfterMenu.current = false
        setDeleteError(""); setDeleteOpen(true)
      }}>
        <DropdownMenuItem disabled={busy} onSelect={() => void archive()}>{conversation.archived ? <ArchiveRestore /> : <Archive />}{conversation.archived ? restoreLabel : "Archive chat"}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} variant="destructive" onSelect={() => { openDeleteAfterMenu.current = true }}><Trash2 />Delete chat…</DropdownMenuItem>
        {children && <><DropdownMenuSeparator />{children}</>}
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={deleteOpen} onOpenChange={open => { if (!actionLock.current) setDeleteOpen(open) }}>
      <DialogContent showCloseButton={!busy} onOpenAutoFocus={event => { event.preventDefault(); cancelDelete.current?.focus() }}>
        <DialogHeader><DialogTitle>Delete this chat?</DialogTitle><DialogDescription className="break-words">Delete the saved messages and files for {conversation.name} from this device. This cannot be undone.</DialogDescription></DialogHeader>
        <p className="text-sm leading-relaxed text-muted-foreground">Your contacts stay saved. This does not delete anyone else’s copy or leave a group. New messages may make this chat appear again.</p>
        <p className="text-sm leading-relaxed text-muted-foreground">To hide the chat and keep its history, choose Archive chat instead.</p>
        {deleteError && <p role="alert" className="break-words text-sm text-destructive">{deleteError}</p>}
        <DialogFooter><Button ref={cancelDelete} variant="outline" disabled={busy} onClick={() => setDeleteOpen(false)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={() => void deleteChat()}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}Delete chat</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
