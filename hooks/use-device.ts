"use client"

import { useState, useEffect } from "react"
import { createClient } from "@/utils/supabase/client"
import { generateEncryptionKeyPair, generateSigningKeyPair, exportKey } from "@/lib/crypto"
import { v4 as uuidv4 } from "uuid"

export interface DeviceInfo {
  deviceId: string
  deviceName: string
  publicKey: string
  isRegistered: boolean
  isTrusted: boolean
  vouchCode?: string
}

export function useDevice() {
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    initializeDevice()
  }, [])

  const initializeDevice = async () => {
    try {
      // Check local storage for existing device info
      const storedDeviceId = localStorage.getItem("serotine_device_id")
      const storedDeviceName = localStorage.getItem("serotine_device_name")
      const storedPublicKey = localStorage.getItem("serotine_public_key")

      if (storedDeviceId && storedDeviceName && storedPublicKey) {
        // Verify if this device is actually in the DB
        const {
          data: { user },
        } = await supabase.auth.getUser()
        if (user) {
          const { data } = await supabase.from("devices").select("*").eq("device_id", storedDeviceId).single()

          setDeviceInfo({
            deviceId: storedDeviceId,
            deviceName: storedDeviceName,
            publicKey: storedPublicKey,
            isRegistered: !!data,
            isTrusted: data?.is_trusted || false,
            vouchCode: data?.vouch_code,
          })
        }
      } else {
        // No local device found
        setDeviceInfo(null)
      }
    } catch (error) {
      console.error("Error initializing device:", error)
    } finally {
      setLoading(false)
    }
  }

  const registerDevice = async (name: string, vouchCode?: string) => {
    setLoading(true)
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) throw new Error("User not authenticated")

      const { data: existingDevices } = await supabase.from("devices").select("id").eq("user_id", user.id).limit(1)

      const isFirstDevice = !existingDevices || existingDevices.length === 0

      // Generate new keys
      const encryptionKeys = await generateEncryptionKeyPair()
      const signingKeys = await generateSigningKeyPair()

      // Export public keys
      const encryptionPub = await exportKey(encryptionKeys.publicKey)
      const signingPub = await exportKey(signingKeys.publicKey)

      // Store private keys securely (in a real app, use IndexedDB or better)
      const encryptionPriv = await exportKey(encryptionKeys.privateKey)
      const signingPriv = await exportKey(signingKeys.privateKey)

      localStorage.setItem("serotine_enc_priv", JSON.stringify(encryptionPriv))
      localStorage.setItem("serotine_sign_priv", JSON.stringify(signingPriv))

      const publicKeyString = JSON.stringify(encryptionPub)
      const deviceId = uuidv4()

      let ipAddress = "unknown"
      try {
        const ipResponse = await fetch("https://api.ipify.org?format=json")
        const ipData = await ipResponse.json()
        ipAddress = ipData.ip
      } catch (e) {
        console.warn("Could not fetch IP address:", e)
      }

      const { data: deviceWithSameIP } = await supabase
        .from("devices")
        .select("ip_address")
        .eq("user_id", user.id)
        .eq("ip_address", ipAddress)
        .limit(1)

      const isSameIP = deviceWithSameIP && deviceWithSameIP.length > 0

      const { count: friendCount } = await supabase
        .from("friends")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .eq("status", "accepted")

      const hasFriends = friendCount !== null && friendCount > 0

      const shouldAutoTrust = isFirstDevice || isSameIP || !hasFriends

      // Register in DB
      const { error } = await supabase.from("devices").insert({
        user_id: user.id,
        device_name: name,
        device_id: deviceId,
        public_key: publicKeyString,
        is_trusted: shouldAutoTrust,
        vouch_code: shouldAutoTrust ? null : vouchCode,
        ip_address: ipAddress,
      })

      if (error) throw error

      // Save to local storage
      localStorage.setItem("serotine_device_id", deviceId)
      localStorage.setItem("serotine_device_name", name)
      localStorage.setItem("serotine_public_key", publicKeyString)

      setDeviceInfo({
        deviceId,
        deviceName: name,
        publicKey: publicKeyString,
        isRegistered: true,
        isTrusted: shouldAutoTrust,
        vouchCode: shouldAutoTrust ? undefined : vouchCode,
      })

      if (shouldAutoTrust) {
        window.location.reload()
      }

      return true
    } catch (error) {
      console.error("Error registering device:", error)
      throw error
    } finally {
      setLoading(false)
    }
  }

  return {
    deviceInfo,
    loading,
    registerDevice,
  }
}
