import { useEffect } from 'react'
import type { Deployment } from '../../../shared/types'
import { STATUS_LABELS } from '../operations'
import { colors, fontSize } from '../theme'

/**
 * Shown once on boot when the main process finds missions left open by a
 * previous run (force-quit, crash, etc.). Purely informational: the sweep
 * already marked running missions failed and cancelled queued ones; this
 * modal is a dismissible receipt so the pilot knows what got cleaned up.
 */
export function CrashRecoveryModal(props: {
  zombies: Deployment[]
  onDismiss: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Enter') props.onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props])

  return (
    <div
      style={backdropStyle}
      className="holo-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onDismiss()
      }}
    >
      <div style={panelStyle} className="holo-panel">
        <div style={headerStyle}>⚠ CRASH RECOVERY</div>
        <div style={subheaderStyle}>
          {props.zombies.length === 1 ? '1 mission' : `${props.zombies.length} missions`} did not
          finish because MechBay closed unexpectedly.
        </div>

        <ul style={listStyle}>
          {props.zombies.map((z) => (
            <li key={z.id} style={itemStyle}>
              <span style={idStyle}>{z.id.slice(-8)}</span>
              <span style={sepStyle}>·</span>
              <span style={statusStyle}>{STATUS_LABELS[z.status]}</span>
              <span style={sepStyle}>·</span>
              <span>{z.taskPrompt.slice(0, 80)}</span>
              {z.taskPrompt.length > 80 && <span style={ellipsisStyle}>…</span>}
            </li>
          ))}
        </ul>

        <div style={actionRowStyle}>
          <button type="button" onClick={props.onDismiss} style={dismissButtonStyle}>
            ACKNOWLEDGED
          </button>
        </div>
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
  zIndex: 110
}

const panelStyle: React.CSSProperties = {
  background: '#1a1510',
  border: '2px solid #c44',
  boxShadow: '0 0 24px rgba(196, 68, 68, 0.3)',
  padding: 24,
  minWidth: 520,
  maxWidth: 700,
  color: '#e85f00',
  fontFamily: '"Courier New", monospace'
}

const headerStyle: React.CSSProperties = {
  fontSize: 14,
  letterSpacing: '0.15em',
  fontWeight: 'bold',
  color: '#ff6b6b',
  marginBottom: 6
}

const subheaderStyle: React.CSSProperties = {
  fontSize: fontSize.body,
  color: '#ccc',
  marginBottom: 16,
  lineHeight: 1.5
}

const listStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: '0 0 16px 0',
  maxHeight: 240,
  overflow: 'auto',
  background: '#0a0805',
  border: '1px solid #2a2520',
  padding: 10
}

const itemStyle: React.CSSProperties = {
  fontSize: fontSize.small,
  color: '#ccc',
  padding: '4px 0',
  borderBottom: '1px dotted #2a2520'
}

const idStyle: React.CSSProperties = {
  color: '#ffcc33',
  fontWeight: 'bold'
}

const sepStyle: React.CSSProperties = {
  color: colors.textMuted,
  margin: '0 6px'
}

const statusStyle: React.CSSProperties = {
  color: '#ff6b6b',
  textTransform: 'uppercase'
}

const ellipsisStyle: React.CSSProperties = {
  color: colors.textMuted
}

const actionRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end'
}

const dismissButtonStyle: React.CSSProperties = {
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
