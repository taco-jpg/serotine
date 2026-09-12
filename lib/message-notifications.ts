import type { ConversationRecord, MessageRecord } from "./messaging-types"

export function shouldNotify(message: MessageRecord, conversation: ConversationRecord, owner: string) {
  return message.senderPubKey !== owner && !conversation.blocked && !conversation.request && !conversation.archived
    && conversation.notificationMode !== "muted"
    && (conversation.notificationMode !== "mentions" || message.mentions?.includes(owner) === true)
}

async function notificationRegistration() {
  if (!("serviceWorker" in navigator)) return null
  try { return await navigator.serviceWorker.register("/messaging-sw.js", { scope: "/" }) }
  catch { return null }
}

/** Call only from an explicit click. There are no automatic permission prompts. */
export async function requestMessagingNotifications(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    throw new Error("This browser does not support message notifications. Unread counts are still available in Serotine.")
  }
  const permission = await Notification.requestPermission()
  if (permission === "granted") await notificationRegistration()
  return permission
}

export async function notifyIncoming(message: MessageRecord, conversation: ConversationRecord, owner: string) {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted"
    || document.visibilityState !== "hidden" || !shouldNotify(message, conversation, owner)) return
  const notify = async () => {
    const key = `serotine-notifications:${owner}`
    const id = `${message.senderPubKey}:${message.id}`
    let recent: string[] = []
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) || "[]")
      if (Array.isArray(saved)) recent = saved.filter((item): item is string => typeof item === "string").slice(-100)
      if (recent.includes(id)) return
    } catch { /* A blocked preference store must not break receiving messages. */ }
    const url = `/chat/${encodeURIComponent(conversation.id)}`
    const options: NotificationOptions = {
      body: "Open Serotine to read your new message.",
      tag: `serotine:${owner}:${id}`, data: { url },
    }
    try {
      const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration("/") : null
      if (registration?.active) await registration.showNotification("New Serotine message", options)
      else {
        const notification = new Notification("New Serotine message", options)
        notification.onclick = () => { window.focus(); window.location.assign(url); notification.close() }
      }
      try { localStorage.setItem(key, JSON.stringify([...recent, id].slice(-100))) } catch { /* Optional deduplication. */ }
    } catch { /* Notification permission or platform availability can change at any time. */ }
  }
  if (navigator.locks) await navigator.locks.request(`serotine:notify:${owner}`, notify)
  else await notify()
}
