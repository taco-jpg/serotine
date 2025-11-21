"use client"

import { useState, useEffect, useRef, useCallback } from "react"
import { createClient } from "@/utils/supabase/client"
import type { RealtimeChannel } from "@supabase/supabase-js"
import { v4 as uuidv4 } from "uuid"
import {
  generateEncryptionKeyPair,
  exportKey,
  importKey,
  deriveSharedSecret,
  encryptMessage,
  decryptMessage,
} from "@/lib/crypto"
import { saveMessageToStorage, getMessagesFromStorage } from "@/lib/storage"
import { RTC_CONFIG } from "@/config/webrtc"

export interface Message {
  id: string
  senderId: string
  content: string
  timestamp: number
}

interface EncryptedPayload {
  id: string
  senderId: string
  timestamp: number
  encryptedContent: string
  contentIv: string
  recipientKeys: Record<string, { ciphertext: string; iv: string }>
}

export function useWebRTC(roomId: string, userId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [peers, setPeers] = useState<string[]>([])
  const [isConnected, setIsConnected] = useState(false)

  const supabase = createClient()
  const channelRef = useRef<RealtimeChannel | null>(null)
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({})
  const dataChannels = useRef<Record<string, RTCDataChannel>>({})

  const myKeyPair = useRef<CryptoKeyPair | null>(null)
  const peerPublicKeys = useRef<Record<string, CryptoKey>>({})
  const sharedSecrets = useRef<Record<string, CryptoKey>>({})

  const historyLoaded = useRef(false)

  useEffect(() => {
    if (!roomId || !userId) return

    const init = async () => {
      let keyPair: CryptoKeyPair
      const storedKey = localStorage.getItem(`chat_keys_${userId}`)

      if (storedKey) {
        try {
          const { privateKeyJwk, publicKeyJwk } = JSON.parse(storedKey)
          const privateKey = await importKey(privateKeyJwk, "encryption", "private")
          const publicKey = await importKey(publicKeyJwk, "encryption", "public")
          keyPair = { privateKey, publicKey }
        } catch (e) {
          console.error("Failed to load stored keys, generating new ones", e)
          keyPair = await generateEncryptionKeyPair()
        }
      } else {
        keyPair = await generateEncryptionKeyPair()
        const privateKeyJwk = await exportKey(keyPair.privateKey)
        const publicKeyJwk = await exportKey(keyPair.publicKey)
        localStorage.setItem(`chat_keys_${userId}`, JSON.stringify({ privateKeyJwk, publicKeyJwk }))
      }

      myKeyPair.current = keyPair

      const localMessages = await getMessagesFromStorage(roomId)
      if (localMessages.length > 0) {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id))
          const newMsgs = localMessages.filter((m) => !existingIds.has(m.id))
          return [...prev, ...newMsgs].sort((a, b) => a.timestamp - b.timestamp)
        })
      }

      let deviceId = localStorage.getItem(`device_id_${userId}`)
      if (!deviceId) {
        deviceId = uuidv4()
        localStorage.setItem(`device_id_${userId}`, deviceId)
      }

      const publicKeyJwk = await exportKey(keyPair.publicKey)
      await supabase.from("devices").upsert(
        {
          user_id: userId,
          device_id: deviceId,
          device_name: navigator.userAgent,
          public_key: JSON.stringify(publicKeyJwk),
          last_seen: new Date().toISOString(),
          is_trusted: true,
        },
        { onConflict: "user_id, device_id" },
      )

      const channel = supabase.channel(`room:${roomId}`)
      channelRef.current = channel

      channel
        .on("broadcast", { event: "signal" }, async ({ payload }) => {
          if (payload.target !== userId) return
          const { sender, type, data } = payload
          await handleSignal(sender, type, data)
        })
        .on("broadcast", { event: "key-exchange" }, async ({ payload }) => {
          if (payload.sender === userId) return

          if (payload.type === "public-key") {
            await handlePublicKey(payload.sender, payload.key)
            if (myKeyPair.current) {
              const exportedKey = await exportKey(myKeyPair.current.publicKey)
              await channel.send({
                type: "broadcast",
                event: "key-exchange",
                payload: { sender: userId, type: "public-key-response", key: exportedKey, target: payload.sender },
              })
            }
          } else if (payload.type === "public-key-response" && payload.target === userId) {
            await handlePublicKey(payload.sender, payload.key)
          }
        })
        .on("presence", { event: "join" }, async ({ key, newPresences }) => {
          newPresences.forEach((presence: any) => {
            if (presence.user_id !== userId) {
              initiateConnection(presence.user_id)
              if (myKeyPair.current) {
                exportKey(myKeyPair.current.publicKey).then((key) => {
                  channel.send({
                    type: "broadcast",
                    event: "key-exchange",
                    payload: { sender: userId, type: "public-key", key },
                  })
                })
              }
            }
          })
        })
        .on("presence", { event: "leave" }, ({ key, leftPresences }) => {
          leftPresences.forEach((presence: any) => {
            closeConnection(presence.user_id)
          })
        })
        .subscribe(async (status) => {
          if (status === "SUBSCRIBED") {
            setIsConnected(true)
            await channel.track({ user_id: userId, online_at: new Date().toISOString() })

            if (myKeyPair.current) {
              const key = await exportKey(myKeyPair.current.publicKey)
              await channel.send({
                type: "broadcast",
                event: "key-exchange",
                payload: { sender: userId, type: "public-key", key },
              })
            }
          }
        })
    }

    init()

    return () => {
      Object.keys(peerConnections.current).forEach(closeConnection)
      if (channelRef.current) channelRef.current.unsubscribe()
    }
  }, [roomId, userId])

  const handlePublicKey = async (peerId: string, jwk: JsonWebKey) => {
    try {
      const publicKey = await importKey(jwk, "encryption", "public")
      peerPublicKeys.current[peerId] = publicKey

      if (myKeyPair.current) {
        const secret = await deriveSharedSecret(myKeyPair.current.privateKey, publicKey)
        sharedSecrets.current[peerId] = secret
        console.log(`[v0] Derived shared secret with ${peerId}`)
      }
    } catch (e) {
      console.error("Error handling public key:", e)
    }
  }

  const initiateConnection = async (peerId: string) => {
    if (peerConnections.current[peerId]) return

    console.log(`[v0] Initiating connection to ${peerId}`)
    const pc = createPeerConnection(peerId)

    const dc = pc.createDataChannel("chat")
    setupDataChannel(dc, peerId)

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    sendSignal(peerId, "offer", offer)
  }

  const handleSignal = async (peerId: string, type: string, data: any) => {
    let pc = peerConnections.current[peerId]

    if (!pc) {
      if (type !== "offer") return
      pc = createPeerConnection(peerId)
    }

    switch (type) {
      case "offer":
        await pc.setRemoteDescription(new RTCSessionDescription(data))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendSignal(peerId, "answer", answer)
        break

      case "answer":
        await pc.setRemoteDescription(new RTCSessionDescription(data))
        break

      case "candidate":
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data))
        } catch (e) {
          console.error("Error adding received ice candidate", e)
        }
        break
    }
  }

  const createPeerConnection = (peerId: string) => {
    const pc = new RTCPeerConnection(RTC_CONFIG)
    peerConnections.current[peerId] = pc

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal(peerId, "candidate", event.candidate)
      }
    }

    pc.ondatachannel = (event) => {
      setupDataChannel(event.channel, peerId)
    }

    pc.onconnectionstatechange = () => {
      console.log(`[v0] Connection state with ${peerId}: ${pc.connectionState}`)
      if (pc.connectionState === "connected") {
        setPeers((prev) => [...prev, peerId])
      } else if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
        closeConnection(peerId)
      }
    }

    return pc
  }

  const setupDataChannel = (dc: RTCDataChannel, peerId: string) => {
    dataChannels.current[peerId] = dc

    dc.onopen = () => {
      console.log(`[v0] Data channel open with ${peerId}`)
    }

    dc.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data)

        if (payload.encryptedContent && payload.recipientKeys) {
          const encryptedKeyData = payload.recipientKeys[userId]
          const sharedSecret = sharedSecrets.current[payload.senderId]

          if (encryptedKeyData && sharedSecret) {
            try {
              const messageKeyBase64 = await decryptMessage(
                encryptedKeyData.ciphertext,
                encryptedKeyData.iv,
                sharedSecret,
              )

              const binaryString = window.atob(messageKeyBase64)
              const len = binaryString.length
              const bytes = new Uint8Array(len)
              for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i)
              }

              const messageKey = await window.crypto.subtle.importKey("raw", bytes.buffer, { name: "AES-GCM" }, true, [
                "decrypt",
              ])

              const content = await decryptMessage(payload.encryptedContent, payload.contentIv, messageKey)

              const newMessage = {
                id: payload.id,
                senderId: payload.senderId,
                content,
                timestamp: payload.timestamp,
              }

              await saveMessageToStorage({ ...newMessage, groupId: roomId })

              setMessages((prev) => {
                if (prev.some((m) => m.id === payload.id)) return prev
                return [...prev, newMessage]
              })
            } catch (err) {
              console.error("Decryption failed:", err)
            }
          }
        } else {
          setMessages((prev) => [...prev, payload])
        }
      } catch (e) {
        console.error("Error processing message:", e)
      }
    }
  }

  const sendSignal = async (target: string, type: string, data: any) => {
    if (!channelRef.current) return
    await channelRef.current.send({
      type: "broadcast",
      event: "signal",
      payload: { sender: userId, target, type, data },
    })
  }

  const closeConnection = (peerId: string) => {
    const pc = peerConnections.current[peerId]
    if (pc) {
      pc.close()
      delete peerConnections.current[peerId]
    }
    delete dataChannels.current[peerId]
    setPeers((prev) => prev.filter((id) => id !== peerId))
    delete peerPublicKeys.current[peerId]
    delete sharedSecrets.current[peerId]
  }

  const sendMessage = useCallback(
    async (content: string) => {
      if (!myKeyPair.current) return

      const messageId = uuidv4()
      const timestamp = Date.now()

      const messageKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt",
      ])

      const { ciphertext: encryptedContent, iv: contentIv } = await encryptMessage(content, messageKey)

      const rawMessageKey = await window.crypto.subtle.exportKey("raw", messageKey)
      const messageKeyString = Array.from(new Uint8Array(rawMessageKey))
        .map((b) => String.fromCharCode(b))
        .join("")
      const messageKeyBase64 = window.btoa(messageKeyString)

      const recipientKeys: Record<string, { ciphertext: string; iv: string }> = {}

      if (myKeyPair.current) {
        const selfSharedSecret = await deriveSharedSecret(myKeyPair.current.privateKey, myKeyPair.current.publicKey)
        const encryptedKeyData = await encryptMessage(messageKeyBase64, selfSharedSecret)
        recipientKeys[userId] = encryptedKeyData
        sharedSecrets.current[userId] = selfSharedSecret
      }

      for (const [peerId, sharedSecret] of Object.entries(sharedSecrets.current)) {
        if (peerId === userId) continue
        const encryptedKeyData = await encryptMessage(messageKeyBase64, sharedSecret)
        recipientKeys[peerId] = encryptedKeyData
      }

      const payload: EncryptedPayload = {
        id: messageId,
        senderId: userId,
        timestamp,
        encryptedContent,
        contentIv,
        recipientKeys,
      }

      const newMessage = { id: messageId, senderId: userId, content, timestamp }
      setMessages((prev) => [...prev, newMessage])

      await saveMessageToStorage({ ...newMessage, groupId: roomId })

      Object.values(dataChannels.current).forEach((dc) => {
        if (dc.readyState === "open") {
          dc.send(JSON.stringify(payload))
        }
      })
    },
    [userId, roomId],
  )

  return {
    messages,
    peers,
    isConnected,
    sendMessage,
  }
}
