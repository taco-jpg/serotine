/* Notifications for messages received while Serotine is open in a background tab. */
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()))
self.addEventListener("notificationclick", event => {
  event.notification.close()
  const target = new URL(event.notification.data?.url || "/chat", self.location.origin)
  if (target.origin !== self.location.origin || !target.pathname.startsWith("/chat/")) return
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async clients => {
    const client = clients.find(item => new URL(item.url).origin === self.location.origin)
    if (client) { await client.navigate(target.href); await client.focus() }
    else await self.clients.openWindow(target.href)
  }))
})
