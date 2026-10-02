import { useEffect, useState, useCallback } from 'react'

type JournalSubTab = 'soul' | 'memory'

interface JournalTabProps {
  companionId: string | null
}

export function JournalTab({ companionId }: JournalTabProps): React.JSX.Element {
  const [activeSubTab, setActiveSubTab] = useState<JournalSubTab>('soul')
  const [soulContent, setSoulContent] = useState('')
  const [memoryContent, setMemoryContent] = useState('')
  // `${companionId}:${tab}` of the last finished load. Loading is derived from
  // it, so the effect never sets state synchronously.
  const [loadedKey, setLoadedKey] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<{ key: string; message: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [saveToast, setSaveToast] = useState(false)

  const currentKey = companionId ? `${companionId}:${activeSubTab}` : null
  const isLoading = currentKey !== null && (loadedKey !== currentKey || refreshing)
  const error =
    actionError ?? (loadError !== null && loadError.key === currentKey ? loadError.message : null)

  // Load soul or memory when the companion or sub-tab changes. A response for
  // a companion or tab the user already left is dropped, so one mech's soul
  // can never land in another mech's editor and be saved there.
  useEffect(() => {
    if (!companionId) return
    const tab = activeSubTab
    const key = `${companionId}:${tab}`
    let cancelled = false
    const read =
      tab === 'soul' ? window.mechbay.soulRead(companionId) : window.mechbay.memoryRead(companionId)
    read.then(
      (result) => {
        if (cancelled) return
        if (result.ok) {
          if (tab === 'soul') setSoulContent(result.content)
          else setMemoryContent(result.content)
          setLoadError(null)
        } else {
          setLoadError({ key, message: result.error })
        }
        setLoadedKey(key)
      },
      (e: unknown) => {
        if (cancelled) return
        setLoadError({ key, message: e instanceof Error ? e.message : String(e) })
        setLoadedKey(key)
      }
    )
    return () => {
      cancelled = true
    }
  }, [companionId, activeSubTab])

  const handleSaveSoul = useCallback(async (): Promise<void> => {
    if (!companionId) return
    setActionError(null)
    try {
      const result = await window.mechbay.soulWrite(companionId, soulContent)
      if (result.ok) {
        setSaveToast(true)
        setTimeout(() => setSaveToast(false), 2000)
      } else {
        setActionError(result.error)
      }
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    }
  }, [companionId, soulContent])

  const handleRefreshMemory = useCallback(async (): Promise<void> => {
    if (!companionId) return
    setRefreshing(true)
    setActionError(null)
    try {
      const result = await window.mechbay.memoryRead(companionId)
      if (result.ok) setMemoryContent(result.content)
      else setActionError(result.error)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e))
    } finally {
      setRefreshing(false)
    }
  }, [companionId])

  if (!companionId) {
    return (
      <div style={containerStyle}>
        <div style={emptyStateStyle}>Select a companion (click on the bay).</div>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      {/* Sub-tab row */}
      <div style={subTabRowStyle}>
        <button
          type="button"
          style={activeSubTab === 'soul' ? subTabActiveStyle : subTabStyle}
          onClick={() => {
            setActiveSubTab('soul')
            setActionError(null)
          }}
        >
          [SOUL]
        </button>
        <button
          type="button"
          style={activeSubTab === 'memory' ? subTabActiveStyle : subTabStyle}
          onClick={() => {
            setActiveSubTab('memory')
            setActionError(null)
          }}
        >
          [MEMORY]
        </button>
      </div>

      {isLoading && <div style={loadingStyle}>Loading...</div>}

      {error && <div style={errorStyle}>⚠ {error}</div>}

      {/* SOUL sub-tab */}
      {activeSubTab === 'soul' && (
        <div style={contentAreaStyle}>
          <textarea
            value={soulContent}
            onChange={(e) => setSoulContent(e.target.value)}
            style={textareaStyle}
            placeholder="Soul content..."
            disabled={isLoading}
          />
          <div style={actionRowStyle}>
            <button
              type="button"
              onClick={handleSaveSoul}
              disabled={isLoading}
              style={saveButtonStyle}
            >
              SAVE
            </button>
            {saveToast && <span style={toastStyle}>Saved ✓</span>}
          </div>
        </div>
      )}

      {/* MEMORY sub-tab */}
      {activeSubTab === 'memory' && (
        <div style={contentAreaStyle}>
          <div style={memoryScrollAreaStyle}>
            <pre style={memoryPreStyle}>{memoryContent || '(No memory entries yet)'}</pre>
          </div>
          <div style={actionRowStyle}>
            <button
              type="button"
              onClick={handleRefreshMemory}
              disabled={isLoading}
              style={refreshButtonStyle}
            >
              REFRESH
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0
}

const subTabRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginBottom: 12,
  borderBottom: '1px solid #2a2520',
  paddingBottom: 8
}

const subTabStyle: React.CSSProperties = {
  background: 'transparent',
  border: 0,
  color: '#666',
  fontSize: 11,
  letterSpacing: '0.15em',
  padding: '4px 12px',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontWeight: 'bold'
}

const subTabActiveStyle: React.CSSProperties = {
  ...subTabStyle,
  color: '#ffcc33',
  borderBottom: '2px solid #ffcc33'
}

const contentAreaStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  gap: 8
}

const textareaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 200,
  background: '#0a0805',
  color: '#eee',
  border: '1px solid #2a2520',
  borderLeft: '2px solid #e85f00',
  padding: 10,
  fontFamily: 'inherit',
  fontSize: 12,
  resize: 'none',
  boxSizing: 'border-box'
}

const memoryScrollAreaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 200,
  background: '#0a0805',
  border: '1px solid #2a2520',
  borderLeft: '2px solid #ffcc33',
  padding: 10,
  overflow: 'auto'
}

const memoryPreStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'inherit',
  fontSize: 11,
  color: '#ccc',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}

const actionRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  marginTop: 4
}

const saveButtonStyle: React.CSSProperties = {
  background: '#e85f00',
  color: '#000',
  border: 0,
  padding: '6px 16px',
  fontSize: 11,
  fontWeight: 'bold',
  letterSpacing: '0.1em',
  cursor: 'pointer',
  fontFamily: 'inherit'
}

const refreshButtonStyle: React.CSSProperties = {
  background: '#2a2520',
  color: '#ffcc33',
  border: '1px solid #ffcc33',
  padding: '6px 16px',
  fontSize: 11,
  letterSpacing: '0.1em',
  cursor: 'pointer',
  fontFamily: 'inherit'
}

const toastStyle: React.CSSProperties = {
  color: '#0f0',
  fontSize: 11,
  letterSpacing: '0.1em'
}

const loadingStyle: React.CSSProperties = {
  color: '#888',
  fontSize: 11,
  marginBottom: 8
}

const errorStyle: React.CSSProperties = {
  color: '#ff6b6b',
  fontSize: 11,
  marginBottom: 8,
  padding: '6px 8px',
  background: '#2a1510',
  border: '1px solid #c44'
}

const emptyStateStyle: React.CSSProperties = {
  color: '#666',
  fontSize: 12,
  textAlign: 'center',
  padding: 40,
  fontStyle: 'italic'
}
