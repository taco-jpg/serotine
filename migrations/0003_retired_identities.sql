-- Revocations have no expiry. Do not remove them when cleaning message history.
CREATE TABLE IF NOT EXISTS RetiredIdentity (
  publicKey TEXT PRIMARY KEY,
  retiredAt INTEGER NOT NULL
);
