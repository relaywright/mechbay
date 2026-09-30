import { useEffect, useState } from 'react'
import type { AppState } from '../../../shared/types'
import { lanceHeat } from '../cockpit'
import { fleetTelemetry, STATUS_LABELS } from '../operations'

const TICKER_INTERVAL_MS = 4000

/**
 * Rotating header readouts. Every entry is read straight from persisted
 * state: counts, the newest finished sortie, and any mech waiting on input.
 */
function tickerItems(state: AppState | null): string[] {
  if (!state) return []
  const telemetry = fleetTelemetry(state)
  const name = (companionId: string): string =>
    state.companions.find((c) => c.id === companionId)?.name.toUpperCase() ?? 'ARCHIVED MECH'
  const items: string[] = state.deployments
    .filter((d) => d.status === 'awaiting-input')
    .map((d) => `${name(d.companionId)} NEEDS INPUT`)
  items.push(`${String(telemetry.queued).padStart(2, '0')} QUEUED`)
  items.push(`${telemetry.linked} PROJECT${telemetry.linked === 1 ? '' : 'S'} LINKED`)
  const finished = state.deployments
    .filter((d) => ['completed', 'failed', 'cancelled'].includes(d.status))
    .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt))[0]
  if (finished) {
    items.push(
      `LAST SORTIE ${name(finished.companionId)} · ${STATUS_LABELS[finished.status].toUpperCase()}`
    )
  }
  return items
}

/**
 * Cockpit-style heat gauge for the lance: one segment per concurrency slot,
 * lit per active mission, running hot when every slot is taken.
 */
function LanceGauge({ state }: { state: AppState | null }): React.JSX.Element {
  const heat = state ? lanceHeat(state) : null
  const cap = heat?.cap ?? state?.settings.concurrencyCap ?? 3
  const active = heat?.active ?? 0
  return (
    <span
      className={`lance-gauge band-${heat?.band ?? 'cool'}`}
      role="meter"
      aria-label={`Lance heat: ${active} of ${cap} slots active${heat?.queued ? `, ${heat.queued} queued` : ''}`}
      aria-valuemin={0}
      aria-valuemax={cap}
      aria-valuenow={active}
    >
      <span className="lance-gauge-label">HEAT</span>
      <span className="lance-gauge-cells" aria-hidden="true">
        {Array.from({ length: cap }, (_, i) => (
          <i key={i} className={i < active ? 'is-lit' : ''} />
        ))}
      </span>
      <span aria-hidden="true">
        {active} OF {cap} ACTIVE
        {heat?.queued ? ` +${heat.queued}Q` : ''}
      </span>
    </span>
  )
}

export function HudHeader({
  state,
  demo,
  onBulkImportClick,
  onSettingsClick
}: {
  state: AppState | null
  demo: boolean
  onBulkImportClick: () => void
  onSettingsClick: () => void
}): React.JSX.Element {
  const items = tickerItems(state)
  const [tick, setTick] = useState(0)
  // Count state broadcasts so the LINK lamp blinks on each real update.
  const [link, setLink] = useState({ state, received: 0 })
  if (link.state !== state) setLink({ state, received: link.received + 1 })

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), TICKER_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [])

  const tickerText = items.length > 0 ? items[tick % items.length] : null
  return (
    <header className="command-header">
      <div className="brand-lockup">
        <svg className="brand-mark" viewBox="0 0 40 44" fill="none" aria-hidden="true">
          <path d="M20 2 37 12v20L20 42 3 32V12Z" stroke="currentColor" strokeWidth="2" />
          <path d="M11 29V16l9 8 9-8v13M20 24v11" stroke="currentColor" strokeWidth="3" />
          <path d="m14 10 6-3 6 3" stroke="currentColor" />
        </svg>
        <div>
          <h1>
            MECH<span>BAY</span>
            <sup> / 01</sup>
          </h1>
          <p>AGENT OPERATIONS COMMAND</p>
        </div>
      </div>
      <div className="command-state">
        <span className="status-dot" />
        <span>{demo ? 'SIMULATION ONLINE' : 'LOCAL COMMAND ONLINE'}</span>
        <span className="header-separator">/</span>
        <LanceGauge state={state} />
        <span className="header-separator">/</span>
        <span className="link-indicator" title="Blinks when the bay receives a state update">
          <i key={link.received} className="link-lamp" aria-hidden="true" />
          LINK
        </span>
        {tickerText && (
          <>
            <span className="header-separator">/</span>
            <span className="header-ticker" aria-live="off">
              <span key={`${tick}:${tickerText}`} className="header-ticker-item">
                {tickerText}
              </span>
            </span>
          </>
        )}
      </div>
      <nav aria-label="Bay configuration">
        <button className="secondary-action" onClick={onBulkImportClick}>
          + Import projects
        </button>
        <button className="secondary-action settings-action" onClick={onSettingsClick}>
          <span aria-hidden="true">⚙</span> Settings
        </button>
      </nav>
    </header>
  )
}
