CREATE TABLE IF NOT EXISTS GroupAuthority (
  groupId TEXT NOT NULL,
  admin TEXT NOT NULL,
  terminalAt INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (groupId, admin)
);
CREATE TABLE IF NOT EXISTS GroupInvitationStatus (
  groupId TEXT NOT NULL,
  admin TEXT NOT NULL,
  invitationId TEXT NOT NULL,
  invitee TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  status TEXT NOT NULL,
  acceptance TEXT,
  PRIMARY KEY (groupId, admin, invitationId)
);
CREATE INDEX IF NOT EXISTS idx_group_invitation_target ON GroupInvitationStatus(groupId, admin, invitee);
