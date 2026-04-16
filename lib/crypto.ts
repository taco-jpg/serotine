// Cryptographic utilities for the application

// Generate a new ECDH key pair for encryption
export async function generateEncryptionKeyPair() {
  return await window.crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    ["deriveKey", "deriveBits"],
  )
}

// Generate a new ECDSA key pair for signing
export async function generateSigningKeyPair() {
  return await window.crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve: "P-256",
    },
    true,
    ["sign", "verify"],
  )
}

// Export a key to JWK format (for storage)
export async function exportKey(key: CryptoKey) {
  return await window.crypto.subtle.exportKey("jwk", key)
}

// Import a key from JWK format
export async function importKey(jwk: JsonWebKey, type: "encryption" | "signing", usage: "public" | "private") {
  const algorithm =
    type === "encryption" ? { name: "ECDH", namedCurve: "P-256" } : { name: "ECDSA", namedCurve: "P-256" }

  const usages: KeyUsage[] =
    type === "encryption"
      ? usage === "public"
        ? []
        : ["deriveKey", "deriveBits"]
      : usage === "public"
        ? ["verify"]
        : ["sign"]

  return await window.crypto.subtle.importKey("jwk", jwk, algorithm, true, usages)
}

// Convert ArrayBuffer to Hex string (for UIDs)
export function arrayBufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Convert Hex string to ArrayBuffer
export function hexToArrayBuffer(hex: string): ArrayBuffer {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string")
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return bytes.buffer
}

// Export public key to raw hex format (used as UID)
export async function exportPublicKeyToHex(key: CryptoKey) {
  const raw = await window.crypto.subtle.exportKey("raw", key)
  return arrayBufferToHex(raw)
}

// Import public key from raw hex format
export async function importPublicKeyFromHex(hex: string, type: "encryption" | "signing") {
  const format = "raw"
  const algorithm = type === "encryption" ? { name: "ECDH", namedCurve: "P-256" } : { name: "ECDSA", namedCurve: "P-256" }
  const buffer = hexToArrayBuffer(hex)
  const usages: KeyUsage[] = type === "encryption" ? [] : ["verify"]
  return await window.crypto.subtle.importKey(format, buffer, algorithm, true, usages)
}

// Sign a challenge string
export async function signChallenge(challenge: string, privateKey: CryptoKey): Promise<string> {
  const encoded = new TextEncoder().encode(challenge)
  const signature = await window.crypto.subtle.sign(
    {
      name: "ECDSA",
      hash: { name: "SHA-256" },
    },
    privateKey,
    encoded
  )
  return arrayBufferToHex(signature)
}

// Verify a challenge signature
export async function verifySignature(challenge: string, signatureHex: string, publicKey: CryptoKey | string): Promise<boolean> {
  const key = typeof publicKey === "string" ? await importPublicKeyFromHex(publicKey, "signing") : publicKey
  const encoded = new TextEncoder().encode(challenge)
  const signature = hexToArrayBuffer(signatureHex)
  
  return await window.crypto.subtle.verify(
    {
      name: "ECDSA",
      hash: { name: "SHA-256" },
    },
    key,
    signature,
    encoded
  )
}

// Convert ArrayBuffer to Base64 string
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = ""
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return window.btoa(binary)
}

// Convert Base64 string to ArrayBuffer
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary_string = window.atob(base64)
  const len = binary_string.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i)
  }
  return bytes.buffer
}

// Derive a shared secret using ECDH (P-256)
export async function deriveSharedSecret(privateKey: CryptoKey, publicKey: CryptoKey) {
  return await window.crypto.subtle.deriveKey(
    {
      name: "ECDH",
      public: publicKey,
    },
    privateKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    true,
    ["encrypt", "decrypt"],
  )
}

// Encrypt a message using AES-GCM
export async function encryptMessage(message: string, key: CryptoKey) {
  const encoded = new TextEncoder().encode(message)
  const iv = window.crypto.getRandomValues(new Uint8Array(12))

  const ciphertext = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv,
    },
    key,
    encoded,
  )

  return {
    ciphertext: arrayBufferToBase64(ciphertext),
    iv: arrayBufferToBase64(iv.buffer),
  }
}

// Decrypt a message using AES-GCM
export async function decryptMessage(ciphertext: string, iv: string, key: CryptoKey) {
  const decodedCiphertext = base64ToArrayBuffer(ciphertext)
  const decodedIv = base64ToArrayBuffer(iv)

  const decrypted = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodedIv,
    },
    key,
    decodedCiphertext,
  )

  return new TextDecoder().decode(decrypted)
}

// High level point-to-point encryption for Relays
export async function encryptForPeer(message: string, privateKey: CryptoKey, targetPubKeyHex: string): Promise<string> {
  const targetPubKey = await importPublicKeyFromHex(targetPubKeyHex, "encryption")
  const sharedSecret = await deriveSharedSecret(privateKey, targetPubKey)
  const { ciphertext, iv } = await encryptMessage(message, sharedSecret)
  // Pack IV and ciphertext together
  return JSON.stringify({ ciphertext, iv })
}

// High level point-to-point decryption for Relays
export async function decryptFromPeer(packed: string, privateKey: CryptoKey, senderPubKeyHex: string): Promise<string> {
  const { ciphertext, iv } = JSON.parse(packed)
  const senderPubKey = await importPublicKeyFromHex(senderPubKeyHex, "encryption")
  const sharedSecret = await deriveSharedSecret(privateKey, senderPubKey)
  return await decryptMessage(ciphertext, iv, sharedSecret)
}
