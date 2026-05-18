import { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { storeSignal, getSignal, storeEncryptedMessage, getMyMessages, deleteMessage } from '@/app/actions';
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

export function useP2PChat(targetPubKey: string) {
  const [status, setStatus] = useState<Status>('connecting');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const storeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const storeCandidatesRef = useRef<(() => Promise<void>) | null>(null);
  const pollRelayRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollBackoffRef = useRef<number>(3000); // Start at 3s, increases on no-message polls

  const myPrivEncRef = useRef<CryptoKey | null>(null);
  const myPubHexRef = useRef<string>('');

  useEffect(() => {
    let mounted = true;
    let answerPoll: ReturnType<typeof setInterval> | null = null;

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
        const pc = new RTCPeerConnection(RTC_CONFIG);
        peerRef.current = pc;

        const signalId = `${myPubHexRef.current}_to_${targetPubKey}`;
        const answerSignalId = `${targetPubKey}_to_${myPubHexRef.current}`;
        const allCandidates: RTCIceCandidate[] = [];

        // Debounce candidate storage to batch updates (prevents memory bloat and excess DB writes)
        const storeCandidates = async () => {
          if (allCandidates.length === 0) return;
          await storeSignal({
            messageId: signalId,
            recipientUIDs: JSON.stringify([targetPubKey]),
            senderEphemeralPublicKey: myPubHexRef.current,
            iceCandidates: JSON.stringify(allCandidates),
          });
        };
        storeCandidatesRef.current = storeCandidates;

        pc.onicecandidate = async (e) => {
          if (e.candidate) {
            allCandidates.push(e.candidate);
            // Debounce: batch candidate updates every 250ms
            if (storeTimeoutRef.current) clearTimeout(storeTimeoutRef.current);
            storeTimeoutRef.current = setTimeout(storeCandidates, 250);
          }
        };

        // Create Data Channel
        const dc = pc.createDataChannel('chat');
        dataChannelRef.current = dc;

        dc.onopen = () => {
          if (mounted) {
            setStatus('online');
            clearRelayPolling();
          }
        };
        dc.onclose = async () => {
          if (mounted) {
            setStatus('relay');
            pollBackoffRef.current = 3000; // Reset backoff when P2P fails
            setupRelayPolling();
          }
          // Immediately poll for relay messages when P2P connection fails
          await pollRelayMessages();
        };

        dc.onmessage = async (e) => {
          const msg = JSON.parse(e.data) as ChatMessage;
          if (mounted) {
            setMessages(prev => [...prev, msg]);
            await saveMessageToStorage(msg);
          }
        };

        pc.ondatachannel = (e) => {
          const receiveDc = e.channel;
          receiveDc.onmessage = dc.onmessage;
          receiveDc.onopen = dc.onopen;
          receiveDc.onclose = dc.onclose;
        };

        // Store our offer in D1
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await storeSignal({
          messageId: signalId,
          recipientUIDs: JSON.stringify([targetPubKey]),
          senderEphemeralPublicKey: myPubHexRef.current,
          offerSDP: JSON.stringify(offer),
        });

        // Poll for the answer from the remote peer
        let answerApplied = false;
        answerPoll = setInterval(async () => {
          if (answerApplied || !mounted) {
            if (answerPoll) clearInterval(answerPoll);
            return;
          }

          const res = await getSignal(answerSignalId);
          if (res.success && res.signal?.answerSDP) {
            answerApplied = true;
            if (answerPoll) clearInterval(answerPoll);

            const answer = JSON.parse(res.signal.answerSDP) as RTCSessionDescriptionInit;
            await pc.setRemoteDescription(new RTCSessionDescription(answer));

            // Apply any ICE candidates the peer already stored
            if (res.signal.iceCandidates) {
              const candidates: RTCIceCandidateInit[] = JSON.parse(res.signal.iceCandidates);
              for (const c of candidates) {
                await pc.addIceCandidate(new RTCIceCandidate(c));
              }
            }
          }
        }, 2000);

        // Fall back to relay after 10 s if P2P never completes
        setTimeout(async () => {
          if (answerPoll) clearInterval(answerPoll);
          if (mounted && dc.readyState !== 'open') {
            setStatus('relay');
            pollBackoffRef.current = 3000; // Reset backoff when timeout fallback occurs
            setupRelayPolling();
            // Immediately poll for relay messages when timeout-based fallback occurs
            await pollRelayMessages();
          }
        }, 10000);

      } catch {
        if (mounted) {
          setStatus('relay');
          setupRelayPolling();
        }
      }
    };

    const pollRelayMessages = async () => {
      if (!myPubHexRef.current || !myPrivEncRef.current) return;

      const res = await getMyMessages(myPubHexRef.current);
      if (res.success && res.messages && res.messages.length > 0) {
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
        // Increase backoff exponentially (max 30s) when no messages are found
        pollBackoffRef.current = Math.min(pollBackoffRef.current * 1.5, 30000);
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

    init();

    return () => {
      mounted = false;
      clearRelayPolling();
      if (answerPoll) clearInterval(answerPoll);
      if (storeTimeoutRef.current) clearTimeout(storeTimeoutRef.current);
      // Flush any pending ICE candidates before cleanup
      if (storeCandidatesRef.current) {
        storeCandidatesRef.current().catch(() => {
          // Silently ignore errors during cleanup
        });
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
