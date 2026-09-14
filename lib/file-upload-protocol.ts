import { ID_PATTERN } from "./protocol"

/** Plaintext file bytes; binary ciphertext is transported separately from chat events. */
export const MAX_FILE_UPLOAD_BYTES = 1024 * 1024 * 1024
export const FILE_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
export const FILE_UPLOAD_TAG_BYTES = 16
export const FILE_UPLOAD_STAGING_TTL_MS = 24 * 60 * 60 * 1000
export const FILE_UPLOAD_RETENTION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const FILE_UPLOAD_OWNER_QUOTA_BYTES = 5 * MAX_FILE_UPLOAD_BYTES
export const FILE_UPLOAD_TOTAL_QUOTA_BYTES = 50 * MAX_FILE_UPLOAD_BYTES
export const FILE_UPLOAD_HASH_PATTERN = /^[0-9a-f]{64}$/
export const isFileUploadId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value)
export const isFileUploadHash = (value: unknown): value is string => typeof value === "string" && FILE_UPLOAD_HASH_PATTERN.test(value)
export const isFileUploadObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)

export interface FileUploadConfiguration {
  success: true
  available: boolean
  maxFileBytes: number
  chunkBytes: number
  stagingTtlMs: number
  retentionTtlMs: number
}
export interface FileUploadReceipt {
  success: true
  uploadId: string
  status: "staged" | "ready" | "published" | "deleted"
  expiresAt: number
}
export function fileUploadChunkCount(size: number): number { return Math.ceil(size / FILE_UPLOAD_CHUNK_BYTES) }
export function fileUploadChunkSize(size: number, index: number): number {
  return Math.min(FILE_UPLOAD_CHUNK_BYTES, size - index * FILE_UPLOAD_CHUNK_BYTES) + FILE_UPLOAD_TAG_BYTES
}
export async function fileUploadDigest(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
}
