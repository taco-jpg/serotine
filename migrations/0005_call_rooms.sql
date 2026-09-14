-- Ephemeral room membership/signaling; minimal authority checkpoints prevent rollback.
CREATE TABLE IF NOT EXISTS CallRoomAuthority (
    scopeId TEXT PRIMARY KEY, kind TEXT NOT NULL, signature TEXT NOT NULL, checkpointJson TEXT NOT NULL, stateJson TEXT
  );

CREATE TABLE IF NOT EXISTS CallRoomMember (
    publicKey TEXT PRIMARY KEY, roomId TEXT NOT NULL, scopeId TEXT NOT NULL, channelId TEXT,
    sessionId TEXT NOT NULL, mode TEXT NOT NULL, policy TEXT NOT NULL, joinedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_call_room_member_room ON CallRoomMember(roomId, expiresAt);

CREATE INDEX IF NOT EXISTS idx_call_room_member_expiry ON CallRoomMember(expiresAt);

CREATE TABLE IF NOT EXISTS CallRoomSignal (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, roomId TEXT NOT NULL,
    sender TEXT NOT NULL, recipient TEXT NOT NULL, senderSession TEXT NOT NULL, targetSession TEXT NOT NULL,
    expiresAt INTEGER NOT NULL, encryptedData TEXT NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_call_room_signal_recipient ON CallRoomSignal(recipient, sequence);

CREATE INDEX IF NOT EXISTS idx_call_room_signal_expiry ON CallRoomSignal(expiresAt);
