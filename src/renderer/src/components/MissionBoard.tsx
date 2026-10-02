import { useEffect, useState } from 'react'
import type { AppState, Deployment } from '../../../shared/types'
import { canDispatch, isActiveMission, missionDuration, noun, STATUS_LABELS } from '../operations'
import { CREW, RUNTIME_NAMES } from '../crew'

export function MissionBoard({
  state,
  selectedId,
  demo,
  onSelect,
  onDeploy,
  onReview,
  onFacility,
  onJournal,
  onLog
}: {
  state: AppState
  selectedId: string | null
  demo: boolean
  onSelect: (id: string) => void
  onDeploy: (companionId: string, facilityId: string) => void
  onReview: (id: string) => void
  onFacility: (id: string) => void
  onJournal: () => void
  onLog: () => void
}): React.JSX.Element {
  const linked = state.facilities.filter((f) => f.path)
  const [targetId, setTargetId] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const hasActiveMission = state.deployments.some(isActiveMission)
  const companion = state.companions.find((c) => c.id === selectedId) ?? state.companions[0]
  const target = linked.find((f) => f.id === targetId) ?? linked[0]
  const missions = [...state.deployments]
    .sort((a, b) => {
      const priority = (d: Deployment): number =>
        isActiveMission(d) ? 0 : d.status === 'queued' ? 1 : 2
      return priority(a) - priority(b) || b.startedAt - a.startedAt
    })
    .slice(0, 6)

  useEffect(() => {
    if (!hasActiveMission) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [hasActiveMission])

  return (
    <div className="operations-scroll">
      <section className="dispatch-panel">
        <div className="section-caption">
          <span>01 / MISSION BRIEF</span>
          <span className="signal-text">{demo ? 'SIMULATION' : 'LOCAL RUNTIMES'}</span>
        </div>
        <h2>{demo ? 'Take command.' : 'Your next move.'}</h2>
        <p className="dispatch-intro">
          {demo
            ? 'Try a sortie. The agent is simulated. The files and mission debrief are real.'
            : 'Choose your crew and a project. Give the mission a clear objective.'}
        </p>
        <label className="field-label" htmlFor="dispatch-mech">
          ASSIGNED MECH
        </label>
        <select
          id="dispatch-mech"
          value={companion?.id ?? ''}
          onChange={(e) => onSelect(e.target.value)}
        >
          {state.companions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {RUNTIME_NAMES[c.runtime ?? c.family]}
            </option>
          ))}
        </select>
        <label className="field-label" htmlFor="dispatch-target">
          PROJECT FACILITY
        </label>
        <select
          id="dispatch-target"
          value={target?.id ?? ''}
          onChange={(e) => setTargetId(e.target.value)}
          disabled={!linked.length}
        >
          {!linked.length && <option value="">Link a project to begin</option>}
          {linked.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
        <button
          className="primary-action dispatch-button"
          disabled={!companion || !target || !canDispatch(companion, state.deployments)}
          onClick={() => companion && target && onDeploy(companion.id, target.id)}
        >
          Prepare deployment <span aria-hidden="true">↗</span>
        </button>
        {companion && !canDispatch(companion, state.deployments) && (
          <p className="dispatch-hint">
            {companion.cliAvailable
              ? 'This mech is already assigned. Choose a ready crew member.'
              : 'This runtime needs setup. Open Settings to configure it.'}
          </p>
        )}
        <button className="text-action" onClick={onJournal}>
          Inspect {companion ? CREW[companion.mechClass].code : 'crew'} personality &amp; memory{' '}
          <span>→</span>
        </button>
      </section>
      <section className="mission-section" aria-label="Mission history">
        <div className="section-caption">
          <span>02 / SORTIE BOARD</span>
          <span>
            {state.deployments.length.toString().padStart(2, '0')}{' '}
            {noun(state.deployments.length, 'MISSION')}
          </span>
        </div>
        {missions.length === 0 ? (
          <div className="mission-empty">
            <span className="empty-reticle" aria-hidden="true">
              ⌖
            </span>
            <div>
              <strong>Standing by for your first mission.</strong>
              <p>Deploy a mech to see its progress and review the changes when it returns.</p>
            </div>
          </div>
        ) : (
          missions.map((d) => {
            const mech = state.companions.find((c) => c.id === d.companionId)
            const facility = state.facilities.find((f) => f.id === d.facilityId)
            return (
              <button
                key={d.id}
                className={`mission-row status-${d.status}`}
                onClick={() => (d.status === 'completed' ? onReview(d.id) : onLog())}
                aria-label={
                  d.status === 'completed'
                    ? `Review mission: ${mech?.name}`
                    : `View mission log: ${mech?.name}`
                }
              >
                <div className="mission-row-top">
                  <strong>{mech?.name ?? 'Archived mech'}</strong>
                  <span className="mission-state">
                    <i />
                    {STATUS_LABELS[d.status]}
                  </span>
                </div>
                <span className="mission-objective">{d.taskPrompt}</span>
                <div className="mission-meta">
                  <span>{facility?.name ?? 'Archived facility'}</span>
                  <span>
                    {missionDuration(d, now)} <span aria-hidden="true">↗</span>
                  </span>
                </div>
                {d.diffStats && (
                  <div className="mission-delta">
                    {d.diffStats.filesChanged} {noun(d.diffStats.filesChanged, 'file')}{' '}
                    <span>+{d.diffStats.insertions}</span>
                    <em>−{d.diffStats.deletions}</em>
                    <b>View debrief →</b>
                  </div>
                )}
              </button>
            )
          })
        )}
      </section>
      <section className="facility-section" aria-label="Project facilities">
        <div className="section-caption">
          <span>03 / PROJECT FACILITIES</span>
          <span>{linked.length} LINKED</span>
        </div>
        {state.facilities.map((f, index) => (
          <button className="facility-row" key={f.id} onClick={() => onFacility(f.id)}>
            <span className="facility-index">{String(index + 1).padStart(2, '0')}</span>
            <span>{f.name}</span>
            <span className={f.path ? 'linked-label' : 'unlinked-label'}>
              {f.path ? 'Browse ↗' : 'Link +'}
            </span>
          </button>
        ))}
      </section>
    </div>
  )
}
