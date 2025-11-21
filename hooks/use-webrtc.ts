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
import { deleteMessage } from "@/app/actions"
import { RTC_CONFIG } from "@/config/webrtc" // Declare RTC_CONFIG here

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

  // Initialize WebRTC connection AND Encryption Keys
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
          console.log("[v0] Loaded persistent keys from storage")
        } catch (e) {
          console.error("[v0] Failed to load stored keys, generating new ones", e)
          keyPair = await generateEncryptionKeyPair()
        }
      } else {
        keyPair = await generateEncryptionKeyPair()
        const privateKeyJwk = await exportKey(keyPair.privateKey)
        const publicKeyJwk = await exportKey(keyPair.publicKey)
        localStorage.setItem(`chat_keys_${userId}`, JSON.stringify({ privateKeyJwk, publicKeyJwk }))
        console.log("[v0] Generated and saved new keys")
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

      // We use a stable device ID for this browser
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

      if (!historyLoaded.current) {
        const { data: history } = await supabase
          .from("chat_messages")
          .select("*")
          .eq("group_id", roomId)
          .order("created_at", { ascending: true })

        if (history) {
          const decryptedMessages: Message[] = []

          for (const msg of history) {
            try {
              // Find key for me
              const myKeyData = msg.recipient_keys[userId]
              if (!myKeyData) continue // Cannot decrypt

              // Candidate keys for the sender (to derive shared secret)
              const candidateKeys: CryptoKey[] = []

              // 1. If I am the sender, use my own current public key
              if (msg.sender_id === userId && myKeyPair.current) {
                candidateKeys.push(myKeyPair.current.publicKey)
              }

              // 2. Check cached peer key
              if (peerPublicKeys.current[msg.sender_id]) {
                candidateKeys.push(peerPublicKeys.current[msg.sender_id])
              }

              // 3. If we haven't found a working key yet (or just to be safe/robust),
              // fetch device keys from DB if we don't have the peer key cached,
              // or if we want to try all possible keys for that user (multi-device support).
              // For performance, we only fetch if we don't have a cached key OR if decryption failed with cached key?
              // For now, let's fetch if we don't have a cached key, or if it's not me.
              if (msg.sender_id !== userId && !peerPublicKeys.current[msg.sender_id]) {
                const { data: devices } = await supabase
                  .from("devices")
                  .select("public_key")
                  .eq("user_id", msg.sender_id)
                  .order("last_seen", { ascending: false })
                  .limit(5) // Try up to 5 recent devices

                if (devices) {
                  for (const device of devices) {
                    try {
                      const jwk = JSON.parse(device.public_key)
                      const key = await importKey(jwk, "encryption", "public")
                      candidateKeys.push(key)
                    } catch (e) {
                      console.warn("[v0] Failed to parse device key", e)
                    }
                  }
                }
              }

              let decrypted = false

              // Try to decrypt with each candidate key
              for (const senderKey of candidateKeys) {
                try {
                  if (!myKeyPair.current) continue

                  const sharedSecret = await deriveSharedSecret(myKeyPair.current.privateKey, senderKey)

                  // Try to decrypt the message key
                  const messageKeyBase64 = await decryptMessage(myKeyData.ciphertext, myKeyData.iv, sharedSecret)

                  // If we get here, the shared secret was correct!
                  // Cache this key for this user if it's not me
                  if (msg.sender_id !== userId) {
                    peerPublicKeys.current[msg.sender_id] = senderKey
                    sharedSecrets.current[msg.sender_id] = sharedSecret
                  }

                  const binaryString = window.atob(messageKeyBase64)
                  const len = binaryString.length
                  const bytes = new Uint8Array(len)
                  for (let i = 0; i < len; i++) {
                    bytes[i] = binaryString.charCodeAt(i)
                  }

                  const messageKey = await window.crypto.subtle.importKey(
                    "raw",
                    bytes.buffer,
                    { name: "AES-GCM" },
                    true,
                    ["decrypt"],
                  )
                  const content = await decryptMessage(msg.content, msg.content_iv, messageKey)

                  const decryptedMsg = {
                    id: msg.id,
                    senderId: msg.sender_id,
                    content,
                    timestamp: new Date(msg.created_at).getTime(),
                  }

                  decryptedMessages.push(decryptedMsg)

                  await saveMessageToStorage({ ...decryptedMsg, groupId: roomId })

                  // Only delete if I am the recipient (to avoid race conditions where sender deletes before recipient gets it)
                  // OR if I am the sender and I want to clean up my own sent message from server
                  // For now, we delete if we successfully decrypted and saved it.
                  // Note: This effectively makes the server storage ephemeral.
                  await deleteMessage(msg.id)

                  decrypted = true
                  break // Success!
                } catch (err) {
                  // Wrong key, try next
                  continue
                }
              }

              if (!decrypted) {
                console.warn(`[v0] Could not decrypt message ${msg.id} from ${msg.sender_id}`)
              }
            } catch (err) {
              console.warn("Failed to process historical message", err)
            }
          }

          setMessages((prev) => {
            // Merge and dedupe
            const existingIds = new Set(prev.map((m) => m.id))
            const newMsgs = decryptedMessages.filter((m) => !existingIds.has(m.id))
            return [...prev, ...newMsgs].sort((a, b) => a.timestamp - b.timestamp)
          })
          historyLoaded.current = true
        }
      }

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
            // If we haven't sent ours to them, send it back
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
              // Also broadcast my public key to the new joiner
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

            // Broadcast public key on join
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

  // Create a new peer connection and data channel (Initiator)
  const initiateConnection = async (peerId: string) => {
    if (peerConnections.current[peerId]) return

    console.log(`[v0] Initiating connection to ${peerId}`)
    const pc = createPeerConnection(peerId)

    // Create Data Channel
    const dc = pc.createDataChannel("chat")
    setupDataChannel(dc, peerId)

    // Create Offer
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    sendSignal(peerId, "offer", offer)
  }

  // Handle incoming signals (Offer, Answer, ICE Candidate)
  const handleSignal = async (peerId: string, type: string, data: any) => {
    let pc = peerConnections.current[peerId]

    if (!pc) {
      if (type !== "offer") return // Ignore answers/candidates for unknown peers
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

  // Helper to create RTCPeerConnection
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

  // Helper to setup Data Channel events
  const setupDataChannel = (dc: RTCDataChannel, peerId: string) => {
    dataChannels.current[peerId] = dc

    dc.onopen = () => {
      console.log(`[v0] Data channel open with ${peerId}`)
    }

    dc.onmessage = async (event) => {
      try {
        const payload = JSON.parse(event.data)

        // Check if it's an encrypted message
        if (payload.encryptedContent && payload.recipientKeys) {
          const encryptedKeyData = payload.recipientKeys[userId]
          const sharedSecret = sharedSecrets.current[payload.senderId]

          if (encryptedKeyData && sharedSecret) {
            try {
              // 1. Decrypt the message key
              const messageKeyBase64 = await decryptMessage(
                encryptedKeyData.ciphertext,
                encryptedKeyData.iv,
                sharedSecret,
              )

              // 2. Import the message key
              // Convert base64 back to raw bytes
              const binaryString = window.atob(messageKeyBase64)
              const len = binaryString.length
              const bytes = new Uint8Array(len)
              for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i)
              }

              const messageKey = await window.crypto.subtle.importKey("raw", bytes.buffer, { name: "AES-GCM" }, true, [
                "decrypt",
              ])

              // 3. Decrypt the content
              const content = await decryptMessage(payload.encryptedContent, payload.contentIv, messageKey)

              const newMessage = {
                id: payload.id,
                senderId: payload.senderId,
                content,
                timestamp: payload.timestamp,
              }

              await saveMessageToStorage({ ...newMessage, groupId: roomId })

              setMessages((prev) => {
                // Dedupe
                if (prev.some((m) => m.id === payload.id)) return prev
                return [...prev, newMessage]
              })
            } catch (err) {
              console.error("Decryption failed:", err)
            }
          }
        } else {
          // Legacy/Plaintext fallback
          setMessages((prev) => [...prev, payload])
        }
      } catch (e) {
        console.error("Error processing message:", e)
      }
    }
  }

  // Helper to send signals via Supabase
  const sendSignal = async (target: string, type: string, data: any) => {
    if (!channelRef.current) return
    await channelRef.current.send({
      type: "broadcast",
      event: "signal",
      payload: { sender: userId, target, type, data },
    })
  }

  // Cleanup connection
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

  // Send message to all connected peers
  const sendMessage = useCallback(
    async (content: string) => {
      if (!myKeyPair.current) return

      const messageId = uuidv4()
      const timestamp = Date.now()

      // 1. Generate a random key for this message (AES-GCM)
      const messageKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
        "encrypt",
        "decrypt",
      ])

      // 2. Encrypt the content with the message key
      const { ciphertext: encryptedContent, iv: contentIv } = await encryptMessage(content, messageKey)

      // 3. Export the message key to raw bytes so we can encrypt it
      const rawMessageKey = await window.crypto.subtle.exportKey("raw", messageKey)
      const messageKeyString = Array.from(new Uint8Array(rawMessageKey))
        .map((b) => String.fromCharCode(b))
        .join("")
      const messageKeyBase64 = window.btoa(messageKeyString)

      // 4. Encrypt the message key for each peer AND MYSELF
      const recipientKeys: Record<string, { ciphertext: string; iv: string }> = {}

      if (myKeyPair.current) {
        // ECDH with myself (MyPriv + MyPub)
        const selfSharedSecret = await deriveSharedSecret(myKeyPair.current.privateKey, myKeyPair.current.publicKey)
        const encryptedKeyData = await encryptMessage(messageKeyBase64, selfSharedSecret)
        recipientKeys[userId] = encryptedKeyData

        // Also cache this secret so I can decrypt my own history later
        sharedSecrets.current[userId] = selfSharedSecret
      }

      for (const [peerId, sharedSecret] of Object.entries(sharedSecrets.current)) {
        // Skip myself if already done
        if (peerId === userId) continue
        const encryptedKeyData = await encryptMessage(messageKeyBase64, sharedSecret)
        recipientKeys[peerId] = encryptedKeyData
      }

      // 5. Construct the payload
      const payload: EncryptedPayload = {
        id: messageId,
        senderId: userId,
        timestamp,
        encryptedContent,
        contentIv,
        recipientKeys,
      }

      // Add to local state (unencrypted)
      const newMessage = { id: messageId, senderId: userId, content, timestamp }
      setMessages((prev) => [...prev, newMessage])

      await saveMessageToStorage({ ...newMessage, groupId: roomId })

      try {
        await supabase.from("chat_messages").insert({
          id: messageId,
          group_id: roomId,
          sender_id: userId,
          content: encryptedContent,
          content_iv: contentIv,
          recipient_keys: recipientKeys,
          created_at: new Date(timestamp).toISOString(),
        })
      } catch (err) {
        console.error("Failed to persist message:", err)
      }

      // Send to all peers
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
