"use client"

import { useEffect, useRef, useState } from "react"
import { storeSignal, getSignal, storeEncryptedMessage, getMyMessages, deleteMessage } from "@/lib/relay-client"
import { encryptForPeer, decryptFromPeer, importKey } from "@/lib/crypto"
import { loadIdentity, validateAddress, type Identity } from "@/lib/identity"
import { createRequestProof } from "@/lib/request-auth"
import { isEnvelope, ID_PATTERN, MAX_MESSAGE_LENGTH, MAX_PACKET_LENGTH, type Envelope, type InboxCursor, type InboxRequest } from "@/lib/protocol"
import { saveMessageToStorage, getMessagesFromStorage, migrateLegacyHistory, type StoredMessage } from "@/lib/storage"
import { RTC_CONFIG } from "@/config/webrtc"
import { MessageSendError } from "@/lib/message-send-error"
import { withRelayTimeout } from "@/lib/relay-timeout"
import { subscribeToHistory } from "@/lib/history-events"

export type Status = "connecting" | "online" | "relay" | "offline"
export type ChatMessage = StoredMessage
interface Session {
  active: boolean
  identity: Identity
  privateKey: CryptoKey
  peer: string
  channel: RTCDataChannel | null
}
interface SignalPacket {
  version: 2
  sender: string
  recipient: string
  sessionId: string
  timestamp: number
  description: RTCSessionDescriptionInit
}

