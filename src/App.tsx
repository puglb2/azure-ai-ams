// App.tsx
import React, { useEffect, useRef, useState } from 'react'

type Role = 'user' | 'assistant'
type Msg = { role: Role; content: string }

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const didInit = useRef(false)

  // keep scroll at bottom
  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  // focus on mount + after each reply
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  useEffect(() => {
    if (!busy) inputRef.current?.focus()
  }, [busy])

  // one-time welcome (guarded against React strict mode double calls)
  useEffect(() => {
    if (didInit.current) return
    didInit.current = true
    setMessages([
      { role: 'assistant', content: "Hi there! I’m the AMS Intake Assistant. Can you share a little bit about how you've been feeling?" }
    ])
  }, [])

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    setMessages(m => [...m, { role: 'user', content: text }])
    setBusy(true)

    try {
      // only last 34 turns
      const history = messages.slice(-34).map(m => ({ role: m.role, content: m.content }))

      const res = await fetch('/api/chat?ui=1&debug=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history })
      })

      // Non-200: show error body
      if (!res.ok) {
        const err = await res.json().catch(() => ({} as any))
        const msg = typeof err?.error === 'string'
          ? `Sorry — ${err.error}`
          : `Sorry — server error (${res.status})`
        setMessages(m => [...m, { role: 'assistant', content: msg }])
        return
      }

      const data = await res.json().catch(() => ({} as any))
      const raw = typeof data?.reply === 'string' ? data.reply.trim() : ''
      const err = typeof data?.error === 'string' ? data.error.trim() : ''
      const reply = raw || (err ? `Sorry — ${err}` : 'Sorry — empty reply.')

      setMessages(m => [...m, { role: 'assistant', content: reply }])
    } catch (e: any) {
      console.error('chat error', e)
      setMessages(m => [...m, { role: 'assistant', content: 'Sorry — network error.' }])
    } finally {
      setBusy(false)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  // simple components for cleaner JSX
  const Header = () => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 16px',
        borderBottom: '1px solid rgba(0,0,0,0.06)',
        background: 'linear-gradient(to right, #ffffff, #fafafa)'
      }}
    >
      <div
        style={{
          width: 36, height: 36, borderRadius: 10,
          background: '#111', color: '#fff',
          display: 'grid', placeItems: 'center', fontWeight: 700
        }}
        aria-hidden
      >
        A
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>AMS Intake Assistant</div>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          Decide between therapy, psychiatry, or both—and get matched in-network.
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: busy ? '#22c55e' : '#9ca3af',
            boxShadow: busy ? '0 0 0 4px rgba(34,197,94,0.15)' : 'none'
          }}
          aria-label={busy ? 'Assistant is typing' : 'Idle'}
        />
        <span style={{ fontSize: 12, color: '#6b7280' }}>{busy ? 'Typing…' : 'Ready'}</span>
      </div>
    </div>
  )

  const Bubble: React.FC<{ role: Role; children: React.ReactNode }> = ({ role, children }) => {
    const isUser = role === 'user'
    return (
      <div
        style={{
          display: 'flex',
          justifyContent: isUser ? 'flex-end' : 'flex-start',
          margin: '10px 0'
        }}
      >
        <div
          style={{
            maxWidth: '85%',
            background: isUser ? '#111' : '#f3f4f6',
            color: isUser ? '#fff' : '#111',
            padding: '10px 12px',
            borderRadius: 14,
            borderTopLeftRadius: isUser ? 14 : 4,
            borderTopRightRadius: isUser ? 4 : 14,
            lineHeight: 1.4,
            boxShadow: '0 1px 2px rgba(0,0,0,0.06)',
            whiteSpace: 'pre-wrap'
          }}
        >
          {children}
        </div>
      </div>
    )
  }

  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        minHeight: '100vh',
        background: 'linear-gradient(180deg, #f8fafc 0%, #eef2f7 100%)',
        padding: 16
      }}
    >
      <div
        style={{
          maxWidth: 760,
          margin: '0 auto',
          background: '#fff',
          border: '1px solid rgba(0,0,0,0.06)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 8px 24px rgba(0,0,0,0.06)'
        }}
      >
        <Header />

        {/* Safety banner */}
        <div
          style={{
            padding: '10px 16px',
            background: '#fff7ed',
            color: '#7c2d12',
            fontSize: 13,
            borderBottom: '1px solid rgba(0,0,0,0.06)'
          }}
        >
          <strong>Not for emergencies.</strong> If you’re in immediate danger, call <strong>988</strong>.
        </div>

        {/* Messages */}
        <div
          ref={scrollerRef}
          style={{
            padding: 16,
            height: 460,
            overflowY: 'auto',
            background: 'linear-gradient(180deg, #ffffff 0%, #fafafa 100%)'
          }}
        >
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role}>
              {m.content}
            </Bubble>
          ))}

          {busy && (
            <div style={{ marginTop: 6, color: '#6b7280', fontStyle: 'italic', fontSize: 13 }}>
              Assistant is typing…
            </div>
          )}
        </div>

        {/* Composer */}
        <div
          style={{
            padding: 12,
            borderTop: '1px solid rgba(0,0,0,0.06)',
            background: '#fff',
            display: 'flex',
            gap: 8
          }}
        >
          <div
            style={{
              position: 'relative',
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              background: '#f3f4f6',
              border: '1px solid #e5e7eb',
              borderRadius: 12,
              padding: '6px 8px'
            }}
          >
            <input
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (!busy) send() // ignore Enter while busy
                }
              }}
              placeholder={busy ? 'Assistant is typing…' : 'Type a message'}
              // keep enabled so you can draft while busy
              style={{
                flex: 1,
                outline: 'none',
                border: 'none',
                background: 'transparent',
                fontSize: 14,
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
            title={busy ? 'Please wait for the assistant to finish' : (input.trim() ? 'Send' : 'Type a message')}
            style={{
              padding: '10px 16px',
              borderRadius: 12,
              border: '1px solid #111',
              background: (busy || !input.trim()) ? '#9ca3af' : '#111',
              color: '#fff',
              cursor: (busy || !input.trim()) ? 'not-allowed' : 'pointer',
              fontWeight: 600,
              transition: 'transform 0.05s ease-in-out',
            }}
            onMouseDown={e => {
              (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(1px)'
            }}
            onMouseUp={e => {
              (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
