import type { AppState } from '../../../shared/types'
import { fleetTelemetry } from '../operations'
import { concurrencyCap } from '../../../shared/mission-queue'

export function HudHeader({
  state,
  demo,
  notSaving,
  onBulkImportClick,
  onSettingsClick
}: {
  state: AppState | null
  demo: boolean
  /** The saved bay is read-only this session (StateHealth not ok). */
  notSaving?: boolean
  onBulkImportClick: () => void
  onSettingsClick: () => void
}): React.JSX.Element {
  const telemetry = state && fleetTelemetry(state)
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
        {notSaving && (
          <>
            <span className="header-separator">/</span>
            <span
              className="not-saving"
              title="The saved bay is read-only this session. Changes are not saved."
            >
              NOT SAVING
            </span>
          </>
        )}
        <span className="header-separator">/</span>
        <span>
          {telemetry?.active ?? 0} OF {concurrencyCap(state?.settings.concurrencyCap)} ACTIVE
        </span>
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