export function useP2PChat(targetPubKey: string) {
  const [status, setStatus] = useState<Status>("connecting")
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [myPub, setMyPub] = useState("")
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reconnectRef = useRef<(() => void) | null>(null)
  const sessionRef = useRef<Session | null>(null)
  const sending = useRef(new Set<string>())

  useEffect(() => {
    let active = true
    let session: Session | null = null
    let pc: RTCPeerConnection | null = null
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let currentSessionId = ""
    let lastAttempt = 0
    let lastSignalCheck = 0
    let polling = false
    let negotiating = false
    let relayAvailable = false
    let consecutiveFailures = 0
    let emptyPolls = 0
    let cursor: InboxCursor | null = null
    let receiveWarning: string | null = null
    let unsubscribeHistory: (() => void) | undefined
    let refreshing = false
    let refreshAgain = false
    let pendingTimer: ReturnType<typeof setTimeout> | undefined
    const displayMessage = (item: ChatMessage): ChatMessage => item.delivery === "pending" && !sending.current.has(item.id)
      && Date.now() - (item.updatedAt ?? item.timestamp) >= 30_000 ? { ...item, delivery: "failed" } : item
    const schedulePendingRefresh = (history: ChatMessage[]) => {
      clearTimeout(pendingTimer)
      const pending = history.filter(item => item.delivery === "pending" && !sending.current.has(item.id) && displayMessage(item).delivery === "pending")
      if (pending.length) pendingTimer = setTimeout(() => void refreshHistory(), Math.max(1, Math.min(...pending.map(item => (item.updatedAt ?? item.timestamp) + 30_000 - Date.now()))))
    }
    const received = new Set<string>()
    const now = () => active && session?.active
    const canSignal = () => relayAvailable && navigator.onLine && document.visibilityState !== "hidden"
    const proof = (action: string, payload: unknown) => createRequestProof(action, payload, session!.identity.privateKey, session!.identity.publicKey)
    const show = (message: ChatMessage) => {
      if (!now()) return
      setMessages(previous => [...previous.filter(item => item.id !== message.id || item.senderPubKey !== message.senderPubKey), message].sort((a, b) => a.timestamp - b.timestamp))
    }
    const closePeer = () => {
      if (session?.channel) {
        session.channel.onopen = null
        session.channel.onclose = null
        session.channel.onmessage = null
        session.channel.close()
        session.channel = null
      }
      if (pc) { pc.onconnectionstatechange = null; pc.ondatachannel = null; pc.close(); pc = null }
    }
    const receive = async (encrypted: string, expectedId?: string) => {
      if (!session || !now() || encrypted.length > MAX_PACKET_LENGTH) return false
      const envelope: unknown = JSON.parse(await decryptFromPeer(encrypted, session.privateKey, targetPubKey))
      if (!isEnvelope(envelope, targetPubKey, session.identity.publicKey) || (expectedId && envelope.id !== expectedId)) return false
      if (received.has(envelope.id)) return true
      const message: ChatMessage = { id: envelope.id, peerPubKey: targetPubKey, senderPubKey: targetPubKey, content: envelope.content, timestamp: envelope.timestamp, delivery: "received" }
      // Acknowledge only AFTER durable local storage succeeds.
      await saveMessageToStorage(session.identity.publicKey, message)
      received.add(message.id)
      show(message)
      return true
    }
    const attachChannel = (channel: RTCDataChannel) => {
      if (!session || !now()) { channel.close(); return }
      session.channel = channel
      channel.onopen = () => { if (now() && session?.channel === channel) setStatus("online") }
      channel.onclose = () => { if (now() && session?.channel === channel) setStatus(relayAvailable ? "relay" : "offline") }
      channel.onmessage = event => {
        if (typeof event.data !== "string") return
        void receive(event.data).catch(() => { if (now()) setError("A message could not be saved. Keep this tab open and check available browser storage.") })
      }
    }
    const newPeer = () => {
      closePeer()
      const connection = new RTCPeerConnection(RTC_CONFIG)
      pc = connection
      connection.ondatachannel = event => attachChannel(event.channel)
      connection.onconnectionstatechange = () => {
        if (!now() || pc !== connection) return
        if (["failed", "disconnected", "closed"].includes(connection.connectionState)) setStatus(relayAvailable ? "relay" : "offline")
      }
      return connection
    }
    const gatherIce = (connection: RTCPeerConnection) => new Promise<void>(resolve => {
      if (connection.iceGatheringState === "complete") return resolve()
      const finish = () => { clearTimeout(timeout); connection.removeEventListener("icegatheringstatechange", check); resolve() }
      const check = () => { if (connection.iceGatheringState === "complete") finish() }
      const timeout = setTimeout(finish, 4000)
      connection.addEventListener("icegatheringstatechange", check)
    })
    const publishSignal = async (connection: RTCPeerConnection, id: string) => {
      if (!session || !now() || !canSignal() || connection !== pc || !connection.localDescription) return
      const packet: SignalPacket = { version: 2, sender: session.identity.publicKey, recipient: targetPubKey, sessionId: id, timestamp: Date.now(), description: connection.localDescription.toJSON() }
      const data = { recipientPubKey: targetPubKey, encryptedData: await encryptForPeer(JSON.stringify(packet), session.privateKey, targetPubKey) }
      if (!now()) return
      const result = await withRelayTimeout(storeSignal(data, await proof("signal:send", data)))
      if (!result.success) throw new Error(result.error)
    }
    const offerConnection = async () => {
      lastAttempt = Date.now()
      currentSessionId = crypto.randomUUID()
      const connection = newPeer()
      attachChannel(connection.createDataChannel("serotine-v2"))
      const offer = await connection.createOffer()
      if (!now() || pc !== connection) return
      await connection.setLocalDescription(offer)
      if (!now() || pc !== connection) return
      await gatherIce(connection)
      await publishSignal(connection, currentSessionId)
    }
    const negotiate = async () => {
      if (!session || !now() || !canSignal() || negotiating || typeof RTCPeerConnection === "undefined" || session.channel?.readyState === "open") return
      if (Date.now() - lastSignalCheck < 15_000) return
      lastSignalCheck = Date.now()
      negotiating = true
      try {
        const isOfferer = session.identity.publicKey < targetPubKey
        if (isOfferer && !pc) await offerConnection()
        if (!now() || !canSignal()) return
        const data = { senderPubKey: targetPubKey }
        const result = await withRelayTimeout(getSignal(data, await proof("signal:read", data)))
        if (!result.success || !now()) return
        if (result.signal) {
          const packet = JSON.parse(await decryptFromPeer(result.signal.encryptedData, session.privateKey, targetPubKey)) as SignalPacket
          if (!now()) return
          if (packet.version === 2 && packet.sender === targetPubKey && packet.recipient === session.identity.publicKey
            && ID_PATTERN.test(packet.sessionId) && Number.isSafeInteger(packet.timestamp) && Math.abs(Date.now() - packet.timestamp) <= 60_000) {
            if (isOfferer && packet.sessionId === currentSessionId && packet.description?.type === "answer" && pc?.signalingState === "have-local-offer") {
              await pc.setRemoteDescription(packet.description)
              return
            } else if (!isOfferer && packet.description?.type === "offer" && packet.sessionId !== currentSessionId) {
              currentSessionId = packet.sessionId
              lastAttempt = Date.now()
              const connection = newPeer()
              await connection.setRemoteDescription(packet.description)
              if (!now() || pc !== connection) return
              const answer = await connection.createAnswer()
              if (!now() || pc !== connection) return
              await connection.setLocalDescription(answer)
              if (!now() || pc !== connection) return
              await gatherIce(connection)
              await publishSignal(connection, currentSessionId)
            }
          }
        }
        // Check for a waiting answer before replacing an old offer; a slower
        // polling cadence must not continually discard the peer's response.
        if (isOfferer && now() && Date.now() - lastAttempt > 25_000) await offerConnection()
      } catch {
        // Direct connections are optional; the independent relay stays active.
        if (now()) setStatus(sessionRef.current?.channel?.readyState === "open" ? "online" : relayAvailable ? "relay" : "offline")
      } finally { negotiating = false }
    }
    const poll = async () => {
      if (!session || !now() || polling) return
      polling = true
      try {
        if (!navigator.onLine) throw new Error("You are offline. Reconnect to send and receive messages.")
        const data: InboxRequest = { senderPubKey: targetPubKey, ...(cursor ? { after: cursor } : {}) }
        const result = await withRelayTimeout(getMyMessages(data, await proof("message:list", data)))
        if (!result.success) throw new Error(result.error)
        if (!now()) return
        relayAvailable = true
        consecutiveFailures = 0
        emptyPolls = result.messages.length ? 0 : Math.min(emptyPolls + 1, 5)
        if (!cursor) receiveWarning = null
        setStatus(session.channel?.readyState === "open" ? "online" : "relay")
        let canAcknowledge = true
        for (const message of result.messages) {
          if (!now()) break
          try {
            if (await receive(message.encryptedData, message.id)) {
              if (!now() || !canAcknowledge) continue
              const ack = { id: message.id, senderPubKey: targetPubKey }
              try {
                const acknowledged = await withRelayTimeout(deleteMessage(ack, await proof("message:ack", ack)))
                if (!acknowledged.success) throw new Error(acknowledged.error)
              } catch {
                canAcknowledge = false
                receiveWarning = "Messages saved. Relay acknowledgment will be retried automatically."
              }
            } else receiveWarning = "An invalid encrypted message was left in the relay. Verify this contact’s address."
          } catch {
            receiveWarning = "A message could not be decrypted or saved. It remains in the relay for another attempt."
          }
        }
        // One bounded page per poll: unreadable rows cannot hide later messages.
        cursor = result.nextCursor ?? null
        if (now()) setError(receiveWarning)
      } catch (cause) {
        relayAvailable = false
        consecutiveFailures = Math.min(consecutiveFailures + 1, 4)
        if (now()) {
          setStatus(session.channel?.readyState === "open" ? "online" : "offline")
          setError(cause instanceof Error ? cause.message : "Could not reach the relay. Retrying…")
        }
      } finally {
        polling = false
        if (now()) {
          const hidden = document.visibilityState === "hidden"
          // Signaling cannot repair an unavailable relay. Avoid competing requests
          // during outages, and spare idle tabs repeated connection attempts.
          if (canSignal()) void negotiate()
          const delay = relayAvailable ? cursor ? 100 : 3000 * Math.max(1, emptyPolls) : Math.min(8000 * 2 ** (consecutiveFailures - 1), 60_000)
          pollTimer = setTimeout(() => void poll(), hidden ? Math.max(delay, 30_000) : delay)
        }
      }
    }
    const refreshHistory = async () => {
      if (!now() || !session) return
      if (refreshing) { refreshAgain = true; return }
      refreshing = true
      try {
        do {
          refreshAgain = false
          const history = await getMessagesFromStorage(session.identity.publicKey, targetPubKey)
          if (!now()) return
          history.forEach(item => { if (item.senderPubKey === targetPubKey) received.add(item.id) })
          setMessages(previous => {
            const merged = new Map(previous.map(item => [`${item.senderPubKey}:${item.id}`, item]))
            for (const item of history) {
              const key = `${item.senderPubKey}:${item.id}`
              const existing = merged.get(key)
              // A stale read must not downgrade a confirmed send.
              if (existing?.delivery === "sent" && item.delivery !== "sent") continue
              merged.set(key, displayMessage(item))
            }
            return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp)
          })
          schedulePendingRefresh(history)
        } while (refreshAgain && now())
      } catch { if (now()) setError("Could not refresh saved history. Check browser storage and try reconnecting.") }
      finally { refreshing = false }
    }
    const wake = () => { emptyPolls = 0; clearTimeout(pollTimer); void refreshHistory(); void poll() }
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") wake()
      else if (now() && !polling) {
        clearTimeout(pollTimer)
        const delay = relayAvailable ? 30_000 : Math.max(30_000, Math.min(8000 * 2 ** Math.max(0, consecutiveFailures - 1), 60_000))
        pollTimer = setTimeout(() => void poll(), delay)
      }
    }
    const offline = () => {
      relayAvailable = false
      if (now()) { setStatus("offline"); setError("You are offline. Reconnect to send and receive messages.") }
    }
    const initialize = async () => {
      setReady(false); setMessages([]); setMyPub(""); setStatus("connecting"); setError(null)
      try {
        const identity = await loadIdentity()
        if (!identity) throw new Error("Create or restore your identity before opening a conversation.")
        await validateAddress(targetPubKey)
        if (identity.publicKey === targetPubKey) throw new Error("Choose a contact address other than your own.")
        const privateKey = await importKey(identity.privateKey, "encryption", "private")
        if (!active) return
        session = { active: true, identity, privateKey, peer: targetPubKey, channel: null }
        sessionRef.current = session
        setMyPub(identity.publicKey)
        await migrateLegacyHistory(identity.publicKey)
        const history = await getMessagesFromStorage(identity.publicKey, targetPubKey)
        if (!now()) return
        history.forEach(item => { if (item.senderPubKey === targetPubKey) received.add(item.id) })
        setMessages(history.map(displayMessage).sort((a, b) => a.timestamp - b.timestamp))
        schedulePendingRefresh(history)
        setReady(true)
        unsubscribeHistory = subscribeToHistory(identity.publicKey, targetPubKey, () => { void refreshHistory() })
        reconnectRef.current = wake
        await poll()
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : "Could not open this conversation."); setStatus("offline") }
      }
    }
    void initialize()
    window.addEventListener("online", wake)
    window.addEventListener("offline", offline)
    window.addEventListener("focus", wake)
    document.addEventListener("visibilitychange", visibilityChanged)
    return () => {
      active = false
      if (session) session.active = false
      if (sessionRef.current === session) sessionRef.current = null
      clearTimeout(pollTimer)
      clearTimeout(pendingTimer)
      unsubscribeHistory?.()
      if (reconnectRef.current === wake) reconnectRef.current = null
      closePeer()
      window.removeEventListener("online", wake)
      window.removeEventListener("offline", offline)
      window.removeEventListener("focus", wake)
      document.removeEventListener("visibilitychange", visibilityChanged)
    }
  }, [targetPubKey, attempt])

  const sendMessage = async (content: string, retry?: ChatMessage) => {
    const session = sessionRef.current
    if (!session?.active || session.peer !== targetPubKey || !ready) throw new Error("Your identity is still loading. Please wait.")
    const text = content.trim()
    if (retry && (retry.peerPubKey !== targetPubKey || retry.senderPubKey !== session.identity.publicKey || retry.content !== text)) {
      throw new Error("Retry the original message from this conversation.")
    }
    if (!text || text.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages must contain 1–${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`)
    const id = retry?.id ?? crypto.randomUUID()
    if (sending.current.has(id)) return
    sending.current.add(id)
    const message: ChatMessage = { id, peerPubKey: targetPubKey, senderPubKey: session.identity.publicKey, content: text, timestamp: retry?.timestamp ?? Date.now(), updatedAt: Date.now(), delivery: "pending" }
    const update = (item: ChatMessage) => {
      if (session.active) setMessages(previous => [...previous.filter(m => m.id !== item.id || m.senderPubKey !== item.senderPubKey), item].sort((a, b) => a.timestamp - b.timestamp))
    }
    let accepted = false
    let savedLocally = false
    try {
      const stored = await saveMessageToStorage(session.identity.publicKey, message)
      savedLocally = true
      Object.assign(message, stored)
      update(message)
      if ((message as ChatMessage).delivery === "sent") { if (session.active) setError(null); return }
      const envelope: Envelope = { version: 2, id, sender: session.identity.publicKey, recipient: targetPubKey, content: message.content, timestamp: message.timestamp }
      const encryptedData = await encryptForPeer(JSON.stringify(envelope), session.privateKey, targetPubKey)
      const data = { id, recipientPubKey: targetPubKey, encryptedData }
      // Queue durably even when direct is available. Both paths use the same ID;
      // a peer that closes mid-send can still collect the queued copy later.
      const result = await withRelayTimeout(storeEncryptedMessage(data, await createRequestProof("message:send", data, session.identity.privateKey, session.identity.publicKey)))
      if (!result.success) throw new Error(result.error)
      accepted = true
      if (session.active) reconnectRef.current?.()
      message.delivery = "sent"
      await saveMessageToStorage(session.identity.publicKey, message)
      update(message)
      if (session.channel?.readyState === "open") {
        try { session.channel.send(encryptedData) } catch { /* The durable relay already has the message. */ }
      }
      if (session.active) setError(null)
    } catch (cause) {
      if (accepted) {
        message.delivery = "sent"
        update(message)
        if (session.active) setError("Your message reached the relay, but local history could not be updated. Check available browser storage.")
        return
      }
      message.delivery = "failed"
      await saveMessageToStorage(session.identity.publicKey, message).then(stored => { savedLocally = true; Object.assign(message, stored) }).catch(() => {})
      if (savedLocally) update(message)
      if ((message as ChatMessage).delivery === "sent") { if (session.active) setError(null); return }
      const failure = new MessageSendError(cause instanceof Error ? cause.message : "Message was not sent. Please retry.", savedLocally)
      if (session.active) setError(failure.message)
      throw failure
    } finally { sending.current.delete(id) }
  }
  const reconnect = () => { if (ready && reconnectRef.current) reconnectRef.current(); else setAttempt(value => value + 1) }
  return { sendMessage, status, messages, myPub, ready, error, reconnect }
}
