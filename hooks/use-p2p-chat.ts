import { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { storeSignal, getSignal, storeEncryptedMessage, getMyMessages, deleteMessage, deleteOldSignals } from '@/app/actions';
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

  // Helper to set up P2P connection and signaling
  const setupP2PConnection = async (context: P2PSetupContext) => {
    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      peerRef.current = pc;

      const signalId = `${context.myPubHex}_to_${context.targetPubKey}`;
      const answerSignalId = `${context.targetPubKey}_to_${context.myPubHex}`;
      const allCandidates: RTCIceCandidate[] = [];

      const storeCandidates = async () => {
        if (allCandidates.length === 0) return;
        await storeSignal({
          messageId: signalId,
          recipientUIDs: JSON.stringify([context.targetPubKey]),
          senderEphemeralPublicKey: context.myPubHex,
          iceCandidates: JSON.stringify(allCandidates),
        });
      };
      storeCandidatesRef.current = storeCandidates;

      pc.onicecandidate = async (e) => {
        if (e.candidate) {
          allCandidates.push(e.candidate);
          if (storeTimeoutRef.current) clearTimeout(storeTimeoutRef.current);
          storeTimeoutRef.current = setTimeout(storeCandidates, 250);
        }
      };

      const dc = pc.createDataChannel('chat');
      dataChannelRef.current = dc;

      dc.onopen = context.onDataChannelOpen;
      dc.onclose = context.onDataChannelClose;
      dc.onmessage = async (e) => {
        const msg = JSON.parse(e.data) as ChatMessage;
        await context.onMessage(msg);
      };

      pc.ondatachannel = (e) => {
        const receiveDc = e.channel;
        receiveDc.onmessage = dc.onmessage;
        receiveDc.onopen = dc.onopen;
        receiveDc.onclose = dc.onclose;
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await storeSignal({
        messageId: signalId,
        recipientUIDs: JSON.stringify([context.targetPubKey]),
        senderEphemeralPublicKey: context.myPubHex,
        offerSDP: JSON.stringify(offer),
      });

      let answerApplied = false;
      const answerPoll: ReturnType<typeof setInterval> = setInterval(async () => {
        if (answerApplied) {
          clearInterval(answerPoll);
          return;
        }

        const res = await getSignal(answerSignalId);
        if (res.success && res.signal?.answerSDP) {
          answerApplied = true;
          clearInterval(answerPoll);

          const answer = JSON.parse(res.signal.answerSDP) as RTCSessionDescriptionInit;
          await pc.setRemoteDescription(new RTCSessionDescription(answer));

          if (res.signal.iceCandidates) {
            const candidates: RTCIceCandidateInit[] = JSON.parse(res.signal.iceCandidates);
            for (const c of candidates) {
              await pc.addIceCandidate(new RTCIceCandidate(c));
            }
          }
        }
      }, 2000);

      setTimeout(async () => {
        clearInterval(answerPoll);
        if (dc.readyState !== 'open') {
          await context.onAnswerTimeout(pc);
        }
      }, 10000);
    } catch (err) {
      if (peerRef.current) peerRef.current.close();
      throw err;
    }
  };

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
