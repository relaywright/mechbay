import { useEffect, useState, useCallback } from 'react'
import type { DiscoveredProject } from '../../../shared/types'
import { colors, fontSize } from '../theme'
import { ipcErrorMessage } from '../../../shared/bridge-errors'

interface BulkImportModalProps {
  onClose: () => void
}

export function BulkImportModal({ onClose }: BulkImportModalProps): React.JSX.Element {
  const [projects, setProjects] = useState<DiscoveredProject[]>([])
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = useState(true)
  const [isImporting, setIsImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importResult, setImportResult] = useState<{ imported: number } | null>(null)

  // Load projects on open
  useEffect(() => {
    const loadProjects = async (): Promise<void> => {
      try {
        setIsLoading(true)
        const results = await window.mechbay.scanProjects()
        setProjects(results)
      } catch (e) {
        setError(ipcErrorMessage(e))
      } finally {
        setIsLoading(false)
      }
    }

    void loadProjects()
  }, [])

  // ESC to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggleProject = useCallback((projectPath: string): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(projectPath)) {
        next.delete(projectPath)
      } else {
        next.add(projectPath)
      }
      return next
    })
  }, [])

  const handleImport = useCallback(async (): Promise<void> => {
    if (selectedPaths.size === 0) return

    setIsImporting(true)
    setError(null)

    try {
      const result = await window.mechbay.bulkImportRun(Array.from(selectedPaths))
      if (result.ok) {
        setImportResult({ imported: result.imported })
        // Auto-close after a brief delay to show success
        setTimeout(() => onClose(), 1500)
      } else {
        setError(result.error)
      }
    } catch (e) {
      setError(ipcErrorMessage(e))
    } finally {
      setIsImporting(false)
    }
  }, [selectedPaths, onClose])

  const selectAll = useCallback((): void => {
    setSelectedPaths(new Set(projects.map((p) => p.path)))
  }, [projects])

  const selectNone = useCallback((): void => {
    setSelectedPaths(new Set())
  }, [])

  return (
    <div
      style={backdropStyle}
      className="holo-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div style={panelStyle} className="holo-panel">
        <div style={headerStyle}>
          <span>BULK IMPORT</span>
          <button type="button" onClick={onClose} style={closeButtonStyle}>
            ×
          </button>
        </div>

        {isLoading && <div style={loadingStyle}>Scanning projects...</div>}

        {error && <div style={errorStyle}>⚠ {error}</div>}

        {importResult && (
          <div style={successStyle}>✓ Imported {importResult.imported} project(s)</div>
        )}

        {!isLoading && projects.length === 0 && (
          <div style={emptyStyle}>
            No projects found. Check your Projects directory in settings.
          </div>
        )}

        {!isLoading && projects.length > 0 && (
          <>
            <div style={actionsRowStyle}>
              <button type="button" onClick={selectAll} style={smallButtonStyle}>
                Select All
              </button>
              <button type="button" onClick={selectNone} style={smallButtonStyle}>
                Select None
              </button>
              <span style={countStyle}>
                {selectedPaths.size} / {projects.length} selected
              </span>
            </div>

            <div style={listStyle}>
              {projects.map((project) => (
                <label key={project.path} style={itemStyle}>
                  <input
                    type="checkbox"
                    checked={selectedPaths.has(project.path)}
                    onChange={() => toggleProject(project.path)}
                    style={checkboxStyle}
                  />
                  <span style={itemNameStyle}>{project.name}</span>
                  <span style={itemMarkersStyle}>{project.markers.slice(0, 2).join(', ')}</span>
                </label>
              ))}
            </div>

            <div style={footerStyle}>
              <button type="button" onClick={onClose} style={cancelButtonStyle}>
                CANCEL
              </button>
              <button
                type="button"
                onClick={handleImport}
                disabled={selectedPaths.size === 0 || isImporting}
                style={{
                  ...importButtonStyle,
                  ...(selectedPaths.size === 0 || isImporting ? importButtonDisabledStyle : {})
                }}
              >
                {isImporting ? 'IMPORTING...' : `IMPORT SELECTED (${selectedPaths.size})`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.75)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100
}

const panelStyle: React.CSSProperties = {
  background: '#1a1510',
  border: '2px solid #e85f00',
  boxShadow: '0 0 24px rgba(232, 95, 0, 0.3)',
  padding: 24,
  minWidth: 480,
  maxWidth: 640,
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
  color: '#e85f00',
  fontFamily: '"Courier New", monospace'
}

const headerStyle: React.CSSProperties = {
  fontSize: 14,
  letterSpacing: '0.1em',
  fontWeight: 'bold',
  marginBottom: 16,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  borderBottom: '1px solid #2a2520',
  paddingBottom: 12
}

const closeButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 0,
  color: '#888',
  fontSize: 20,
  cursor: 'pointer',
  fontFamily: 'inherit',
  padding: '0 4px'
}

const loadingStyle: React.CSSProperties = {
  color: '#888',
  fontSize: fontSize.body,
  padding: 20,
  textAlign: 'center'
}

const errorStyle: React.CSSProperties = {
  background: '#2a1510',
  border: '1px solid #c44',
  color: '#ff6b6b',
  padding: '10px 12px',
  fontSize: fontSize.small,
  marginBottom: 12
}

const successStyle: React.CSSProperties = {
  background: '#1a2a15',
  border: '1px solid #4c4',
  color: '#4c4',
  padding: '10px 12px',
  fontSize: fontSize.small,
  marginBottom: 12
}

const emptyStyle: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: fontSize.body,
  padding: 20,
  textAlign: 'center',
  fontStyle: 'italic'
}

const actionsRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginBottom: 12,
  alignItems: 'center'
}

const smallButtonStyle: React.CSSProperties = {
  background: '#2a2520',
  color: '#ffcc33',
  border: '1px solid #ffcc33',
  padding: '4px 10px',
  fontSize: fontSize.small,
  letterSpacing: '0.05em',
  cursor: 'pointer',
  fontFamily: 'inherit'
}

const countStyle: React.CSSProperties = {
  marginLeft: 'auto',
  fontSize: fontSize.small,
  color: '#888'
}

const listStyle: React.CSSProperties = {
  flex: 1,
  overflow: 'auto',
  maxHeight: 320,
  border: '1px solid #2a2520',
  background: '#0a0805',
  marginBottom: 16
}

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  borderBottom: '1px solid #1a1510',
  cursor: 'pointer',
  fontSize: fontSize.body
}

const checkboxStyle: React.CSSProperties = {
  cursor: 'pointer'
}

const itemNameStyle: React.CSSProperties = {
  color: '#eee',
  flex: 1
}

const itemMarkersStyle: React.CSSProperties = {
  color: colors.textMuted,
  fontSize: fontSize.small
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
  borderTop: '1px solid #2a2520',
  paddingTop: 16
}

const cancelButtonStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#aaa',
  border: '1px solid #555',
  padding: '8px 20px',
  fontSize: fontSize.body,
  letterSpacing: '0.1em',
  cursor: 'pointer',
  fontFamily: 'inherit'
}

const importButtonStyle: React.CSSProperties = {
  background: '#e85f00',
  color: '#000',
  border: 0,
  padding: '8px 20px',
  fontSize: fontSize.body,
  fontWeight: 'bold',
  letterSpacing: '0.1em',
  cursor: 'pointer',
  fontFamily: 'inherit'
}

const importButtonDisabledStyle: React.CSSProperties = {
  background: '#3a2a1a',
  color: '#8b8270',
  cursor: 'not-allowed'
}
