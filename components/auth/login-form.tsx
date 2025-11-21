"use client"

import type React from "react"

import { useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { createClient } from "@/utils/supabase/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2 } from "lucide-react"
import { LinearCaptcha } from "./linear-captcha"
import { signUpWithUsername } from "@/app/actions"

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const view = searchParams.get("view")
  const [isSignUp, setIsSignUp] = useState(view === "signup")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [isCaptchaValid, setIsCaptchaValid] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const supabase = createClient()

  useEffect(() => {
    setIsSignUp(view === "signup")
    setIsCaptchaValid(false)
  }, [view])

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setMessage(null)

    const cleanUsername = username.trim()

    if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
      setError("Username can only contain letters, numbers, and underscores")
      setLoading(false)
      return
    }

    if (isSignUp && !isCaptchaValid) {
      setError("Please solve the graph captcha correctly")
      setLoading(false)
      return
    }

    const generateEmail = () => {
      const uuid = crypto.randomUUID().replace(/-/g, "").substring(0, 16)
      return `user.${uuid}@gmail.com`
    }

    const emailToUse = isSignUp ? generateEmail() : localStorage.getItem(`serotine_user_${cleanUsername}`)

    try {
      if (isSignUp) {
        const result = await signUpWithUsername(cleanUsername, password, emailToUse!)

        if (result.error) {
          throw new Error(result.error)
        }

        localStorage.setItem(`serotine_user_${cleanUsername}`, emailToUse!)

        const { data, error: signInError } = await supabase.auth.signInWithPassword({
          email: emailToUse!,
          password,
        })

        if (signInError) throw signInError

        // Ensure session is available before redirecting
        if (!data.session) {
          throw new Error("Session not established")
        }

        // Use window.location for a full page reload to ensure middleware picks up the session
        window.location.href = "/dashboard/messages"
      } else {
        const storedEmail = localStorage.getItem(`serotine_user_${cleanUsername}`)

        if (!storedEmail) {
          setError("Username not found. Please sign up first.")
          setLoading(false)
          return
        }

        const { data, error } = await supabase.auth.signInWithPassword({
          email: storedEmail,
          password,
        })

        if (error) throw error

        // Ensure session is available before redirecting
        if (!data.session) {
          throw new Error("Session not established")
        }

        // Use window.location for a full page reload to ensure middleware picks up the session
        window.location.href = "/dashboard/messages"
      }
    } catch (err: any) {
      console.error("[v0] Auth error:", err.message)

      if (err.message.includes("already registered")) {
        setError("Username is already taken")
      } else if (err.message.includes("Invalid login credentials")) {
        setError("Invalid username or password")
      } else if (err.message.includes("Email not confirmed")) {
        setError(
          "Login failed: Email confirmation is enabled in your Supabase project. Please disable 'Confirm Email' in your Supabase Dashboard to use username login.",
        )
      } else {
        setError(err.message)
      }
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleAuth} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      <div className="space-y-2">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          type="text"
          placeholder="Enter your username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          className="bg-background/50 border-primary/20 focus-visible:ring-primary"
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          {!isSignUp && (
            <Link href="#" className="text-xs text-primary hover:underline">
              Forgot password?
            </Link>
          )}
        </div>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="bg-background/50 border-primary/20 focus-visible:ring-primary"
        />
      </div>

      {isSignUp && (
        <div className="space-y-2">
          <Label>Security Check</Label>
          <LinearCaptcha onVerify={setIsCaptchaValid} />
        </div>
      )}

      <Button type="submit" className="w-full bg-primary hover:bg-primary/90" disabled={loading}>
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : isSignUp ? "Sign Up" : "Sign In"}
      </Button>

      <div className="text-center text-sm">
        <button
          type="button"
          onClick={() => {
            setIsSignUp(!isSignUp)
            setError(null)
            setMessage(null)
          }}
          className="text-muted-foreground hover:text-primary underline"
        >
          {isSignUp ? "Already have an account? Sign In" : "Need an account? Sign Up"}
        </button>
      </div>
    </form>
  )
}
