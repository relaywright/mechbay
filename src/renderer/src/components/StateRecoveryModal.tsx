import { useEffect } from 'react'
import type { StateHealth } from '../../../shared/types'
import { colors, type, fontSize } from '../theme'

type Problem = Extract<StateHealth, { ok: false }>['reason']

const TITLES: Record<Problem, string> = {
  'newer-version': 'Saved by a newer MechBay',
  'migration-failed': 'Your saved bay could not be upgraded',
  'read-failed': 'Your saved bay could not be read'
}

/** Explains, once per launch, anything unusual about loading the saved bay (P0-14). */
export function StateRecoveryModal({
  health,
  onDismiss
}: {
  health: StateHealth
  onDismiss: () => void
}): React.JSX.Element {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  const title = health.ok ? 'Started a fresh bay' : TITLES[health.reason]
  const body = health.ok ? health.notice : health.message
  return (
    <div style={backdropStyle}>
      <section
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="state-recovery-title"
        aria-describedby="state-recovery-body"
        style={{ ...panelStyle, borderColor: health.ok ? colors.orange : colors.statusFailedDark }}
      >
        <div style={eyebrowStyle}>SAVED BAY</div>
        <h2 id="state-recovery-title" style={titleStyle}>
          {title}
        </h2>
        <p id="state-recovery-body" style={bodyStyle}>
          {body}
        </p>
        {!health.ok && health.statePath && (
          <p style={pathStyle}>
            Saved file: <code>{health.statePath}</code>
          </p>
        )}
        <div style={actionsStyle}>
          <button type="button" autoFocus style={buttonStyle} onClick={onDismiss}>
            {health.ok ? 'OK' : 'Continue without saving'}
          </button>
        </div>
      </section>
    </div>
  )
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 130,
  background: colors.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24
}
const panelStyle: React.CSSProperties = {
  width: 'min(620px, 94vw)',
  background: colors.bgHud,
  border: '2px solid',
  padding: 24,
  fontFamily: type.mono,
  color: colors.textPrimary
}
const eyebrowStyle: React.CSSProperties = {
  color: colors.orange,
  fontSize: fontSize.small,
  letterSpacing: '0.16em'
}
const titleStyle: React.CSSProperties = {
  margin: '8px 0 12px',
  fontSize: 22,
  color: colors.textPrimary
}
const bodyStyle: React.CSSProperties = { margin: 0, lineHeight: 1.55 }
const pathStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: fontSize.body,
  wordBreak: 'break-all',
  color: colors.textMutedAlt
}
const actionsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginTop: 20
}
const buttonStyle: React.CSSProperties = {
  background: colors.orange,
  color: colors.bgPanelDark,
  border: 'none',
  padding: '10px 16px',
  fontFamily: type.mono,
  fontWeight: 700,
  cursor: 'pointer'
}
