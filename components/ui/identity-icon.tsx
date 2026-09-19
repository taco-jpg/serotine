"use client"

import { memo } from "react"
import { useOptionalMessaging } from "@/components/messaging-provider"
import { FallbackProfileIcon, ProfileImage } from "@/components/profile/profile-card"

/** Shared authorized avatar resolver, including calls, communities and old messages. */
export const IdentityIcon = memo(function IdentityIcon({ pubKey, size = 32 }: { pubKey: string; size?: number }) {
  const messaging = useOptionalMessaging()
  const avatar = messaging?.getProfile(pubKey).avatar
  if (avatar) return <span className="inline-flex shrink-0 overflow-hidden rounded-full border border-border" style={{ width: size, height: size }}><ProfileImage media={avatar} alt="Profile picture" className="size-full" /></span>
  return <FallbackProfileIcon pubKey={pubKey} size={size} />
})
