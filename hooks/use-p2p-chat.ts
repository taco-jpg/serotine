import { useState, useEffect, useRef } from 'react';
import { storeSignal, getSignal, storeEncryptedMessage, getMyMessages, deleteMessage } from '@/app/actions';
import { encryptForPeer, decryptFromPeer, importKey } from '@/lib/crypto';
import { saveMessageToStorage, getMessagesFromStorage } from '@/lib/storage';

export type Status = 'connecting' | 'online' | 'relay';

export function useP2PChat(targetPubKey: string) {
  const [status, setStatus] = useState<Status>('connecting');
  const [messages, setMessages] = useState<any[]>([]);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  
  const myPrivEncRef = useRef<CryptoKey | null>(null);
  const myPubHexRef = useRef<string>('');

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      // 1. Load keys
      const encPrivJWKStr = localStorage.getItem("serotine_identity_private_enc");
      const pubEncHex = localStorage.getItem("serotine_identity_public_enc");
      
      if (!encPrivJWKStr || !pubEncHex) return;
      myPubHexRef.current = pubEncHex;
      
      const privEncJWK = JSON.parse(encPrivJWKStr);
      myPrivEncRef.current = await importKey(privEncJWK, "encryption", "private");
      
      // Load local history
      const history = await getMessagesFromStorage(targetPubKey);
      if (mounted) setMessages(history.sort((a,b) => a.timestamp - b.timestamp));
      
      // WebRTC Setup
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        peerRef.current = pc;
        
        pc.onicecandidate = async (e) => {
          if (e.candidate) {
            // ICE Candidates handling could be added to D1 signal, keeping simple for now
          }
        };

        // Create Data Channel
        const dc = pc.createDataChannel('chat');
        dataChannelRef.current = dc;
        
        dc.onopen = () => { if (mounted) setStatus('online'); };
        dc.onclose = () => { if (mounted) setStatus('relay'); };
        
        dc.onmessage = async (e) => {
          const msg = JSON.parse(e.data);
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

        // Initiate signaling (Store offer in D1)
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const signalId = `${myPubHexRef.current}_to_${targetPubKey}`;
        
        await storeSignal({
          messageId: signalId,
          recipientUIDs: JSON.stringify([targetPubKey]),
          senderEphemeralPublicKey: myPubHexRef.current,
          offerSDP: JSON.stringify(offer)
        });

        // Timeout to relay
        setTimeout(() => {
          if (mounted && dc.readyState !== 'open') {
            setStatus('relay');
          }
        }, 5000);
      } catch (err) {
        if (mounted) setStatus('relay');
      }
    };
    init();
    
    // Polling Relay Messages
    const pollRelay = setInterval(async () => {
      if (!myPubHexRef.current || !myPrivEncRef.current) return;
      
      const res = await getMyMessages(myPubHexRef.current);
      if (res.success && res.messages) {
        for (const msg of res.messages) {
          try {
            const decryptedContent = await decryptFromPeer(msg.encryptedData, myPrivEncRef.current, targetPubKey);
            const chatMsg = {
              id: msg.id,
              peerPubKey: targetPubKey,
              senderPubKey: targetPubKey,
              content: decryptedContent,
              timestamp: new Date(msg.createdAt).getTime()
            };
            setMessages(prev => {
              if (prev.find(m => m.id === msg.id)) return prev;
              return [...prev, chatMsg].sort((a,b) => a.timestamp - b.timestamp);
            });
            await saveMessageToStorage(chatMsg);
            await deleteMessage(msg.id); // Physical deletion
          } catch(e) {
            // Ignore decryption error, might not be from this peer
          }
        }
      }
    }, 3000);

    return () => {
      mounted = false;
      clearInterval(pollRelay);
      if (peerRef.current) peerRef.current.close();
    };
  }, [targetPubKey]);

  const sendMessage = async (content: string) => {
    const timestamp = Date.now();
    const id = myPubHexRef.current + '_' + timestamp;
    const msg = {
      id,
      peerPubKey: targetPubKey,
      senderPubKey: myPubHexRef.current,
      content,
      timestamp
    };
    
    // optimistic update
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
          encryptedData: encrypted
        });
      }
    }
  };

  return { sendMessage, status, messages, myPub: myPubHexRef.current };
}
