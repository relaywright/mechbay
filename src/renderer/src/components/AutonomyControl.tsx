import type { AgentFamily } from '../../../shared/types'
import {
  AUTONOMY_HINTS,
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  USER_RULES_NOTE,
  autonomySupport,
  effectiveAutonomy,
  type AutonomyLevel
} from '../../../shared/autonomy'

/** Segmented Read only / Edit files / Full control (P0-12). */
export function AutonomyControl({
  runtime,
  value,
  onChange,
  disabled
}: {
  runtime: AgentFamily
  value: AutonomyLevel
  onChange: (level: AutonomyLevel) => void
  disabled?: boolean
}): React.JSX.Element {
  const support = autonomySupport(runtime)
  // What the mission will really run at: Gemini shows Full whatever is stored.
  const shown = effectiveAutonomy(runtime, value)
  return (
    <div className="autonomy-control">
      <div role="radiogroup" aria-label="Autonomy" className="autonomy-segments">
        {AUTONOMY_LEVELS.map((level) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={shown === level}
            disabled={disabled || !support.available[level]}
            title={support.available[level] ? AUTONOMY_HINTS[level] : support.reason}
            className={shown === level ? 'autonomy-segment is-selected' : 'autonomy-segment'}
            onClick={() => {
              if (level !== shown) onChange(level)
            }}
          >
            {AUTONOMY_LABELS[level]}
          </button>
        ))}
      </div>
      <p className="autonomy-note">
        {!support.enforced
          ? `Not enforced · ${support.reason}`
          : (support.reason ?? (shown ? AUTONOMY_HINTS[shown] : ''))}
      </p>
      {support.enforced && <p className="autonomy-note autonomy-note-rules">{USER_RULES_NOTE}</p>}
    </div>
  )
}
