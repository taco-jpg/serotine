'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/utils/supabase/client'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, RefreshCw } from 'lucide-react'
import { LinearCaptcha } from './linear-captcha'

export function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const view = searchParams.get('view')
  const [isSignUp, setIsSignUp] = useState(view === 'signup')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [isCaptchaValid, setIsCaptchaValid] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const supabase = createClient()

  useEffect(() => {
    setIsSignUp(view === 'signup')
    setIsCaptchaValid(false)
  }, [view])

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setMessage(null)

    if (isSignUp && !isCaptchaValid) {
      setError('Please solve the graph captcha correctly')
      setLoading(false)
      return
    }

    const email = `${username.toLowerCase().replace(/\s+/g, '')}@serotine.network`

    try {
      if (isSignUp) {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/auth/callback`,
            data: {
              username: username
            }
          },
        })
        if (error) throw error
        setMessage('Account created! If email confirmation is enabled, you would check your email now. For this demo, try logging in.')
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        })
        if (error) throw error
        router.push('/dashboard')
        router.refresh()
      }
    } catch (err: any) {
      setError(err.message)
    } finally {
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
        {loading ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : isSignUp ? (
          'Sign Up'
        ) : (
          'Sign In'
        )}
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
          {isSignUp ? 'Already have an account? Sign In' : 'Need an account? Sign Up'}
        </button>
      </div>
    </form>
  )
}
