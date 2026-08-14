import { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { storeSignal, getSignal, deleteSignal, storeEncryptedMessage, getMyMessages, deleteMessage, deleteOldSignals } from '@/app/actions';
import { encryptForPeer, decryptFromPeer, importKey } from '@/lib/crypto';
import { saveMessageToStorage, getMessagesFromStorage } from '@/lib/storage';
import { RTC_CONFIG } from '@/config/webrtc';

export type Status = 'connecting' | 'online' | 'relay';

export interface ChatMessage {
  id: string
  peerPubKey: string
  senderPubKey: string
  content: string
  timestamp: number
}

interface P2PSetupContext {
  myPubHex: string
  targetPubKey: string
  onDataChannelOpen: () => void
  onDataChannelClose: () => Promise<void>
  onMessage: (msg: ChatMessage) => Promise<void>
  onAnswerTimeout: (pc: RTCPeerConnection) => Promise<void>
}

export function useP2PChat(targetPubKey: string) {
  const [status, setStatus] = useState<Status>('connecting');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const storeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storeCandidatesRef = useRef<(() => Promise<void>) | null>(null);
  const pollRelayRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollBackoffRef = useRef<number>(3000); // Start at 3s, increases on no-message polls
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectBackoffRef = useRef<number>(3000); // Start at 3s, increases on failed reconnection attempts

  const myPrivEncRef = useRef<CryptoKey | null>(null);
  const myPubHexRef = useRef<string>('');

  // Elect exactly one offerer. Previously both peers created offers and then waited
  // for answers that neither side ever produced.
  const setupP2PConnection = async (context: P2PSetupContext) => {
    const pc = new RTCPeerConnection(RTC_CONFIG)
    peerRef.current?.close()
    peerRef.current = pc

    const offerSignalId = `${context.myPubHex < context.targetPubKey ? context.myPubHex : context.targetPubKey}_to_${context.myPubHex < context.targetPubKey ? context.targetPubKey : context.myPubHex}`
    const answerSignalId = `${context.myPubHex < context.targetPubKey ? context.targetPubKey : context.myPubHex}_to_${context.myPubHex < context.targetPubKey ? context.myPubHex : context.targetPubKey}`
    const isOfferer = context.myPubHex < context.targetPubKey

    const attachChannel = (channel: RTCDataChannel) => {
      dataChannelRef.current = channel
      channel.onopen = context.onDataChannelOpen
      channel.onclose = context.onDataChannelClose
      channel.onmessage = async (event) => {
        try {
          const message = JSON.parse(event.data) as ChatMessage
          if (message.peerPubKey !== context.myPubHex || message.senderPubKey !== context.targetPubKey) return
          await context.onMessage(message)
        } catch {
          // Ignore malformed or unrelated channel payloads.
        }
      }
    }

    const waitForIce = () => new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') return resolve()
      const timeout = setTimeout(resolve, 4000)
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeout)
          resolve()
        }
      })
    })

    try {
      if (isOfferer) {
        // Clear the previous negotiation so the answerer cannot consume stale SDP.
        await Promise.all([deleteSignal(offerSignalId), deleteSignal(answerSignalId)])
        attachChannel(pc.createDataChannel('chat'))
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await waitForIce()
        await storeSignal({
          messageId: offerSignalId,
          recipientUIDs: JSON.stringify([context.targetPubKey]),
          senderEphemeralPublicKey: context.myPubHex,
          offerSDP: JSON.stringify(pc.localDescription),
        })

        const deadline = Date.now() + 12_000
        while (Date.now() < deadline && pc.signalingState !== 'closed') {
          const response = await getSignal(answerSignalId)
          if (response.success && response.signal?.answerSDP) {
            await pc.setRemoteDescription(JSON.parse(response.signal.answerSDP) as RTCSessionDescriptionInit)
            return
          }
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      } else {
        pc.ondatachannel = event => attachChannel(event.channel)
        const deadline = Date.now() + 12_000
        while (Date.now() < deadline && pc.signalingState !== 'closed') {
          const response = await getSignal(offerSignalId)
          if (response.success && response.signal?.offerSDP) {
            await pc.setRemoteDescription(JSON.parse(response.signal.offerSDP) as RTCSessionDescriptionInit)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await waitForIce()
            await storeSignal({
              messageId: answerSignalId,
              recipientUIDs: JSON.stringify([context.targetPubKey]),
              senderEphemeralPublicKey: context.myPubHex,
              answerSDP: JSON.stringify(pc.localDescription),
            })
            return
          }
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
      }

      await context.onAnswerTimeout(pc)
    } catch (error) {
      pc.close()
      throw error
    }
  }

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      // 1. Load keys
      const encPrivJWKStr = localStorage.getItem('serotine_identity_private_enc');
      const pubEncHex = localStorage.getItem('serotine_identity_public_enc');

      if (!encPrivJWKStr || !pubEncHex) return;
      myPubHexRef.current = pubEncHex;

      const privEncJWK = JSON.parse(encPrivJWKStr);
      myPrivEncRef.current = await importKey(privEncJWK, 'encryption', 'private');

      // Load local history
      const history = await getMessagesFromStorage(targetPubKey);
      if (mounted) setMessages(history.sort((a, b) => a.timestamp - b.timestamp));

      // WebRTC Setup
      try {
        await setupP2PConnection({
          myPubHex: myPubHexRef.current,
          targetPubKey,
          onDataChannelOpen: () => {
            if (mounted) {
              setStatus('online');
              clearRelayPolling();
              void deleteOldSignals(7).catch((error) => {
                console.error('Failed to delete old signals', error);
              });
            }
          },
          onDataChannelClose: async () => {
            if (mounted) {
              setStatus('relay');
              pollBackoffRef.current = 3000;
              setupRelayPolling();
            }
            await pollRelayMessages();
          },
          onMessage: async (msg) => {
            if (mounted) {
              setMessages(prev => [...prev, msg]);
              await saveMessageToStorage(msg);
            }
          },
          onAnswerTimeout: async (_pc) => {
            if (mounted && dataChannelRef.current?.readyState !== 'open') {
              setStatus('relay');
              pollBackoffRef.current = 3000;
              setupRelayPolling();
              await pollRelayMessages();
              scheduleReconnection();
            }
          },
        });
      } catch {
        if (mounted) {
          setStatus('relay');
          setupRelayPolling();
          scheduleReconnection();
        }
      }
    };

    const pollRelayMessages = async () => {
      if (!myPubHexRef.current || !myPrivEncRef.current) return;

      const res = await getMyMessages(myPubHexRef.current);
      if (res.success) {
        if (res.messages && res.messages.length > 0) {
          // Reset backoff when messages are found
          pollBackoffRef.current = 3000;
          for (const msg of res.messages) {
            try {
              const decryptedContent = await decryptFromPeer(msg.encryptedData, myPrivEncRef.current, targetPubKey);
              const chatMsg = {
                id: msg.id,
                peerPubKey: targetPubKey,
                senderPubKey: targetPubKey,
                content: decryptedContent,
                timestamp: new Date(msg.createdAt).getTime(),
              };
              if (mounted) {
                setMessages(prev => {
                  if (prev.find(m => m.id === msg.id)) return prev;
                  return [...prev, chatMsg].sort((a, b) => a.timestamp - b.timestamp);
                });
              }
              await saveMessageToStorage(chatMsg);
              await deleteMessage(msg.id);
            } catch {
              // Ignore decryption errors — message may be from a different peer
            }
          }
        } else {
          // Increase backoff exponentially (max 30s) when no messages found
          pollBackoffRef.current = Math.min(pollBackoffRef.current * 1.5, 30000);
        }
      }
    };

    const setupRelayPolling = () => {
      if (pollRelayRef.current) clearTimeout(pollRelayRef.current);

      const scheduleNextPoll = async () => {
        await pollRelayMessages();
        if (mounted) {
          pollRelayRef.current = setTimeout(scheduleNextPoll, pollBackoffRef.current);
        }
      };

      pollRelayRef.current = setTimeout(scheduleNextPoll, pollBackoffRef.current);
    };

    const clearRelayPolling = () => {
      if (pollRelayRef.current) {
        clearTimeout(pollRelayRef.current);
        pollRelayRef.current = null;
      }
    };

    const clearReconnectTimeout = () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const attemptP2PReconnection = async () => {
      if (!mounted || !myPrivEncRef.current || !myPubHexRef.current) return;

      try {
        await setupP2PConnection({
          myPubHex: myPubHexRef.current,
          targetPubKey,
          onDataChannelOpen: () => {
            if (mounted) {
              setStatus('online');
              reconnectBackoffRef.current = 3000;
              clearRelayPolling();
              clearReconnectTimeout();
              void deleteOldSignals(7).catch((error) => {
                console.error('Failed to delete old signals', error);
              });
            }
          },
          onDataChannelClose: async () => {
            if (mounted) {
              setStatus('relay');
              pollBackoffRef.current = 3000;
              reconnectBackoffRef.current = 3000;
              setupRelayPolling();
              scheduleReconnection();
            }
            await pollRelayMessages();
          },
          onMessage: async (msg) => {
            if (mounted) {
              setMessages(prev => [...prev, msg]);
              await saveMessageToStorage(msg);
            }
          },
          onAnswerTimeout: async (pc) => {
            pc.close();
            if (mounted) {
              setStatus('relay');
              pollBackoffRef.current = 3000;
              setupRelayPolling();
              await pollRelayMessages();
              scheduleReconnection();
            }
          },
        });
      } catch {
        if (mounted) {
          setStatus('relay');
          setupRelayPolling();
          scheduleReconnection();
        }
      }
    };

    const scheduleReconnection = () => {
      if (!mounted) return;
      clearReconnectTimeout();
      reconnectBackoffRef.current = Math.min(reconnectBackoffRef.current * 1.5, 30000);
      reconnectTimeoutRef.current = setTimeout(attemptP2PReconnection, reconnectBackoffRef.current);
    };

    init();

    return () => {
      mounted = false;
      clearRelayPolling();
      clearReconnectTimeout();
      if (storeTimeoutRef.current) clearTimeout(storeTimeoutRef.current);
      if (storeCandidatesRef.current) {
        storeCandidatesRef.current().catch(() => {});
      }
      if (peerRef.current) peerRef.current.close();
    };
  }, [targetPubKey]);

  const sendMessage = async (content: string) => {
    const timestamp = Date.now();
    const id = uuidv4();
    const msg = {
      id,
      peerPubKey: targetPubKey,
      senderPubKey: myPubHexRef.current,
      content,
      timestamp,
    };

    // Optimistic update
    setMessages(prev => [...prev, msg]);
    await saveMessageToStorage(msg);

    if (status === 'online' && dataChannelRef.current?.readyState === 'open') {
      // Direct WebRTC
      dataChannelRef.current.send(JSON.stringify(msg));
    } else {
      // Fallback D1 Relay
      if (myPrivEncRef.current) {
        const encrypted = await encryptForPeer(content, myPrivEncRef.current, targetPubKey);
        await storeEncryptedMessage({
          receiverPubKeyHash: targetPubKey,
          encryptedData: encrypted,
        });
      }
    }
  };

  return { sendMessage, status, messages, myPub: myPubHexRef.current };
}
