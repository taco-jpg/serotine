-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiverPubKeyHash" TEXT NOT NULL,
    "encryptedData" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Recreate P2PSignal with correct TEXT types (replaces broken JSONB version from 0001)
DROP TABLE IF EXISTS "P2PSignal";

CREATE TABLE "P2PSignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "recipientUIDs" TEXT NOT NULL,
    "senderEphemeralPublicKey" TEXT NOT NULL,
    "offerSDP" TEXT,
    "answerSDP" TEXT,
    "iceCandidates" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Message_receiverPubKeyHash_idx" ON "Message"("receiverPubKeyHash");

-- CreateIndex
CREATE UNIQUE INDEX "P2PSignal_messageId_key" ON "P2PSignal"("messageId");
