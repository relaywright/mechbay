import { useEffect, useRef, useState } from 'react'
import type { AgentFamily, Companion, CompanionConfigurePayload } from '../../../shared/types'
import {
  DEFAULT_AUTONOMY,
  autonomyRaisedBy,
  type EffectiveAutonomy
} from '../../../shared/autonomy'
import { ipcErrorMessage } from '../../../shared/bridge-errors'
import { RUNTIME_ENV, RUNTIME_OPTIONS } from '../runtime-options'
import { colors, type } from '../theme'
import { AutonomyControl } from './AutonomyControl'

interface SettingsModalProps {
  companions: Companion[]
  reduceMotion: boolean
  crtOverlay: boolean
  missionAlerts: boolean
  onClose: () => void
}

type SecretStatus = Record<AgentFamily, boolean>

const EMPTY_STATUS: SecretStatus = {
  claude: false,
  codex: false,
  kimi: false,
  gemini: false,
  hermes: false
}

export function SettingsModal({
  companions,
  reduceMotion,
  crtOverlay,
  missionAlerts,
  onClose
}: SettingsModalProps): React.JSX.Element {
  const [secretStatus, setSecretStatus] = useState<SecretStatus>(EMPTY_STATUS)
  const [motionReduced, setMotionReduced] = useState(reduceMotion)
  const [crtEnabled, setCrtEnabled] = useState(crtOverlay)
  const [alertsEnabled, setAlertsEnabled] = useState(missionAlerts)
  const closeRef = useRef<HTMLButtonElement>(null)

  // Keep the toggles in sync if the persisted value changes underneath us.
  // Adjusted during render (React's "store the previous prop" pattern)
  // rather than in an effect, which would render the stale value first.
  const [syncedReduceMotion, setSyncedReduceMotion] = useState(reduceMotion)
  if (reduceMotion !== syncedReduceMotion) {
    setSyncedReduceMotion(reduceMotion)
    setMotionReduced(reduceMotion)
  }
  const [syncedMissionAlerts, setSyncedMissionAlerts] = useState(missionAlerts)
  if (missionAlerts !== syncedMissionAlerts) {
    setSyncedMissionAlerts(missionAlerts)
    setAlertsEnabled(missionAlerts)
  }

  const toggleMotion = async (): Promise<void> => {
    const next = !motionReduced
    setMotionReduced(next) // optimistic; main broadcasts the authoritative value
    const result = await window.mechbay.updateSettings({ reduceMotion: next })
    if (!result.ok) {
      setMotionReduced(!next)
      alert(result.error)
    }
  }

  const toggleCrt = async (): Promise<void> => {
    const next = !crtEnabled
    setCrtEnabled(next)
    const result = await window.mechbay.updateSettings({ crtOverlay: next })
    if (!result.ok) {
      setCrtEnabled(!next)
      alert(result.error)
    }
  }

  const toggleAlerts = async (): Promise<void> => {
    const next = !alertsEnabled
    setAlertsEnabled(next)
    const result = await window.mechbay.updateSettings({ missionAlerts: next })
    if (!result.ok) {
      setAlertsEnabled(!next)
      alert(result.error)
    }
  }

  const refreshStatus = async (): Promise<void> => {
    setSecretStatus(await window.mechbay.secretsStatus())
  }

  useEffect(() => {
    let cancelled = false
    void window.mechbay.secretsStatus().then((status) => {
      if (!cancelled) setSecretStatus(status)
    })
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      cancelled = true
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const resetField = async (): Promise<void> => {
    if (
      !confirm(
        'Reset the bay to the six starter buildings? All placed/imported buildings are removed (project folders on disk are untouched).'
      )
    ) {
      return
    }
    const result = await window.mechbay.fieldReset()
    if (!result.ok) alert(result.error)
  }

  return (
    <div
      style={backdropStyle}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        className="mech-settings-panel"
        style={panelStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header style={headerStyle}>
          <div>
            <div id="settings-title" style={titleStyle}>
              MECH SETTINGS
            </div>
            <div style={subtitleStyle}>CALLSIGNS · RUNTIME LOADOUT · LAUNCH CREDENTIALS</div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            style={closeStyle}
            aria-label="Close settings"
          >
            ×
          </button>
        </header>

        <div style={manifestStyle}>
          {companions.map((companion, index) => (
            <MechSettingsRow
              key={companion.id}
              companion={companion}
              index={index + 1}
              secretStatus={secretStatus}
              refreshStatus={refreshStatus}
            />
          ))}
        </div>

        <section style={bayStyle}>
          <div>
            <div style={sectionLabelStyle}>MOTION</div>
            <div style={bayHintStyle}>
              {motionReduced
                ? 'Reduced: the bay holds still. No idle sway, walk bob, or beacon blinks.'
                : 'Full: mechs breathe, march with a walk cycle, and beacons pulse.'}
            </div>
          </div>
          <button
            type="button"
            style={toggleButtonStyle(motionReduced)}
            role="switch"
            aria-checked={!motionReduced}
            onClick={() => void toggleMotion()}
          >
            {motionReduced ? 'MOTION: REDUCED' : 'MOTION: FULL'}
          </button>
        </section>

        <section style={bayStyle}>
          <div>
            <div style={sectionLabelStyle}>CRT OVERLAY</div>
            <div style={bayHintStyle}>
              {crtEnabled
                ? 'On: subtle scanlines and edge shading sit over the command glass.'
                : 'Off: the display renders without analog screen texture.'}
            </div>
          </div>
          <button
            type="button"
            style={toggleButtonStyle(!crtEnabled)}
            role="switch"
            aria-checked={crtEnabled}
            onClick={() => void toggleCrt()}
          >
            {crtEnabled ? 'CRT: ON' : 'CRT: OFF'}
          </button>
        </section>

        <section style={bayStyle}>
          <div>
            <div style={sectionLabelStyle}>MISSION ALERTS</div>
            <div style={bayHintStyle}>
              {alertsEnabled
                ? 'On: a desktop notification and taskbar flash fire when a mech returns, needs input, or goes down while the window is unfocused.'
                : 'Off: mission outcomes only show up inside MechBay.'}
            </div>
          </div>
          <button
            type="button"
            style={toggleButtonStyle(!alertsEnabled)}
            role="switch"
            aria-checked={alertsEnabled}
            onClick={() => void toggleAlerts()}
          >
            {alertsEnabled ? 'ALERTS: ON' : 'ALERTS: OFF'}
          </button>
        </section>

        <section style={bayStyle}>
          <div>
            <div style={sectionLabelStyle}>BAY</div>
            <div style={bayHintStyle}>
              Restore the six starter buildings with fresh IDs. Project folders remain untouched.
            </div>
          </div>
          <button type="button" style={dangerButtonStyle} onClick={() => void resetField()}>
            RESET FIELD
          </button>
        </section>
      </section>
      <style>{`
        @keyframes settingsDock { from { opacity: 0; transform: translateY(10px) scale(.99); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @media (prefers-reduced-motion: reduce) { .mech-settings-panel { animation: none !important; } }
      `}</style>
    </div>
  )
}

function MechSettingsRow({
  companion,
  index,
  secretStatus,
  refreshStatus
}: {
  companion: Companion
  index: number
  secretStatus: SecretStatus
  refreshStatus: () => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState(companion.name)
  const [runtime, setRuntime] = useState<AgentFamily>(companion.runtime ?? companion.family)
  const [model, setModel] = useState(companion.model ?? '')
  const [keyValue, setKeyValue] = useState('')
  const [pending, setPending] = useState<'name' | 'runtime' | 'autonomy' | 'key' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The saved runtime, not the dropdown's unapplied choice: a level change
  // saves at once and is checked against the runtime the mech runs today.
  const savedRuntime = companion.runtime ?? companion.family

  const apply = async (
    kind: 'name' | 'runtime' | 'autonomy',
    payload: CompanionConfigurePayload
  ): Promise<void> => {
    setPending(kind)
    setError(null)
    try {
      const result = await window.mechbay.configureCompanion(payload)
      if (!result.ok) setError(result.error)
    } catch (err) {
      console.error('[settings] configureCompanion failed', err)
      setError(ipcErrorMessage(err))
    } finally {
      setPending(null)
    }
  }

  // A runtime switch that would let missions do more than today (Read only on
  // Claude runs at Full on Gemini) waits for an explicit confirmation.
  const [confirmRaise, setConfirmRaise] = useState<EffectiveAutonomy | null>(null)

  const saveName = (): Promise<void> => apply('name', { companionId: companion.id, name })

  const applyRuntime = async (accepted?: EffectiveAutonomy): Promise<void> => {
    const raised = autonomyRaisedBy(savedRuntime, runtime, companion.autonomy ?? DEFAULT_AUTONOMY)
    if (raised !== undefined && accepted !== raised) {
      setError(null)
      setConfirmRaise(raised)
      return
    }
    setConfirmRaise(null)
    await apply('runtime', {
      companionId: companion.id,
      runtime,
      model,
      ...(raised !== undefined ? { acceptAutonomy: raised } : {})
    })
  }

  const runtimeLabel = RUNTIME_OPTIONS.find((o) => o.value === runtime)?.label ?? runtime

  const saveSecret = async (value: string): Promise<void> => {
    setPending('key')
    setError(null)
    try {
      const result = await window.mechbay.secretsSet(runtime, value)
      if (!result.ok) {
        setError(result.error ?? 'Could not save key')
        return
      }
      setKeyValue('')
      await refreshStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

  const envName = RUNTIME_ENV[runtime]

  return (
    <article style={rowStyle}>
      <div style={rowHeadingStyle}>
        <span style={indexStyle}>{String(index).padStart(2, '0')}</span>
        <span style={mechClassStyle}>{companion.mechClass.toUpperCase()}</span>
        <span style={familyStyle}>FRAME: {companion.family.toUpperCase()}</span>
      </div>

      <div style={controlGridStyle}>
        <label style={fieldStyle}>
          <span style={labelStyle}>CALLSIGN</span>
          <span style={inlineControlStyle}>
            <input
              style={inputStyle}
              value={name}
              maxLength={24}
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="button"
              style={actionButtonStyle}
              disabled={pending !== null}
              onClick={() => void saveName()}
            >
              SAVE
            </button>
          </span>
        </label>

        <label style={fieldStyle}>
          <span style={labelStyle}>RUNTIME / MODEL</span>
          <span style={inlineControlStyle}>
            <select
              style={{ ...inputStyle, flex: '0 0 150px' }}
              value={runtime}
              onChange={(event) => {
                setRuntime(event.target.value as AgentFamily)
                setKeyValue('')
                setError(null)
                setConfirmRaise(null)
              }}
            >
              {RUNTIME_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <input
              style={inputStyle}
              value={model}
              placeholder="model override (optional)"
              onChange={(event) => setModel(event.target.value)}
            />
            <button
              type="button"
              style={actionButtonStyle}
              disabled={pending !== null}
              onClick={() => void applyRuntime()}
            >
              APPLY
            </button>
          </span>
        </label>

        {confirmRaise && (
          <div style={fieldStyle}>
            <span />
            <div role="alert" aria-label="Confirm runtime switch" style={confirmStyle}>
              <p style={confirmTextStyle}>
                {confirmRaise === 'unenforced'
                  ? `${runtimeLabel} controls its own permissions, so MechBay cannot limit what this mech does.`
                  : `On ${runtimeLabel}, this mech runs at Full: it can change files and run any command without asking.`}{' '}
                Missions already waiting in the queue will run this way too.
              </p>
              <span style={inlineControlStyle}>
                <button
                  type="button"
                  style={dangerActionStyle}
                  disabled={pending !== null}
                  onClick={() => void applyRuntime(confirmRaise)}
                >
                  SWITCH ANYWAY
                </button>
                <button
                  type="button"
                  style={clearButtonStyle}
                  disabled={pending !== null}
                  onClick={() => setConfirmRaise(null)}
                >
                  CANCEL
                </button>
              </span>
            </div>
          </div>
        )}

        <div style={fieldStyle}>
          <span style={labelStyle}>AUTONOMY</span>
          <AutonomyControl
            runtime={savedRuntime}
            value={companion.autonomy ?? DEFAULT_AUTONOMY}
            disabled={pending !== null}
            onChange={(level) =>
              void apply('autonomy', { companionId: companion.id, autonomy: level })
            }
          />
        </div>

        <div style={fieldStyle}>
          <span style={labelStyle}>API KEY</span>
          {runtime === 'claude' ? (
            <div style={loginNoteStyle}>Uses your Claude Code login, so no key is needed</div>
          ) : (
            <>
              <div style={inlineControlStyle}>
                <input
                  style={inputStyle}
                  type="password"
                  autoComplete="off"
                  value={keyValue}
                  placeholder={secretStatus[runtime] ? '••••••• saved' : 'not set'}
                  onChange={(event) => setKeyValue(event.target.value)}
                />
                <button
                  type="button"
                  style={actionButtonStyle}
                  disabled={pending !== null || !keyValue.trim()}
                  onClick={() => void saveSecret(keyValue)}
                >
                  SAVE
                </button>
                <button
                  type="button"
                  style={clearButtonStyle}
                  disabled={pending !== null || !secretStatus[runtime]}
                  onClick={() => void saveSecret('')}
                >
                  CLEAR
                </button>
              </div>
              <div style={keyHintStyle}>stored encrypted · injected as {envName}</div>
            </>
          )}
        </div>
      </div>
      {error && <div style={errorStyle}>⚠ {error}</div>}
    </article>
  )
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 120,
  background: colors.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24
}
const panelStyle: React.CSSProperties = {
  width: 'min(980px, 94vw)',
  maxHeight: '88vh',
  overflow: 'auto',
  background: colors.bgHud,
  border: `2px solid ${colors.orange}`,
  boxShadow: `0 0 34px ${colors.orangeGlow}`,
  fontFamily: type.mono,
  color: colors.textPrimary,
  animation: 'settingsDock .24s ease-out'
}
const headerStyle: React.CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '16px 18px',
  background: colors.bgHud,
  borderBottom: `1px solid ${colors.orange}`
}
const titleStyle: React.CSSProperties = {
  color: colors.amber,
  fontSize: 17,
  fontWeight: 800,
  letterSpacing: type.labelTracking
}
const subtitleStyle: React.CSSProperties = {
  marginTop: 4,
  color: colors.textSecondary,
  fontSize: 9,
  letterSpacing: type.hudTracking
}
const closeStyle: React.CSSProperties = {
  background: 'transparent',
  border: 0,
  color: colors.orange,
  font: 'inherit',
  fontSize: 22,
  cursor: 'pointer'
}
const manifestStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column' }
const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '135px 1fr',
  gap: 16,
  padding: '14px 18px',
  borderBottom: `1px solid ${colors.borderHud}`
}
const rowHeadingStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
  borderRight: `1px solid ${colors.borderHud}`,
  paddingRight: 12
}
const indexStyle: React.CSSProperties = {
  color: colors.orange,
  fontSize: 9,
  letterSpacing: type.labelTracking
}
const mechClassStyle: React.CSSProperties = { color: colors.amber, fontSize: 13, fontWeight: 800 }
const familyStyle: React.CSSProperties = { color: colors.textMuted, fontSize: 9 }
const controlGridStyle: React.CSSProperties = { display: 'grid', gap: 9 }
const fieldStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '112px 1fr',
  gap: 10,
  alignItems: 'center'
}
const labelStyle: React.CSSProperties = {
  color: colors.textSecondary,
  fontSize: 9,
  letterSpacing: type.labelTracking
}
const inlineControlStyle: React.CSSProperties = { display: 'flex', minWidth: 0, gap: 6 }
const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: colors.bgPanelDark,
  border: `1px solid ${colors.borderHud}`,
  color: colors.textPrimary,
  fontFamily: type.mono,
  fontSize: 11,
  padding: '6px 8px',
  outlineColor: colors.orange
}
const actionButtonStyle: React.CSSProperties = {
  background: colors.amberTint,
  border: `1px solid ${colors.amber}`,
  color: colors.amber,
  fontFamily: type.mono,
  fontSize: 9,
  fontWeight: 800,
  padding: '5px 10px',
  cursor: 'pointer'
}
const clearButtonStyle: React.CSSProperties = {
  ...actionButtonStyle,
  background: 'transparent',
  borderColor: colors.textMuted,
  color: colors.textSecondary
}
const keyHintStyle: React.CSSProperties = {
  gridColumn: 2,
  marginTop: 4,
  color: colors.textMuted,
  fontSize: 9
}
const loginNoteStyle: React.CSSProperties = {
  color: colors.textSecondary,
  fontSize: 10,
  padding: '6px 0'
}
const confirmStyle: React.CSSProperties = {
  display: 'grid',
  gap: 8,
  padding: '8px 10px',
  border: `1px solid ${colors.statusFailedLight}`,
  background: 'rgba(255, 107, 107, 0.08)'
}
const confirmTextStyle: React.CSSProperties = {
  margin: 0,
  color: colors.textPrimary,
  fontSize: 10,
  lineHeight: 1.5
}
const dangerActionStyle: React.CSSProperties = {
  ...actionButtonStyle,
  background: 'transparent',
  borderColor: colors.statusFailedLight,
  color: colors.statusFailedLight
}
const errorStyle: React.CSSProperties = {
  gridColumn: 2,
  color: colors.statusFailedLight,
  fontSize: 10,
  marginTop: 4
}
const bayStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 20,
  padding: 18,
  background: colors.bgPanelDark,
  borderTop: `1px solid ${colors.orange}`
}
const sectionLabelStyle: React.CSSProperties = {
  color: colors.amber,
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: type.labelTracking
}
const bayHintStyle: React.CSSProperties = { color: colors.textSecondary, fontSize: 9, marginTop: 5 }
const toggleButtonStyle = (reduced: boolean): React.CSSProperties => ({
  background: reduced ? 'transparent' : colors.amberTint,
  border: `1px solid ${reduced ? colors.textMuted : colors.amber}`,
  color: reduced ? colors.textSecondary : colors.amber,
  fontFamily: type.mono,
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: type.hudTracking,
  padding: '8px 14px',
  cursor: 'pointer',
  whiteSpace: 'nowrap'
})
const dangerButtonStyle: React.CSSProperties = {
  background: 'rgba(255,82,82,.07)',
  border: `1px solid ${colors.statusFailed}`,
  color: colors.statusFailedLight,
  fontFamily: type.mono,
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: type.hudTracking,
  padding: '8px 14px',
  cursor: 'pointer'
}
