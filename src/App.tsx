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

  // Always keep the input scrolled & focused appropriately
  useEffect(() => {
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, busy])

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Re-focus whenever we finish thinking
  useEffect(() => {
    if (!busy) inputRef.current?.focus()
  }, [busy])

  // Kick off with a welcome message
  useEffect(() => {
    if (messages.length === 0) {
      setMessages([
        { role: 'assistant', content: "Hi there! I’m the AMS Intake Assistant. Can you share a little bit about how you've been feeling?" }
      ])
    }
  }, [messages])

  async function send() {
    const text = input.trim()
    if (!text || busy) return  // block sends while busy
    setInput('')
    setMessages(m => [...m, { role: 'user', content: text }])
    setBusy(true)

    try {
      const history = messages.slice(-24).map(m => ({ role: m.role, content: m.content }))
      const res = await fetch('/api/chat?ui=1&debug=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history })
      })
      const data = await res.json().catch(() => ({} as any))
      console.log('LLM debug:', data)
      const raw = typeof data?.reply === 'string' ? data.reply.trim() : ''
      const err = typeof data?.error === 'string' ? data.error.trim() : ''
      const reply = raw || (err ? `Sorry — ${err}` : "")
      setMessages(m => [...m, { role: 'assistant', content: reply }])
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'Sorry, something went wrong.' }])
    } finally {
      setBusy(false)
      // keep the box active after the reply
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }

  return (
    <div style={{ fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, sans-serif', maxWidth:640, margin:'0 auto', padding:16 }}>
      <h3 style={{margin:0}}>AMS Intake Assistant</h3>
      <p style={{margin:'4px 0 12px 0', color:'#555'}}>
        Decide between therapy, psychiatry, or both—and get matched in-network. <br />
        <strong>Not for emergencies. If you’re in immediate danger, call 988.</strong>
      </p>

      <div ref={scrollerRef} style={{border:'1px solid #ddd', borderRadius:8, padding:12, height:380, overflowY:'auto', background:'#fff'}}>
        {messages.map((m,i)=>(
          <div key={i} style={{margin:'10px 0', lineHeight:1.35}}>
            <div style={{fontWeight:600, marginBottom:2}}>{m.role==='user'?'You':'Assistant'}</div>
            <div>{m.content}</div>
          </div>
        ))}
        {busy && <div style={{marginTop:8, color:'#777', fontStyle:'italic'}}>Assistant is typing…</div>}
      </div>

      <div style={{display:'flex', gap:8, marginTop:12}}>
        <input
          ref={inputRef}
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{
            if(e.key==='Enter'){
              e.preventDefault()
              if (!busy) send() // ignore Enter while busy
            }
          }}
          placeholder={busy ? 'Assistant is typing… (you can draft here)' : 'Type a message'}
          // keep enabled so you can draft while busy
          style={{flex:1, padding:10, borderRadius:6, border:'1px solid #ccc'}}
        />
        <button
          onClick={()=>{ if(!busy) send() }}
          disabled={busy || !input.trim()}
          title={busy ? 'Please wait for the assistant to finish' : (input.trim() ? 'Send' : 'Type a message')}
          style={{
            padding:'10px 16px',
            borderRadius:6,
            border:'1px solid #333',
            background:(busy || !input.trim()) ? '#555' : '#111',
            color:'#fff',
            cursor:(busy || !input.trim()) ? 'not-allowed' : 'pointer'
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}
