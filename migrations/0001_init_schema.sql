-- Create P2PSignal table for WebRTC signaling
CREATE TABLE IF NOT EXISTS P2PSignal (
  id TEXT PRIMARY KEY,
  messageId TEXT UNIQUE NOT NULL,
  recipientUIDs TEXT NOT NULL,
  senderEphemeralPublicKey TEXT NOT NULL,
  offerSDP TEXT,
  answerSDP TEXT,
  iceCandidates TEXT,
  createdAt TEXT NOT NULL
);

-- Create index on messageId for fast lookups
CREATE INDEX IF NOT EXISTS idx_p2psignal_messageid ON P2PSignal(messageId);

-- Create Message table for encrypted relay messages
CREATE TABLE IF NOT EXISTS Message (
  id TEXT PRIMARY KEY,
  receiverPubKeyHash TEXT NOT NULL,
  encryptedData TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

-- Create index on receiverPubKeyHash for fast lookups
CREATE INDEX IF NOT EXISTS idx_message_receiver ON Message(receiverPubKeyHash);

-- Create index on expiresAt for cleanup queries
CREATE INDEX IF NOT EXISTS idx_message_expiresat ON Message(expiresAt);
