"use server"

import { revalidatePath } from "next/cache"
import { getPrisma } from "@/lib/prisma"

// --- SIGNALING FOR P2P ---

export async function storeSignal(data: {
  messageId: string
  recipientUIDs: string
  senderEphemeralPublicKey: string
  offerSDP?: string
  answerSDP?: string
  iceCandidates?: string
}) {
  const prisma = getPrisma()   // ← 移到这里，函数体第一行
  try {
    const signal = await prisma.p2PSignal.upsert({
      where: { messageId: data.messageId },
      update: data,
      create: data,
    })
    return { success: true, signal }
  } catch (error: any) {
    console.error("Signal store error:", error)
    return { error: error.message || "Failed to store signal" }
  }
}

export async function getSignal(messageId: string) {
  const prisma = getPrisma() 
  try {
    const signal = await prisma.p2PSignal.findUnique({
      where: { messageId }
    })
    return { success: true, signal }
  } catch (error: any) {
    console.error("Get signal error:", error)
    return { error: error.message || "Failed to get signal" }
  }
}

export async function deleteSignal(messageId: string) {
  const prisma = getPrisma() 
  try {
    await prisma.p2PSignal.delete({
      where: { messageId }
    })
    return { success: true }
  } catch (error: any) {
    console.error("Delete signal error:", error)
    return { error: error.message || "Failed to delete signal" }
  }
}

// --- OFFLINE MESSAGE RELAY ---

export async function storeEncryptedMessage(data: {
  receiverPubKeyHash: string
  encryptedData: string
}) {
  const prisma = getPrisma()   // ← 移到这里，函数体第一行
  try {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

    const msg = await prisma.message.create({
      data: {
        receiverPubKeyHash: data.receiverPubKeyHash,
        encryptedData: data.encryptedData,
        expiresAt,
      }
    })
    return { success: true, messageId: msg.id }
  } catch (error: any) {
    console.error("Store message error:", error)
    return { error: error.message || "Failed to store message" }
  }
}

export async function getMyMessages(receiverPubKeyHash: string) {
  const prisma = getPrisma() 
  try {
    const messages = await prisma.message.findMany({
      where: { receiverPubKeyHash }
    })
    return { success: true, messages }
  } catch (error: any) {
    console.error("Get messages error:", error)
    return { error: error.message || "Failed to get messages" }
  }
}

export async function deleteMessage(messageId: string) {
  const prisma = getPrisma() 
  try {
    await prisma.message.delete({
      where: { id: messageId }
    })
    return { success: true }
  } catch (error: any) {
    return { error: "Message delete failed or not found" }
  }
}
