import type * as Actions from "@/app/actions"
import { EVENT_FEED_PAGE_SIZE, ID_PATTERN, MAX_EVENT_PACKET_LENGTH, MAX_PACKET_LENGTH, MAX_SIGNAL_PACKET_LENGTH, MESSAGE_PAGE_SIZE, PUBLIC_KEY_PATTERN, type RequestProof } from "./protocol"

type RelayAction = "message:send" | "message:list" | "message:inbox" | "message:ack" | "signal:send" | "signal:read" | "event:send" | "event:sync"
type JsonObject = Record<string, unknown>
const TIMEOUT_MS = 15_000
const UNEXPECTED = "The messaging relay returned an unexpected response. Reload Serotine and reconnect. Your saved messages are still on this browser."
const UNAVAILABLE = "The messaging relay is temporarily unavailable. Reconnect shortly. Your send has not been confirmed."

class RelayTransportError extends Error {}
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function packet(value: unknown, limit = MAX_PACKET_LENGTH): value is string {
  return typeof value === "string" && value.length >= 32 && value.length <= limit
}
function cursor(value: unknown) {
  return object(value) && typeof value.createdAt === "number" && Number.isSafeInteger(value.createdAt)
    && value.createdAt >= 0 && typeof value.id === "string" && ID_PATTERN.test(value.id)
}
function validResult(action: RelayAction, value: unknown, data: unknown, proof: RequestProof): boolean {
  if (!object(value)) return false
  if (value.success === false) {
    return typeof value.error === "string" && value.error.trim().length > 0
      && value.error.length <= 1000 && !/[<>]/.test(value.error)
      && [...value.error].every(character => character.charCodeAt(0) >= 32)
  }
  if (value.success !== true) return false
  if (action === "signal:read") {
    return value.signal === null || (object(value.signal) && packet(value.signal.encryptedData, MAX_SIGNAL_PACKET_LENGTH))
  }
  if (action === "event:sync") {
    const after = object(data) && typeof data.after === "number" ? data.after : 0
    if (!Array.isArray(value.messages) || value.messages.length > EVENT_FEED_PAGE_SIZE
      || typeof value.nextCursor !== "number" || !Number.isSafeInteger(value.nextCursor) || value.nextCursor < after
      || typeof value.hasMore !== "boolean" || (value.hasMore && value.messages.length !== EVENT_FEED_PAGE_SIZE)) return false
    let previous = after
    for (const message of value.messages) {
      if (!object(message) || typeof message.id !== "string" || !ID_PATTERN.test(message.id)
        || typeof message.senderPubKey !== "string" || !PUBLIC_KEY_PATTERN.test(message.senderPubKey)
        || typeof message.recipientPubKey !== "string" || !PUBLIC_KEY_PATTERN.test(message.recipientPubKey)
        || (message.senderPubKey !== proof.publicKey && message.recipientPubKey !== proof.publicKey)
        || !packet(message.encryptedData, MAX_EVENT_PACKET_LENGTH)
        || typeof message.createdAt !== "number" || !Number.isSafeInteger(message.createdAt) || message.createdAt < 0
        || typeof message.sequence !== "number" || !Number.isSafeInteger(message.sequence) || message.sequence <= previous) return false
      previous = message.sequence
    }
    return value.nextCursor === previous
  }
  if (action === "message:list" || action === "message:inbox") {
    return Array.isArray(value.messages) && value.messages.length <= MESSAGE_PAGE_SIZE
      && (value.nextCursor === null || (cursor(value.nextCursor)
        && (action !== "message:inbox" || (object(value.nextCursor)
          && typeof value.nextCursor.senderPubKey === "string" && PUBLIC_KEY_PATTERN.test(value.nextCursor.senderPubKey)))))
      && value.messages.every(message => object(message)
        && typeof message.id === "string" && ID_PATTERN.test(message.id)
        && typeof message.senderPubKey === "string" && PUBLIC_KEY_PATTERN.test(message.senderPubKey)
        && typeof message.recipientPubKey === "string" && PUBLIC_KEY_PATTERN.test(message.recipientPubKey)
        && packet(message.encryptedData) && typeof message.createdAt === "number"
        && Number.isSafeInteger(message.createdAt) && message.createdAt >= 0)
  }
  return true
}

async function relay<Result>(action: RelayAction, data: unknown, proof: RequestProof): Promise<Result> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new RelayTransportError("The messaging relay took too long to respond. Reconnect and retry. Your send has not been confirmed."))
    }, TIMEOUT_MS)
  })
  try {
    // One request only: a lost response must never silently replay a signed write.
    return await Promise.race([timeout, (async () => {
      const response = await fetch("/api/relay", {
        method: "POST", mode: "same-origin", credentials: "same-origin", redirect: "error", cache: "no-store",
        headers: { "Content-Type": "application/json", Accept: "application/json",
          ...(action.startsWith("event:") ? { "X-Serotine-Events": "1" } : {}) },
        body: JSON.stringify({ version: 2, action, data, proof }), signal: controller.signal,
      })
      if (response.status === 404) {
        throw new RelayTransportError("This server is missing the messaging relay. Reload Serotine; if this continues, the site owner needs to update the deployment.")
      }
      if (response.status >= 500) throw new RelayTransportError(UNAVAILABLE)
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
        throw new RelayTransportError(UNEXPECTED)
      }
      let result: unknown
      try { result = await response.json() }
      catch { throw new RelayTransportError(UNEXPECTED) }
      if (!validResult(action, result, data, proof)) throw new RelayTransportError(UNEXPECTED)
      if (!response.ok && (result as JsonObject).success !== false) throw new RelayTransportError(UNEXPECTED)
      return result as Result
    })()])
  } catch (error) {
    if (error instanceof RelayTransportError) throw error
    throw new RelayTransportError("Could not reach the messaging relay. Check your connection and retry. Your send has not been confirmed.")
  } finally {
    clearTimeout(timer)
    // Also close an unread HTML/error body rejected from its response headers.
    controller.abort()
  }
}

// Type-only references keep the existing contracts without bundling Server Action IDs.
export const storeEncryptedMessage: typeof Actions.storeEncryptedMessage = (data, proof) => relay("message:send", data, proof)
export const getMyMessages: typeof Actions.getMyMessages = (data, proof) => relay("message:list", data, proof)
export const deleteMessage: typeof Actions.deleteMessage = (data, proof) => relay("message:ack", data, proof)
export const storeSignal: typeof Actions.storeSignal = (data, proof) => relay("signal:send", data, proof)
export const getSignal: typeof Actions.getSignal = (data, proof) => relay("signal:read", data, proof)
export const storeEncryptedEvent: typeof Actions.storeEncryptedEvent = (data, proof) => relay("event:send", data, proof)
export const getEventFeed: typeof Actions.getEventFeed = (data, proof) => relay("event:sync", data, proof)
export const getLegacyInbox: typeof Actions.getLegacyInbox = (data, proof) => relay("message:inbox", data, proof)
