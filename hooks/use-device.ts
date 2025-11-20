'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/utils/supabase/client'
import { generateEncryptionKeyPair, generateSigningKeyPair, exportKey } from '@/lib/crypto'
import { v4 as uuidv4 } from 'uuid'

export interface DeviceInfo {
  deviceId: string
  deviceName: string
  publicKey: string
  isRegistered: boolean
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
      const storedDeviceId = localStorage.getItem('serotine_device_id')
      const storedDeviceName = localStorage.getItem('serotine_device_name')
      const storedPublicKey = localStorage.getItem('serotine_public_key')

      if (storedDeviceId && storedDeviceName && storedPublicKey) {
        // Verify if this device is actually in the DB
        const { data: { user } } = await supabase.auth.getUser()
        if (user) {
          const { data } = await supabase
            .from('devices')
            .select('id')
            .eq('device_id', storedDeviceId)
            .single()

          setDeviceInfo({
            deviceId: storedDeviceId,
            deviceName: storedDeviceName,
            publicKey: storedPublicKey,
            isRegistered: !!data
          })
        }
      } else {
        // No local device found
        setDeviceInfo(null)
      }
    } catch (error) {
      console.error('Error initializing device:', error)
    } finally {
      setLoading(false)
    }
  }

  const registerDevice = async (name: string) => {
    setLoading(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('User not authenticated')

      // Generate new keys
      const encryptionKeys = await generateEncryptionKeyPair()
      const signingKeys = await generateSigningKeyPair()

      // Export public keys
      const encryptionPub = await exportKey(encryptionKeys.publicKey)
      const signingPub = await exportKey(signingKeys.publicKey)
      
      // Store private keys securely (in a real app, use IndexedDB or better)
      const encryptionPriv = await exportKey(encryptionKeys.privateKey)
      const signingPriv = await exportKey(signingKeys.privateKey)
      
      localStorage.setItem('serotine_enc_priv', JSON.stringify(encryptionPriv))
      localStorage.setItem('serotine_sign_priv', JSON.stringify(signingPriv))

      // Create a composite public key string or just use encryption key for now
      const publicKeyString = JSON.stringify(encryptionPub)
      const deviceId = uuidv4()

      // Register in DB
      const { error } = await supabase.from('devices').insert({
        user_id: user.id,
        device_name: name,
        device_id: deviceId,
        public_key: publicKeyString,
        is_trusted: false // Default to untrusted until vouched
      })

      if (error) throw error

      // Save to local storage
      localStorage.setItem('serotine_device_id', deviceId)
      localStorage.setItem('serotine_device_name', name)
      localStorage.setItem('serotine_public_key', publicKeyString)

      setDeviceInfo({
        deviceId,
        deviceName: name,
        publicKey: publicKeyString,
        isRegistered: true
      })

      return true
    } catch (error) {
      console.error('Error registering device:', error)
      throw error
    } finally {
      setLoading(false)
    }
  }

  return {
    deviceInfo,
    loading,
    registerDevice
  }
}
