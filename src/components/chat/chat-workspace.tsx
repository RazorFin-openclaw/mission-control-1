'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import { useMissionControl, type Conversation } from '@/store'
import { useSmartPoll } from '@/lib/use-smart-poll'
import { createClientLogger } from '@/lib/client-logger'
import { ConversationList } from './conversation-list'
import { MessageList } from './message-list'
import { ChatInput } from './chat-input'
import { Button } from '@/components/ui/button'
import { SessionMessage, shouldShowTimestamp, type SessionTranscriptMessage } from './session-message'

const log = createClientLogger('ChatWorkspace')

interface ChatWorkspaceProps {
  mode?: 'overlay' | 'embedded'
  onClose?: () => void
}

export function ChatWorkspace({ mode = 'embedded', onClose }: ChatWorkspaceProps) {
  const {
    activeConversation,
    setActiveConversation,
    setChatMessages,
    setConversations,
    addChatMessage,
    replacePendingMessage,
    updatePendingMessage,
    agents,
    conversations,
    setAgents,
  } = useMissionControl()

  const pendingIdRef = useRef(-1)

  const [showConversations, setShowConversations] = useState(true)
  const [isMobile, setIsMobile] = useState(false)
  const [sessionTranscript, setSessionTranscript] = useState<SessionTranscriptMessage[]>([])
  const [sessionTranscriptLoading, setSessionTranscriptLoading] = useState(false)
  const [sessionTranscriptError, setSessionTranscriptError] = useState<string | null>(null)
  const [sessionReloadNonce, setSessionReloadNonce] = useState(0)

  const isOverlay = mode === 'overlay'
  const selectedConversation = conversations.find((c) => c.id === activeConversation)
  const selectedSession = selectedConversation?.session

  // Detect mobile
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // On mobile, hide conversations when a conversation is selected
  useEffect(() => {
    if (isMobile && activeConversation) {
      setShowConversations(false)
    }
  }, [isMobile, activeConversation])

  // Load agents list
  useEffect(() => {
    async function loadAgents() {
      try {
        const res = await fetch('/api/agents')
        if (!res.ok) return
        const data = await res.json()
        if (data.agents) setAgents(data.agents)
      } catch (err) {
        log.error('Failed to load agents:', err)
      }
    }

    loadAgents()
  }, [setAgents])

  // Load messages when conversation changes
  const loadMessages = useCallback(async () => {
    if (!activeConversation) return
    if (activeConversation.startsWith('session:')) {
      setChatMessages([])
      return
    }

    try {
      const res = await fetch(`/api/chat/messages?conversation_id=${encodeURIComponent(activeConversation)}&limit=100`)
      if (!res.ok) return
      const data = await res.json()
      if (data.messages) setChatMessages(data.messages)
    } catch (err) {
      log.error('Failed to load messages:', err)
    }
  }, [activeConversation, setChatMessages])

  useEffect(() => {
    loadMessages()
  }, [loadMessages])

  // Poll for new messages (visibility-aware)
  useSmartPoll(loadMessages, 15000, {
    enabled: !!activeConversation && !activeConversation.startsWith('session:'),
    pauseWhenSseConnected: true,
  })

  // Close on Escape (overlay mode)
  useEffect(() => {
    if (!isOverlay || !onClose) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOverlay, onClose])

  // Send message handler with optimistic updates
  const handleSend = async (content: string) => {
    if (!activeConversation) return

    const mentionMatch = content.match(/^@(\w+)\s/)
    let to = mentionMatch ? mentionMatch[1] : null
    const cleanContent = mentionMatch ? content.slice(mentionMatch[0].length) : content

    if (!to && activeConversation.startsWith('agent_')) {
      to = activeConversation.replace('agent_', '')
    }

    // Create optimistic message with negative temp ID
    pendingIdRef.current -= 1
    const tempId = pendingIdRef.current
    const optimisticMessage = {
      id: tempId,
      conversation_id: activeConversation,
      from_agent: 'human',
      to_agent: to,
      content: cleanContent,
      message_type: 'text' as const,
      created_at: Math.floor(Date.now() / 1000),
      pendingStatus: 'sending' as const,
    }

    addChatMessage(optimisticMessage)

    try {
      const res = await fetch('/api/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'human',
          to,
          content: cleanContent,
          conversation_id: activeConversation,
          message_type: 'text',
          forward: true,
        }),
      })

      if (res.ok) {
        const data = await res.json()
        if (data.message) {
          replacePendingMessage(tempId, data.message)
        }
      } else {
        updatePendingMessage(tempId, { pendingStatus: 'failed' })
      }
    } catch (err) {
      log.error('Failed to send message:', err)
      updatePendingMessage(tempId, { pendingStatus: 'failed' })
    }
  }

  const handleNewConversation = (agentName: string) => {
    const convId = `agent_${agentName}`
    setActiveConversation(convId)
    if (isMobile) setShowConversations(false)
  }

  const handleBackToList = () => {
    setShowConversations(true)
    if (isMobile) setActiveConversation(null)
  }

  const canSendMessage =
    !!activeConversation &&
    !activeConversation.startsWith('session:')

  useEffect(() => {
    const sessionMeta = selectedSession
    if (!sessionMeta) {
      setSessionTranscript([])
      setSessionTranscriptError(null)
      return
    }
    if (sessionMeta.sessionKind === 'gateway') {
      setSessionTranscript([])
      setSessionTranscriptLoading(false)
      setSessionTranscriptError(null)
      return
    }

    let cancelled = false
    setSessionTranscriptLoading(true)
    setSessionTranscriptError(null)

    fetch(`/api/sessions/transcript?kind=${encodeURIComponent(sessionMeta.sessionKind)}&id=${encodeURIComponent(sessionMeta.sessionId)}&limit=40`)
      .then(async (res) => {
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}))
          throw new Error(payload?.error || 'Failed to load transcript')
        }
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        setSessionTranscript(Array.isArray(data?.messages) ? data.messages : [])
      })
      .catch((err) => {
        if (cancelled) return
        setSessionTranscript([])
        setSessionTranscriptError(err instanceof Error ? err.message : 'Failed to load transcript')
      })
      .finally(() => {
        if (!cancelled) setSessionTranscriptLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedSession, sessionReloadNonce])

  const refreshSessionTranscript = useCallback(() => {
    setSessionReloadNonce((v) => v + 1)
  }, [])

  const handleSaveSessionPreferences = useCallback(async (payload: {
    prefKey: string
    displayName?: string
    colorTag?: string
  }) => {
    const body = {
      key: payload.prefKey,
      name: payload.displayName || null,
      color: payload.colorTag || null,
    }

    const res = await fetch('/api/chat/session-prefs', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data?.error || 'Failed to save session preferences')
    }

    if (!activeConversation) return
    setConversations(
      conversations.map((conv) => {
        if (conv.id !== activeConversation || !conv.session) return conv
        return {
          ...conv,
          name: payload.displayName || conv.name,
          session: {
            ...conv.session,
            displayName: payload.displayName || conv.session.displayName,
            colorTag: payload.colorTag || undefined,
          },
        }
      })
    )
  }, [activeConversation, conversations, setConversations])

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Header */}
      <div className="glass-strong flex h-12 flex-shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-3">
          {/* Back button on mobile when in chat view */}
          {isMobile && !showConversations && (
            <Button
              onClick={handleBackToList}
              variant="ghost"
              size="icon-xs"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 12L6 8l4-4" />
              </svg>
            </Button>
          )}
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
              <path d="M14 10c0 .37-.1.7-.28 1-.53.87-2.2 3-5.72 3-4.42 0-6-3-6-4V4a2 2 0 012-2h8a2 2 0 012 2v6z" />
              <path d="M6 7h.01M10 7h.01" />
            </svg>
            <span className="text-sm font-semibold text-foreground">Agent Chat</span>
          </div>
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {agents.filter(a => a.status === 'busy' || a.status === 'idle').length} online
          </span>
        </div>

        <div className="flex items-center gap-1">
          {/* Toggle conversations sidebar (desktop) */}
          <Button
            onClick={() => setShowConversations(!showConversations)}
            variant="ghost"
            size="icon-xs"
            className="hidden md:flex"
            title={showConversations ? 'Hide conversations' : 'Show conversations'}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </Button>

          {isOverlay && onClose && (
            <Button
              onClick={onClose}
              variant="ghost"
              size="icon-xs"
              title="Close chat (Esc)"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </Button>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Conversations sidebar */}
        {showConversations && (
          <div className={`${isMobile ? 'w-full' : 'w-56 border-r border-border'} flex-shrink-0`}>
            <ConversationList onNewConversation={handleNewConversation} />
          </div>
        )}

        {/* Message area */}
        {(!isMobile || !showConversations) && (
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Conversation header */}
            {activeConversation && (
              <div className="bg-surface-1 flex flex-shrink-0 items-center gap-2 border-b border-border/50 px-4 py-2">
                <AgentAvatar
                  name={(selectedConversation?.name || activeConversation).replace('agent_', '')}
                  size="sm"
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {(selectedConversation?.name || activeConversation).replace('agent_', '')}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {getConversationStatus(agents, activeConversation)}
                  </div>
                </div>
              </div>
            )}

            {selectedConversation?.source === 'session' && selectedConversation.session ? (
              <SessionConversationView
                session={selectedConversation.session}
                messages={sessionTranscript}
                loading={sessionTranscriptLoading}
                error={sessionTranscriptError}
                onRefreshTranscript={refreshSessionTranscript}
                onSavePreferences={handleSaveSessionPreferences}
              />
            ) : (
              <>
                <MessageList />
                <ChatInput
                  onSend={handleSend}
                  disabled={!canSendMessage}
                  agents={agents.map(a => ({ name: a.name, role: a.role }))}
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SessionConversationView({
  session,
  messages,
  loading,
  error,
  onRefreshTranscript,
  onSavePreferences,
}: {
  session: NonNullable<Conversation['session']>
  messages: SessionTranscriptMessage[]
  loading: boolean
  error: string | null
  onRefreshTranscript: () => void
  onSavePreferences: (payload: { prefKey: string; displayName?: string; colorTag?: string }) => Promise<void>
}) {
  const isGatewaySession = session.sessionKind === 'gateway'
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)
  const [continuePrompt, setContinuePrompt] = useState('')
  const [continueBusy, setContinueBusy] = useState(false)
  const [continueError, setContinueError] = useState<string | null>(null)
  const [lastReply, setLastReply] = useState<string | null>(null)
  const [nameDraft, setNameDraft] = useState(session.displayName || '')
  const [colorDraft, setColorDraft] = useState(session.colorTag || '')
  const [prefBusy, setPrefBusy] = useState(false)
  const [prefError, setPrefError] = useState<string | null>(null)
  const hasPrefChanges =
    nameDraft.trim() !== (session.displayName || '').trim() ||
    colorDraft !== (session.colorTag || '')

  useEffect(() => {
    setNameDraft(session.displayName || '')
    setColorDraft(session.colorTag || '')
    setPrefError(null)
    setContinueError(null)
    setLastReply(null)
  }, [session.prefKey, session.displayName, session.colorTag])

  useEffect(() => {
    const container = transcriptScrollRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [messages, loading, lastReply])

  const handleContinueSession = async () => {
    const prompt = continuePrompt.trim()
    if (!prompt || continueBusy) return

    setContinueBusy(true)
    setContinueError(null)
    setLastReply(null)
    try {
      const res = await fetch('/api/sessions/continue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: session.sessionKind,
          id: session.sessionId,
          prompt,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data?.error || 'Failed to continue session')
      }
      setContinuePrompt('')
      if (typeof data?.reply === 'string' && data.reply.trim()) {
        setLastReply(data.reply.trim())
      }
      onRefreshTranscript()
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : 'Failed to continue session')
    } finally {
      setContinueBusy(false)
    }
  }

  const handleSavePrefs = async () => {
    if (!session.prefKey || prefBusy) return
    setPrefBusy(true)
    setPrefError(null)
    try {
      await onSavePreferences({
        prefKey: session.prefKey,
        displayName: nameDraft.trim() || undefined,
        colorTag: colorDraft || undefined,
      })
    } catch (err) {
      setPrefError(err instanceof Error ? err.message : 'Failed to save preferences')
    } finally {
      setPrefBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Compact session info bar */}
      <div className="border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-[10px] ${session.active ? 'bg-green-500/20 text-green-300' : 'bg-muted text-muted-foreground'}`}>
            {session.active ? 'active' : 'idle'}
          </span>
          <span className="font-mono-tight">{session.sessionKind === 'codex-cli' ? 'Codex CLI' : 'Claude Code'}</span>
          {session.model && <span className="text-muted-foreground/60">{session.model}</span>}
          {session.tokens && <span className="text-muted-foreground/60">{session.tokens}</span>}
          {session.workingDir && <span className="hidden truncate text-muted-foreground/50 sm:inline max-w-[200px]">{session.workingDir}</span>}
          {session.age && <span className="text-muted-foreground/40">{session.age} ago</span>}
        </div>

        {/* Collapsible settings */}
        {!isGatewaySession && (
          <details className="mt-2">
            <summary className="cursor-pointer select-none text-[10px] uppercase tracking-wider text-muted-foreground/60 hover:text-muted-foreground/80">
              Settings
            </summary>
            <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_120px_auto]">
              <input
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Rename session"
                maxLength={80}
                className="h-7 rounded border border-border/60 bg-surface-1 px-2 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              <select
                value={colorDraft}
                onChange={(e) => setColorDraft(e.target.value)}
                className="h-7 rounded border border-border/60 bg-surface-1 px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
              >
                <option value="">No color</option>
                <option value="slate">Slate</option>
                <option value="blue">Blue</option>
                <option value="green">Green</option>
                <option value="amber">Amber</option>
                <option value="red">Red</option>
                <option value="purple">Purple</option>
                <option value="pink">Pink</option>
                <option value="teal">Teal</option>
              </select>
              <Button
                onClick={handleSavePrefs}
                size="sm"
                variant="outline"
                disabled={prefBusy || !session.prefKey || !hasPrefChanges}
                className="h-7 px-3 text-xs"
              >
                {prefBusy ? 'Saving...' : 'Save'}
              </Button>
            </div>
            {prefError && <div className="mt-2 text-xs text-red-400">{prefError}</div>}
          </details>
        )}
      </div>

      {/* Transcript */}
      <div ref={transcriptScrollRef} className="flex-1 overflow-y-auto font-mono-tight py-2">
        {loading && (
          <div className="space-y-2 px-4">
            <div className="h-4 w-3/4 animate-pulse rounded bg-surface-1/60" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-surface-1/60" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-surface-1/60" />
            <div className="text-xs text-muted-foreground/50">Loading transcript...</div>
          </div>
        )}
        {!loading && error && (
          <div className="px-4 text-xs text-red-400">{error}</div>
        )}
        {!loading && !error && messages.length === 0 && (
          <div className="px-4 text-xs text-muted-foreground">
            {isGatewaySession ? 'Gateway session selected. Transcript is provided by the gateway runtime.' : 'No transcript snippets found for this session.'}
          </div>
        )}
        {!loading && !error && messages.length > 0 && (
          <div className="space-y-0">
            {messages.map((msg, idx) => (
              <SessionMessage
                key={`${msg.timestamp || 'no-ts'}-${idx}`}
                message={msg}
                showTimestamp={shouldShowTimestamp(msg, messages[idx - 1])}
              />
            ))}
          </div>
        )}
      </div>

      {/* Continue session input */}
      {!isGatewaySession && (
      <div className="border-t border-border/50 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="font-mono-tight text-xs text-green-400/60">$</span>
          <input
            value={continuePrompt}
            onChange={(e) => setContinuePrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleContinueSession()
              }
            }}
            placeholder="Send prompt to this local session..."
            className="h-7 flex-1 rounded border border-border/40 bg-surface-1 px-2 font-mono-tight text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
          <Button
            onClick={handleContinueSession}
            size="sm"
            variant="ghost"
            disabled={continueBusy || !continuePrompt.trim()}
            className="h-7 px-3 text-xs"
          >
            {continueBusy ? '...' : 'Send'}
          </Button>
        </div>
        {continueError && <div className="mt-1 text-xs text-red-400">{continueError}</div>}
        {lastReply && (
          <div className="mt-2 border-l-2 border-primary/30 pl-3">
            <div className="font-mono-tight text-xs leading-relaxed text-foreground whitespace-pre-wrap">{lastReply}</div>
          </div>
        )}
      </div>
      )}
    </div>
  )
}

function AgentAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const colors: Record<string, string> = {
    coordinator: 'bg-purple-500/20 text-purple-400',
    aegis: 'bg-red-500/20 text-red-400',
    research: 'bg-green-500/20 text-green-400',
    ops: 'bg-orange-500/20 text-orange-400',
    reviewer: 'bg-teal-500/20 text-teal-400',
    content: 'bg-indigo-500/20 text-indigo-400',
    human: 'bg-primary/20 text-primary',
  }

  const colorClass = colors[name.toLowerCase()] || 'bg-muted text-muted-foreground'
  const sizeClass = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-8 h-8 text-xs'

  return (
    <div className={`${sizeClass} ${colorClass} flex flex-shrink-0 items-center justify-center rounded-full font-bold`}>
      {name.charAt(0).toUpperCase()}
    </div>
  )
}

function getConversationStatus(agents: Array<{ name: string; status: string }>, conversationId: string): string {
  if (conversationId.startsWith('session:')) {
    if (conversationId.includes('claude-code')) return 'Local Claude session'
    if (conversationId.includes('codex-cli')) return 'Local Codex session'
    return 'Gateway session'
  }
  const name = conversationId.replace('agent_', '')
  const agent = agents.find(a => a.name.toLowerCase() === name.toLowerCase())
  if (!agent) return 'Unknown'
  return agent.status === 'idle' || agent.status === 'busy' ? 'Online' : 'Offline'
}
