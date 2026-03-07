'use client'

import { useCallback, useEffect, useRef, useState, FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
declare global {
  interface Window {
    google?: any
  }
}

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [pendingApproval, setPendingApproval] = useState(false)
  const [loading, setLoading] = useState(false)
  const [googleReady, setGoogleReady] = useState(false)
  const router = useRouter()
  const googleBtnRef = useRef<HTMLDivElement | null>(null)

  const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID || ''

  const completeLogin = useCallback(async (path: string, body: any) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      if (data.code === 'PENDING_APPROVAL') {
        setPendingApproval(true)
        setError('')
        setLoading(false)
        return false
      }
      setError(data.error || 'Login failed')
      setPendingApproval(false)
      setLoading(false)
      return false
    }

    router.push('/')
    router.refresh()
    return true
  }, [router])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      await completeLogin('/api/auth/login', { username, password })
    } catch {
      setError('Network error')
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!googleClientId) return

    const onScriptLoad = () => {
      if (!window.google || !googleBtnRef.current) return
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: async (response: any) => {
          setError('')
          setLoading(true)
          try {
            const ok = await completeLogin('/api/auth/google', { credential: response?.credential })
            if (!ok) return
          } catch {
            setError('Google sign-in failed')
            setLoading(false)
          }
        },
      })
      window.google.accounts.id.renderButton(googleBtnRef.current, {
        theme: 'outline',
        size: 'large',
        width: 320,
        text: 'signin_with',
        shape: 'pill',
      })
      setGoogleReady(true)
    }

    const existing = document.querySelector('script[data-google-gsi="1"]') as HTMLScriptElement | null
    if (existing) {
      if (window.google) onScriptLoad()
      return
    }

    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.setAttribute('data-google-gsi', '1')
    script.onload = onScriptLoad
    script.onerror = () => setError('Failed to load Google Sign-In')
    document.head.appendChild(script)
  }, [googleClientId, completeLogin])

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-lg overflow-hidden bg-background border border-border/50 flex items-center justify-center mb-3">
            <img src="/brand/mc-logo-128.png" alt="Mission Control logo" className="w-full h-full object-cover" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">Mission Control</h1>
          <p className="text-sm text-muted-foreground mt-1">Sign in to continue</p>
        </div>

        {pendingApproval && (
          <div className="mb-4 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20 text-center">
            <div className="flex justify-center mb-2">
              <svg className="w-8 h-8 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12,6 12,12 16,14" />
              </svg>
            </div>
            <div className="text-sm font-medium text-amber-200">Access Request Submitted</div>
            <p className="text-xs text-muted-foreground mt-1">
              Your request has been sent to an administrator for review. You&apos;ll be able to sign in once approved.
            </p>
            <Button
              onClick={() => { setPendingApproval(false); setError('') }}
              variant="ghost"
              size="sm"
              className="mt-3 text-xs"
            >
              Try again
            </Button>
          </div>
        )}

        <form onSubmit={handleSubmit} className={`space-y-4 ${pendingApproval ? 'opacity-50 pointer-events-none' : ''}`}>
          {error && (
            <div role="alert" className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="username" className="block text-sm font-medium text-foreground mb-1.5">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-smooth"
              placeholder="Enter username"
              autoComplete="username"
              autoFocus
              required
              aria-required="true"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-foreground mb-1.5">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 px-3 rounded-lg bg-secondary border border-border text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-smooth"
              placeholder="Enter password"
              autoComplete="current-password"
              required
              aria-required="true"
            />
          </div>

          <Button
            type="submit"
            disabled={loading || !username || !password}
            size="lg"
            className="w-full rounded-lg"
          >
            {loading ? (
              <>
                <div className="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin" />
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </Button>
        </form>

        <div className="my-4 flex items-center gap-2">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className={`flex justify-center ${pendingApproval ? 'opacity-50 pointer-events-none' : ''}`}>
          {googleClientId ? (
            <div className="min-h-[44px]" ref={googleBtnRef} />
          ) : (
            <div className="text-xs text-muted-foreground">Google sign-in not configured</div>
          )}
        </div>
        {googleClientId && !googleReady && <p className="text-center text-xs text-muted-foreground mt-2">Loading Google Sign-In...</p>}

        <p className="text-center text-xs text-muted-foreground mt-6">OpenClaw Agent Orchestration</p>
      </div>
    </div>
  )
}
