'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/utils/supabase/client'
import { RealtimeChannel } from '@supabase/supabase-js'
import { v4 as uuidv4 } from 'uuid'

// Configuration for STUN servers (using Google's public ones for demo)
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ]
}

export interface Message {
  id: string
  senderId: string
  content: string
  timestamp: number
}

export function useWebRTC(roomId: string, userId: string) {
  const [messages, setMessages] = useState<Message[]>([])
  const [peers, setPeers] = useState<string[]>([])
  const [isConnected, setIsConnected] = useState(false)
  
  const supabase = createClient()
  const channelRef = useRef<RealtimeChannel | null>(null)
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({})
  const dataChannels = useRef<Record<string, RTCDataChannel>>({})

  // Initialize WebRTC connection
  useEffect(() => {
    if (!roomId || !userId) return

    const channel = supabase.channel(`room:${roomId}`)
    channelRef.current = channel

    channel
      .on('broadcast', { event: 'signal' }, async ({ payload }) => {
        if (payload.target !== userId) return // Ignore signals not meant for us

        const { sender, type, data } = payload
        await handleSignal(sender, type, data)
      })
      .on('presence', { event: 'join' }, ({ key, newPresences }) => {
        newPresences.forEach((presence: any) => {
          if (presence.user_id !== userId) {
            initiateConnection(presence.user_id)
          }
        })
      })
      .on('presence', { event: 'leave' }, ({ key, leftPresences }) => {
        leftPresences.forEach((presence: any) => {
          closeConnection(presence.user_id)
        })
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          setIsConnected(true)
          await channel.track({ user_id: userId, online_at: new Date().toISOString() })
        }
      })

    return () => {
      Object.keys(peerConnections.current).forEach(closeConnection)
      channel.unsubscribe()
    }
  }, [roomId, userId])

  // Create a new peer connection and data channel (Initiator)
  const initiateConnection = async (peerId: string) => {
    if (peerConnections.current[peerId]) return

    console.log(`[v0] Initiating connection to ${peerId}`)
    const pc = createPeerConnection(peerId)
    
    // Create Data Channel
    const dc = pc.createDataChannel('chat')
    setupDataChannel(dc, peerId)
    
    // Create Offer
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    
    sendSignal(peerId, 'offer', offer)
  }

  // Handle incoming signals (Offer, Answer, ICE Candidate)
  const handleSignal = async (peerId: string, type: string, data: any) => {
    let pc = peerConnections.current[peerId]

    if (!pc) {
      if (type !== 'offer') return // Ignore answers/candidates for unknown peers
      pc = createPeerConnection(peerId)
    }

    switch (type) {
      case 'offer':
        await pc.setRemoteDescription(new RTCSessionDescription(data))
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        sendSignal(peerId, 'answer', answer)
        break
      
      case 'answer':
        await pc.setRemoteDescription(new RTCSessionDescription(data))
        break
      
      case 'candidate':
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data))
        } catch (e) {
          console.error('Error adding received ice candidate', e)
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
        sendSignal(peerId, 'candidate', event.candidate)
      }
    }

    pc.ondatachannel = (event) => {
      setupDataChannel(event.channel, peerId)
    }

    pc.onconnectionstatechange = () => {
      console.log(`[v0] Connection state with ${peerId}: ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        setPeers(prev => [...prev, peerId])
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
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

    dc.onmessage = (event) => {
      const message = JSON.parse(event.data)
      setMessages(prev => [...prev, message])
    }
  }

  // Helper to send signals via Supabase
  const sendSignal = async (target: string, type: string, data: any) => {
    if (!channelRef.current) return
    await channelRef.current.send({
      type: 'broadcast',
      event: 'signal',
      payload: { sender: userId, target, type, data }
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
    setPeers(prev => prev.filter(id => id !== peerId))
  }

  // Send message to all connected peers
  const sendMessage = useCallback((content: string) => {
    const message: Message = {
      id: uuidv4(),
      senderId: userId,
      content,
      timestamp: Date.now()
    }

    // Add to local state
    setMessages(prev => [...prev, message])

    // Send to all peers
    Object.values(dataChannels.current).forEach(dc => {
      if (dc.readyState === 'open') {
        dc.send(JSON.stringify(message))
      }
    })
  }, [userId])

  return {
    messages,
    peers,
    isConnected,
    sendMessage
  }
}
