import { useEffect, useRef, useState } from 'react'
import type { AgentFamily, Companion } from '../../../shared/types'
import { RUNTIME_ENV, RUNTIME_OPTIONS } from '../runtime-options'
import { sfx } from '../audio/sfx'
import { colors, type } from '../theme'

interface SettingsModalProps {
  companions: Companion[]
  reduceMotion: boolean
  crtOverlay: boolean
  missionAlerts: boolean
  sound: boolean
  soundVolume: number
  onClose: () => void
}

type SecretStatus = Record<AgentFamily, boolean>

/** Quiet period after the last volume change before it's saved and previewed. */
const VOLUME_SETTLE_MS = 150

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
  sound,
  soundVolume,
  onClose
}: SettingsModalProps): React.JSX.Element {
  const [secretStatus, setSecretStatus] = useState<SecretStatus>(EMPTY_STATUS)
  const [motionReduced, setMotionReduced] = useState(reduceMotion)
  const [crtEnabled, setCrtEnabled] = useState(crtOverlay)
  const [alertsEnabled, setAlertsEnabled] = useState(missionAlerts)
  const [soundOn, setSoundOn] = useState(sound)
  const [volumeLevel, setVolumeLevel] = useState(soundVolume)
  const closeRef = useRef<HTMLButtonElement>(null)
  const volumeRef = useRef<HTMLInputElement>(null)
  const persistedVolumeRef = useRef(soundVolume)

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
  const [syncedSound, setSyncedSound] = useState(sound)
  if (sound !== syncedSound) {
    setSyncedSound(sound)
    setSoundOn(sound)
  }
  const [syncedSoundVolume, setSyncedSoundVolume] = useState(soundVolume)
  if (soundVolume !== syncedSoundVolume) {
    setSyncedSoundVolume(soundVolume)
    setVolumeLevel(soundVolume)
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

  const toggleSound = async (): Promise<void> => {
    const next = !soundOn
    setSoundOn(next)
    // Apply to the engine now, not on the round trip, so switching on is
    // confirmed by an audible click and switching off is instant.
    sfx.setEnabled(next)
    if (next) sfx.play('ui-click')
    const result = await window.mechbay.updateSettings({ sound: next })
    if (!result.ok) {
      setSoundOn(!next)
      sfx.setEnabled(!next)
      alert(result.error)
    }
  }

  useEffect(() => {
    persistedVolumeRef.current = soundVolume
  }, [soundVolume])

  // Dragging adjusts the engine live; the value is persisted (and previewed
  // with a short chirp) only on release. React's onChange fires on every
  // input event, so listen for the native commit-on-release `change`. A held
  // arrow key fires `change` per step, so settle briefly first: one preview
  // instead of a stutter, and no stale broadcast yanking the thumb back.
  useEffect(() => {
    const input = volumeRef.current
    if (!input) return
    let pending: ReturnType<typeof setTimeout> | null = null
    const commit = (preview: boolean): void => {
      pending = null
      const next = Number(input.value) / 100
      if (preview) sfx.play('select')
      if (next === persistedVolumeRef.current) return
      void window.mechbay.updateSettings({ soundVolume: next }).then((result) => {
        if (result.ok) return
        const previous = persistedVolumeRef.current
        setVolumeLevel(previous)
        sfx.setVolume(previous)
        alert(result.error)
      })
    }
    const onChange = (): void => {
      if (pending !== null) clearTimeout(pending)
      pending = setTimeout(() => commit(true), VOLUME_SETTLE_MS)
    }
    input.addEventListener('change', onChange)
    return () => {
      input.removeEventListener('change', onChange)
      // Closing mid-settle still saves what the user chose.
      if (pending !== null) {
        clearTimeout(pending)
        commit(false)
      }
    }
  }, [])

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
                ? 'Reduced — the bay holds still: no idle sway, walk bob, or beacon blinks.'
                : 'Full — mechs breathe, march with a walk cycle, and beacons pulse.'}
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
                ? 'On — subtle scanlines and edge shading sit over the command glass.'
                : 'Off — the display renders without analog screen texture.'}
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
            <div style={sectionLabelStyle}>SOUND</div>
            <div style={bayHintStyle}>
              {soundOn
                ? 'On: synthesized interface clicks, radio chatter, and mech footfalls over a low hangar hum.'
                : 'Off: the bay runs silent.'}
            </div>
          </div>
          <div style={soundControlsStyle}>
            <label style={volumeFieldStyle}>
              <span style={labelStyle}>VOLUME</span>
              <input
                ref={volumeRef}
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(volumeLevel * 100)}
                disabled={!soundOn}
                aria-label="Master volume"
                data-sfx="off"
                style={volumeSliderStyle(soundOn)}
                onChange={(event) => {
                  const next = Number(event.target.value) / 100
                  setVolumeLevel(next)
                  sfx.setVolume(next)
                }}
              />
              <span style={volumeReadoutStyle(soundOn)}>{Math.round(volumeLevel * 100)}%</span>
            </label>
            <button
              type="button"
              data-sfx="off"
              style={toggleButtonStyle(!soundOn)}
              role="switch"
              aria-checked={soundOn}
              onClick={() => void toggleSound()}
            >
              {soundOn ? 'SOUND: ON' : 'SOUND: OFF'}
            </button>
          </div>
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
  const [pending, setPending] = useState<'name' | 'runtime' | 'key' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const configure = async (kind: 'name' | 'runtime'): Promise<void> => {
    setPending(kind)
    setError(null)
    try {
      const result = await window.mechbay.configureCompanion(
        kind === 'name'
          ? { companionId: companion.id, name }
          : { companionId: companion.id, runtime, model }
      )
      if (!result.ok) setError(result.error)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(null)
    }
  }

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
              onClick={() => void configure('name')}
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
              onClick={() => void configure('runtime')}
            >
              APPLY
            </button>
          </span>
        </label>

        <div style={fieldStyle}>
          <span style={labelStyle}>API KEY</span>
          {runtime === 'claude' ? (
            <div style={loginNoteStyle}>Uses Claude Code login — no key needed</div>
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
const soundControlsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  flexShrink: 0
}
const volumeFieldStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 }
const volumeSliderStyle = (enabled: boolean): React.CSSProperties => ({
  width: 140,
  accentColor: colors.amber,
  cursor: enabled ? 'pointer' : 'default',
  opacity: enabled ? 1 : 0.4
})
const volumeReadoutStyle = (enabled: boolean): React.CSSProperties => ({
  width: 34,
  textAlign: 'right',
  color: enabled ? colors.amber : colors.textMuted,
  fontSize: 10,
  fontWeight: 800,
  fontVariantNumeric: 'tabular-nums'
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
