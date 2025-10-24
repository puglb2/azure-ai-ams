// src/App.tsx
import React, { useEffect, useRef, useState } from 'react'

type Role = 'user' | 'assistant'
type Msg = { role: Role; content: string }

function Header() {
  return (
    <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div
        style={{
          width: 36, height: 36, borderRadius: 8,
          background: '#111', color: '#fff',
          display: 'grid', placeItems: 'center', fontWeight: 700
        }}
        aria-hidden
      >
        P
      </div>
      <div>
        <div style={{ fontSize: 16, fontWeight: 700 }}>Polaris | AMS Intake Assistant</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Decide between therapy, psychiatry, or both—and get matched in-network.
        </div>
      </div>
    </div>
  )
}

function Bubble({ role, children }: { role: Role; children: React.ReactNode }) {
  const isUser = role === 'user'
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: isUser ? 'flex-end' : 'flex-start',
        margin: '8px 0'
      }}
    >
      <div
        style={{
          maxWidth: 760,
          background: isUser ? '#111827' : '#ffffff',
          color: isUser ? '#ffffff' : '#111827',
          border: isUser ? '1px solid #111827' : '1px solid #e5e7eb',
          padding: '10px 12px',
          borderRadius: 12,
          boxShadow: isUser ? '0 1px 2px rgba(0,0,0,0.15)' : '0 1px 2px rgba(0,0,0,0.06)',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.4
        }}
      >
        {children}
      </div>
    </div>
  )
}

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const didInit = useRef(false)

  // 🔒 Lock body scroll
  useEffect(() => {
    const prevOverflow = document.body.style.overflow
    const prevOB = (document.body.style as any).overscrollBehavior
    document.body.style.overflow = 'hidden'
    ;(document.body.style as any).overscrollBehavior = 'contain'
    return () => {
      document.body.style.overflow = prevOverflow
      ;(document.body.style as any).overscrollBehavior = prevOB || ''
    }
  }, [])

  // focus management
  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { if (!busy) inputRef.current?.focus() }, [busy])

  // one-time welcome
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    setMessages([
      {
        role: 'assistant',
        content:
          "Hi, I’m Polaris, your AMS Intake Assistant. Can you tell me a little bit about how you’ve been feeling?"
      }
    ])
  }, [])

  const wait = (ms: number) => new Promise(res => setTimeout(res, ms))

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setMessages(m => [...m, { role: 'user', content: text }])
    setBusy(true)

    try {
      const history = messages.slice(-34).map(m => ({ role: m.role, content: m.content }))
      const res = await fetch('/api/chat?ui=1&debug=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history })
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any))
        const msg =
          typeof err?.error === 'string'
            ? `Sorry — ${err.error}`
            : `Sorry — server error (${res.status})`
        setMessages(m => [...m, { role: 'assistant', content: msg }])
        return
      }

      const data = await res.json().catch(() => ({} as any))
      const raw = typeof data?.reply === 'string' ? data.reply.trim() : ''
      const err = typeof data?.error === 'string' ? data.error.trim() : ''
      const reply = raw || (err ? `Sorry — ${err}` : 'Sorry — empty reply.')

      // ⏳ Simulate human typing delay (~100–150ms/char, capped at 6s)
      const perChar = 100 + Math.random() * 50
      const totalDelay = Math.min(reply.length * perChar, 6000)
      await wait(totalDelay)

      // Show message all at once
      setMessages(m => [...m, { role: 'assistant', content: reply }])
    } catch (e) {
      console.error('chat error', e)
      setMessages(m => [...m, { role: 'assistant', content: 'Sorry — network error.' }])
    } finally {
      setBusy(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        height: '100vh',
        overflow: 'hidden',
        background: 'linear-gradient(180deg, #e5e7eb 0%, #f8fafc 100%)',
        padding: 12,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center'
      }}
    >
      <div
        style={{
          width: '96vw',
          maxWidth: 1400,
          height: '92vh',
          display: 'flex',
          flexDirection: 'column',
          background: '#ffffff',
          border: '1px solid #d1d5db',
          borderRadius: 20,
          overflow: 'hidden',
          boxShadow: '0 12px 28px rgba(0,0,0,0.1)'
        }}
      >
        <Header />

        {/* Safety banner */}
        <div
          style={{
            padding: '10px 16px',
            background: '#fff4e6',
            color: '#7c2d12',
            fontSize: 13,
            borderTop: '1px solid #f5d0a9',
            borderBottom: '1px solid #f5d0a9'
          }}
        >
          <strong>Not for emergencies.</strong> If you’re in immediate danger, call <strong>988</strong>{' '}
          for suicide hotline, or <strong>911</strong> for any other emergencies.
        </div>

        {/* Chat area */}
        <div
          ref={scrollerRef}
          style={{
            flex: 1,
            padding: 20,
            overflowY: 'auto',
            background: '#f9fafb',
            borderTop: '1px solid #e5e7eb',
            borderBottom: '1px solid #e5e7eb',
            boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.05)'
          }}
        >
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role}>
              {m.content}
            </Bubble>
          ))}

          {busy && (
            <div style={{ marginTop: 6, color: '#6b7280', fontStyle: 'italic', fontSize: 13 }}>
              Polaris is typing…
            </div>
          )}
        </div>

        {/* Composer */}
        <div
          style={{
            padding: 14,
            background: '#f3f4f6',
            borderTop: '1px solid #e5e7eb',
            display: 'flex',
            gap: 8
          }}
        >
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              background: '#ffffff',
              border: '1px solid #d1d5db',
              borderRadius: 12,
              padding: '8px 10px',
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
            }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (!busy) send()
                }
              }}
              placeholder={busy ? 'Assistant is typing…' : 'Type a message'}
              style={{
                flex: 1,
                outline: 'none',
                border: 'none',
                background: 'transparent',
                fontSize: 14
              }}
            />
            <span
              style={{
                fontSize: 12,
                color: '#9ca3af',
                paddingLeft: 8,
                borderLeft: '1px solid #e5e7eb',
                userSelect: 'none'
              }}
              title="Press Enter to send"
            >
              ↵ Send
            </span>
          </div>

          <button
            onClick={() => { if (!busy) send() }}
            disabled={busy || !input.trim()}
            title={
              busy ? 'Please wait for the assistant to finish'
              : input.trim() ? 'Send' : 'Type a message'
            }
            style={{
              padding: '10px 16px',
              borderRadius: 12,
              border: '1px solid #111',
              background: busy || !input.trim() ? '#9ca3af' : '#111',
              color: '#fff',
              cursor: busy || !input.trim() ? 'not-allowed' : 'pointer',
              fontWeight: 600
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
