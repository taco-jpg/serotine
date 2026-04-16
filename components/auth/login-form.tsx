"use client"

import type React from "react"
import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, Key } from "lucide-react"

import { generateEncryptionKeyPair, generateSigningKeyPair, exportPublicKeyToHex, exportKey, importKey } from "@/lib/crypto"

export function LoginForm() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasIdentity, setHasIdentity] = useState(false)

  useEffect(() => {
    const key = localStorage.getItem("serotine_identity_public")
    if (key) {
      setHasIdentity(true)
    }
  }, [])

  const handleGenerateIdentity = async () => {
    setLoading(true)
    setError(null)
    try {
      // Generate the keys
      const signKeyPair = await generateSigningKeyPair()
      const encKeyPair = await generateEncryptionKeyPair()
      
      const pubSignHex = await exportPublicKeyToHex(signKeyPair.publicKey)
      const pubEncHex = await exportPublicKeyToHex(encKeyPair.publicKey)
      
      const privSignJWK = await exportKey(signKeyPair.privateKey)
      const privEncJWK = await exportKey(encKeyPair.privateKey)
      
      // Store in localStorage (since zero-trust)
      localStorage.setItem("serotine_identity_public", pubSignHex)
      localStorage.setItem("serotine_identity_public_enc", pubEncHex)
      localStorage.setItem("serotine_identity_private", JSON.stringify(privSignJWK))
      localStorage.setItem("serotine_identity_private_enc", JSON.stringify(privEncJWK))
      
      setHasIdentity(true)
      router.push("/chat") // Redirect to chat
    } catch (err: any) {
      console.error(err)
      setError(err.message || "Failed to generate identity")
    } finally {
      setLoading(false)
    }
  }

  const handleLoadExisting = () => {
    router.push("/chat")
  }

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {hasIdentity ? (
        <div className="space-y-4">
          <Alert>
            <AlertDescription>Local identity found.</AlertDescription>
          </Alert>
          <Button onClick={handleLoadExisting} className="w-full bg-primary hover:bg-primary/90">
            Enter Chat
          </Button>
        </div>
      ) : (
        <div className="space-y-4 text-center">
          <p className="text-sm text-muted-foreground">
            Serotine uses Zero-Trust architecture. Your identity is a cryptographic key pair generated locally on this device.
          </p>
          <Button onClick={handleGenerateIdentity} className="w-full bg-primary hover:bg-primary/90" disabled={loading}>
            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <><Key className="mr-2 h-4 w-4" /> Generate Identity</>}
          </Button>
        </div>
      )}
    </div>
  )
}
