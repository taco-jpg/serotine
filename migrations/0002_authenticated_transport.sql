-- V2 transport is separate: old unsigned packets cannot be trusted as v2 data.
-- Existing tables and browser history are preserved for an explicit migration.
CREATE TABLE IF NOT EXISTS RequestNonce (
  publicKey TEXT NOT NULL,
  nonce TEXT NOT NULL,
  action TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  PRIMARY KEY (publicKey, nonce)
);
CREATE INDEX IF NOT EXISTS idx_nonce_expiry ON RequestNonce(expiresAt);
CREATE INDEX IF NOT EXISTS idx_nonce_rate ON RequestNonce(publicKey, action, expiresAt);
CREATE TABLE IF NOT EXISTS RelayMessage (
  id TEXT NOT NULL,
  senderPubKey TEXT NOT NULL,
  recipientPubKey TEXT NOT NULL,
  encryptedData TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  PRIMARY KEY (recipientPubKey, senderPubKey, id)
);
CREATE INDEX IF NOT EXISTS idx_relay_conversation ON RelayMessage(recipientPubKey, senderPubKey, createdAt);
CREATE INDEX IF NOT EXISTS idx_relay_expiry ON RelayMessage(expiresAt);
CREATE INDEX IF NOT EXISTS idx_relay_sender ON RelayMessage(senderPubKey);
CREATE TABLE IF NOT EXISTS RelaySignal (
  senderPubKey TEXT NOT NULL,
  recipientPubKey TEXT NOT NULL,
  encryptedData TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  PRIMARY KEY (senderPubKey, recipientPubKey)
);
CREATE INDEX IF NOT EXISTS idx_signal_expiry ON RelaySignal(expiresAt);
