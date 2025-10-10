return (
  <div
    style={{
      fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      minHeight: '100vh',
      background: 'linear-gradient(180deg, #e5e7eb 0%, #f8fafc 100%)', // darker backdrop for contrast
      padding: 24,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }}
  >
    <div
      style={{
        maxWidth: 760,
        width: '100%',
        background: '#ffffff',
        border: '1px solid #d1d5db',
        borderRadius: 20,
        overflow: 'hidden',
        boxShadow: '0 12px 28px rgba(0,0,0,0.1)', // deeper shadow
        display: 'flex',
        flexDirection: 'column'
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
          borderBottom: '1px solid #f5d0a9'
        }}
      >
        <strong>Not for emergencies.</strong> If you’re in immediate danger, call <strong>988</strong>.
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
          boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.05)' // subtle inset to frame it
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

      {/* Composer (unchanged except color tweak) */}
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
            position: 'relative',
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
        >
          Send
        </button>
      </div>
    </div>
  </div>
)
