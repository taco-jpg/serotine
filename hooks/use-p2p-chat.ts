"use client"

import { useEffect, useRef, useState } from "react"
import { storeSignal, getSignal, storeEncryptedMessage, getMyMessages, deleteMessage } from "@/app/actions"
import { encryptForPeer, decryptFromPeer, importKey } from "@/lib/crypto"
import { loadIdentity, validateAddress, type Identity } from "@/lib/identity"
import { createRequestProof } from "@/lib/request-auth"
import { isEnvelope, ID_PATTERN, MAX_MESSAGE_LENGTH, MAX_PACKET_LENGTH, type Envelope } from "@/lib/protocol"
import { saveMessageToStorage, getMessagesFromStorage, migrateLegacyHistory, type StoredMessage } from "@/lib/storage"
import { RTC_CONFIG } from "@/config/webrtc"
import { MessageSendError } from "@/lib/message-send-error"

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
  const sessionRef = useRef<Session | null>(null)
  const sending = useRef(new Set<string>())

  useEffect(() => {
    let active = true
    let session: Session | null = null
    let pc: RTCPeerConnection | null = null
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let currentSessionId = ""
    let lastAttempt = 0
    let polling = false
    let negotiating = false
    let relayAvailable = false
    const received = new Set<string>()
    const now = () => active && session?.active
    const proof = (action: string, payload: unknown) => createRequestProof(action, payload, session!.identity.privateKey, session!.identity.publicKey)
    const show = (message: ChatMessage) => {
      if (!now()) return
      setMessages(previous => [...previous.filter(item => item.id !== message.id || item.senderPubKey !== message.senderPubKey), message].sort((a, b) => a.timestamp - b.timestamp))
    }
    const closePeer = () => {
      if (session?.channel) {
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
      channel.onopen = () => { if (now()) setStatus("online") }
      channel.onclose = () => { if (now()) setStatus(relayAvailable ? "relay" : "offline") }
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
      if (!session || !now() || connection !== pc || !connection.localDescription) return
      const packet: SignalPacket = { version: 2, sender: session.identity.publicKey, recipient: targetPubKey, sessionId: id, timestamp: Date.now(), description: connection.localDescription.toJSON() }
      const data = { recipientPubKey: targetPubKey, encryptedData: await encryptForPeer(JSON.stringify(packet), session.privateKey, targetPubKey) }
      if (!now()) return
      const result = await storeSignal(data, await proof("signal:send", data))
      if (!result.success) throw new Error(result.error)
    }
    const negotiate = async () => {
      if (!session || !now() || negotiating || typeof RTCPeerConnection === "undefined" || session.channel?.readyState === "open") return
      negotiating = true
      try {
        const isOfferer = session.identity.publicKey < targetPubKey
        if (isOfferer && (!pc || Date.now() - lastAttempt > 25_000)) {
          lastAttempt = Date.now()
          currentSessionId = crypto.randomUUID()
          const connection = newPeer()
          attachChannel(connection.createDataChannel("serotine-v2"))
          await connection.setLocalDescription(await connection.createOffer())
          await gatherIce(connection)
          await publishSignal(connection, currentSessionId)
        }
        if (!now()) return
        const data = { senderPubKey: targetPubKey }
        const result = await getSignal(data, await proof("signal:read", data))
        if (!result.success || !result.signal || !now()) return
        const packet = JSON.parse(await decryptFromPeer(result.signal.encryptedData, session.privateKey, targetPubKey)) as SignalPacket
        if (packet.version !== 2 || packet.sender !== targetPubKey || packet.recipient !== session.identity.publicKey
          || !ID_PATTERN.test(packet.sessionId) || !Number.isSafeInteger(packet.timestamp) || Math.abs(Date.now() - packet.timestamp) > 60_000) return
        if (isOfferer && packet.sessionId === currentSessionId && packet.description?.type === "answer" && pc?.signalingState === "have-local-offer") {
          await pc.setRemoteDescription(packet.description)
        } else if (!isOfferer && packet.description?.type === "offer" && packet.sessionId !== currentSessionId) {
          currentSessionId = packet.sessionId
          lastAttempt = Date.now()
          const connection = newPeer()
          await connection.setRemoteDescription(packet.description)
          await connection.setLocalDescription(await connection.createAnswer())
          await gatherIce(connection)
          await publishSignal(connection, currentSessionId)
        }
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
        const data = { senderPubKey: targetPubKey }
        const result = await getMyMessages(data, await proof("message:list", data))
        if (!result.success) throw new Error(result.error)
        relayAvailable = true
        if (now()) { setError(null); setStatus(session.channel?.readyState === "open" ? "online" : "relay") }
        for (const message of result.messages) {
          if (!now()) break
          try {
            if (await receive(message.encryptedData, message.id)) {
              const ack = { id: message.id, senderPubKey: targetPubKey }
              const acknowledged = await deleteMessage(ack, await proof("message:ack", ack))
              if (!acknowledged.success && now()) setError("Message saved. Relay acknowledgment will be retried automatically.")
            } else if (now()) setError("An invalid encrypted message was left in the relay. Verify this contact’s address.")
          } catch {
            if (now()) setError("A message could not be decrypted or saved. It remains in the relay for another attempt.")
          }
        }
      } catch (cause) {
        relayAvailable = false
        if (now()) {
          setStatus(session.channel?.readyState === "open" ? "online" : "offline")
          setError(cause instanceof Error ? cause.message : "Could not reach the relay. Retrying…")
        }
      } finally {
        polling = false
        if (now()) {
          void negotiate()
          pollTimer = setTimeout(() => void poll(), relayAvailable ? 3000 : 8000)
        }
      }
    }
    const wake = () => { clearTimeout(pollTimer); void poll() }
    const initialize = async () => {
      setReady(false); setMessages([]); setStatus("connecting"); setError(null)
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
        setMessages(history.map(item => item.delivery === "pending" ? { ...item, delivery: "failed" as const } : item).sort((a, b) => a.timestamp - b.timestamp))
        setReady(true)
        await poll()
      } catch (cause) {
        if (active) { setError(cause instanceof Error ? cause.message : "Could not open this conversation."); setStatus("offline") }
      }
    }
    void initialize()
    window.addEventListener("online", wake)
    return () => {
      active = false
      if (session) session.active = false
      if (sessionRef.current === session) sessionRef.current = null
      clearTimeout(pollTimer)
      closePeer()
      window.removeEventListener("online", wake)
    }
  }, [targetPubKey])

  const sendMessage = async (content: string, retry?: ChatMessage) => {
    const session = sessionRef.current
    if (!session?.active || session.peer !== targetPubKey || !ready) throw new Error("Your identity is still loading. Please wait.")
    const text = content.trim()
    if (!text || text.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages must contain 1–${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`)
    const id = retry?.id ?? crypto.randomUUID()
    if (sending.current.has(id)) return
    sending.current.add(id)
    const message: ChatMessage = { id, peerPubKey: targetPubKey, senderPubKey: session.identity.publicKey, content: text, timestamp: retry?.timestamp ?? Date.now(), delivery: "pending" }
    const update = (item: ChatMessage) => {
      if (session.active) setMessages(previous => [...previous.filter(m => m.id !== item.id || m.senderPubKey !== item.senderPubKey), item].sort((a, b) => a.timestamp - b.timestamp))
    }
    let accepted = false
    let savedLocally = false
    try {
      await saveMessageToStorage(session.identity.publicKey, message)
      savedLocally = true
      update(message)
      const envelope: Envelope = { version: 2, id, sender: session.identity.publicKey, recipient: targetPubKey, content: text, timestamp: message.timestamp }
      const encryptedData = await encryptForPeer(JSON.stringify(envelope), session.privateKey, targetPubKey)
      const data = { id, recipientPubKey: targetPubKey, encryptedData }
      // Queue durably even when direct is available. Both paths use the same ID;
      // a peer that closes mid-send can still collect the queued copy later.
      const result = await storeEncryptedMessage(data, await createRequestProof("message:send", data, session.identity.privateKey, session.identity.publicKey))
      if (!result.success) throw new Error(result.error)
      accepted = true
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
      await saveMessageToStorage(session.identity.publicKey, message).then(() => { savedLocally = true }).catch(() => {})
      if (savedLocally) update(message)
      const failure = new MessageSendError(cause instanceof Error ? cause.message : "Message was not sent. Please retry.", savedLocally)
      if (session.active) setError(failure.message)
      throw failure
    } finally { sending.current.delete(id) }
  }
  return { sendMessage, status, messages, myPub, ready, error }
}
