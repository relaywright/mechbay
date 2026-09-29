import { useState } from 'react'

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * One fleet counter. When the value changes, the old reading rolls out and
 * the new one rolls in like a mechanical odometer, and the label flashes
 * once. The roll direction follows the change (up for more, down for less).
 * Reduced motion hides the outgoing reading, so the swap is instant.
 */
function TelemetryStat({
  value,
  label,
  amber = false
}: {
  value: number
  label: string
  amber?: boolean
}): React.JSX.Element {
  // Track the previous reading during render (React's "adjust state when a
  // prop changes" pattern) so the roll starts on the same frame as the change.
  const [reading, setReading] = useState({ value, previous: null as number | null, revision: 0 })
  if (reading.value !== value) {
    setReading({ value, previous: reading.value, revision: reading.revision + 1 })
  }
  const direction = reading.previous !== null && value < reading.previous ? 'down' : 'up'

  return (
    <div className={`telemetry-stat roll-${direction}`}>
      <strong className={amber ? 'amber-value' : undefined}>
        <span className="sr-only">{value}</span>
        <span className="odometer" aria-hidden="true">
          {reading.previous !== null && (
            <span
              key={`out-${reading.revision}`}
              className="odometer-out"
              onAnimationEnd={() => setReading((current) => ({ ...current, previous: null }))}
            >
              {pad(reading.previous)}
            </span>
          )}
          <span key={`in-${reading.revision}`} className={reading.revision ? 'odometer-in' : ''}>
            {pad(value)}
          </span>
        </span>
      </strong>
      <span
        key={reading.revision}
        className={reading.revision ? 'telemetry-label flash' : 'telemetry-label'}
      >
        {label}
      </span>
    </div>
  )
}

export function TelemetryStrip({
  telemetry
}: {
  telemetry: { ready: number; active: number; completed: number; queued: number } | null
}): React.JSX.Element {
  return (
    <div className="telemetry-strip" aria-label="Fleet telemetry">
      <TelemetryStat value={telemetry?.ready ?? 0} label="READY" />
      <TelemetryStat value={telemetry?.active ?? 0} label="ACTIVE" amber />
      <TelemetryStat value={telemetry?.completed ?? 0} label="COMPLETE" />
      <TelemetryStat value={telemetry?.queued ?? 0} label="QUEUED" />
    </div>
  )
}
