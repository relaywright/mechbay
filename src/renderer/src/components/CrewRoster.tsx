import type { AppState } from '../../../shared/types'
import { CREW, RUNTIME_NAMES } from '../crew'
import { currentMission, missionStatusLabel } from '../operations'
import { computeServiceRecord } from '../service-record'
import { runtimeSupportNote } from '../../../shared/runtime-support'

/** Chevron insignia: nothing at Recruit, one glyph per tier above that. */
function RankInsignia({ tier }: { tier: number }): React.JSX.Element | null {
  if (tier === 0) return <span className="crew-rank-chevrons crew-rank-recruit">·</span>
  return (
    <span className="crew-rank-chevrons" aria-hidden="true">
      {Array.from({ length: tier }, (_, i) => (
        <i key={i} className="crew-chevron" />
      ))}
    </span>
  )
}

export function CrewRoster({
  state,
  selectedId,
  onSelect
}: {
  state: AppState | null
  selectedId: string | null
  onSelect: (id: string) => void
}): React.JSX.Element {
  return (
    <section className="crew-roster" aria-label="Mech crew">
      <div className="section-caption">
        <span>
          <i className="tiny-cross">+</i> YOUR CREW
        </span>
        <span>SELECT A MECH TO COMMAND</span>
      </div>
      <div className="crew-grid">
        {state?.companions.map((companion, index) => {
          const profile = CREW[companion.mechClass]
          const mission = currentMission(companion.id, state.deployments)
          const missionFacility =
            mission && state.facilities.find((f) => f.id === mission.facilityId)
          const selected = selectedId === companion.id
          const record = computeServiceRecord(companion.id, state.deployments)
          const { rank } = record
          const statLine = mission
            ? `→ ${missionFacility?.name ?? 'Objective'}`
            : record.sorties === 0
              ? 'NO SORTIES YET'
              : `${record.sorties} SORTIE${record.sorties === 1 ? '' : 'S'}${
                  record.successRate === null ? '' : ` · ${Math.round(record.successRate * 100)}%`
                }`
          const progressLabel = rank.nextTitle
            ? `${rank.title}, ${Math.round(rank.progress * 100)}% to ${rank.nextTitle}`
            : `${rank.title}, max rank`
          return (
            <button
              key={companion.id}
              className={[
                'crew-card',
                selected ? 'is-selected' : '',
                mission ? `is-deployed mission-${mission.status}` : ''
              ].join(' ')}
              aria-pressed={selected}
              // The bay plays the pitched unit-select chirp when the selection
              // reaches it (BayScene.setSelectedCompanion), so no sound here.
              onClick={() => onSelect(companion.id)}
              aria-label={`Select ${companion.name}`}
            >
              {mission && <span className="crew-deploy-strip" aria-hidden="true" />}
              {selected && (
                <span className="crew-brackets" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              )}
              <span className="crew-number">
                0{index + 1} / {profile.code}
                {mission && (
                  <b className="crew-deployed-tag">
                    {mission.status === 'queued' ? 'QUEUED' : 'DEPLOYED'}
                  </b>
                )}
              </span>
              <img src={profile.image} alt="" className="crew-portrait" />
              {/* Mech Lab wireframe, revealed on hover / keyboard focus. */}
              <img src={profile.schematic} alt="" className="crew-schematic" />
              <span className="crew-name">{companion.name.replace(/-Prime$/i, '')}</span>
              <span className="crew-runtime">
                {RUNTIME_NAMES[companion.runtime ?? companion.family]}
              </span>
              <span className="crew-rank-line">
                <RankInsignia tier={rank.tier} />
                <span className="crew-rank-title">{rank.title}</span>
              </span>
              <span className="crew-foot">
                <span
                  className={`crew-status ${mission ? 'engaged' : companion.cliAvailable ? 'ready' : 'offline'}`}
                  title={runtimeSupportNote(companion.runtime ?? companion.family) ?? undefined}
                >
                  <i />
                  {mission
                    ? missionStatusLabel(mission, state.deployments)
                    : companion.cliAvailable
                      ? 'Ready'
                      : 'Setup needed'}
                </span>
                <span className="crew-stat-line">{statLine}</span>
              </span>
              <span
                className="crew-xp-track"
                role="progressbar"
                aria-label={progressLabel}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(rank.progress * 100)}
              >
                <span className="crew-xp-fill" style={{ width: `${rank.progress * 100}%` }} />
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
