import { useEffect, useRef, useState } from 'react'
import type { AppState } from '../../../shared/types'
import { sfx } from '../audio/sfx'
import { bus } from '../bus'
import { compassPoint, computeCallouts, dropStaleHolding, type Callout } from '../cockpit'
import { useTypewriter } from '../motion'

/** How long each computer callout holds the line before the next one. */
const CALLOUT_MS = 2800
/** Degrees of heading shown across the tape. */
const TAPE_SPAN = 120
const TAPE_TICK = 15

/**
 * MechWarrior-style cockpit strip over the bay: a phosphor compass tape that
 * follows the selected mech's real heading (emitted by BayScene as it walks),
 * and the cockpit computer's one-line system callouts, derived from state
 * transitions in cockpit.ts and played one at a time with a data chirp.
 */
export function CockpitHud(): React.JSX.Element {
  const [heading, setHeading] = useState<number | null>(null)
  const [queue, setQueue] = useState<Callout[]>([])
  const previousRef = useRef<AppState | null>(null)

  useEffect(() => {
    const onHeading = ({ heading: next }: { companionId: string; heading: number }): void =>
      setHeading(next)
    bus.on('mechHeading', onHeading)
    return () => bus.off('mechHeading', onHeading)
  }, [])

  useEffect(() => {
    let disposed = false
    window.mechbay
      .getState()
      .then((initial) => {
        if (!disposed && !previousRef.current) previousRef.current = initial
      })
      .catch(() => {})
    const off = window.mechbay.onStateChange((next) => {
      const callouts = computeCallouts(previousRef.current, next)
      previousRef.current = next
      setQueue((current) => {
        const pruned = dropStaleHolding(current, next)
        return callouts.length > 0 ? [...pruned, ...callouts] : pruned
      })
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  const current = queue[0] ?? null
  useEffect(() => {
    if (!current) return
    // Deferred so StrictMode's mount/unmount/mount only chirps once.
    const chirp = setTimeout(() =>
      sfx.play(current.tone === 'nominal' ? 'computer' : 'computer-alert')
    )
    const timer = setTimeout(() => setQueue((q) => q.slice(1)), CALLOUT_MS)
    return () => {
      clearTimeout(chirp)
      clearTimeout(timer)
    }
  }, [current])

  return (
    <div className="cockpit-hud">
      {heading !== null && <CompassTape heading={heading} />}
      <div className="cockpit-callout-slot" aria-live="polite">
        {current && <CalloutLine key={current.id} callout={current} />}
      </div>
    </div>
  )
}

function CompassTape({ heading }: { heading: number }): React.JSX.Element {
  // Ticks every TAPE_TICK degrees across ±TAPE_SPAN/2 around the heading,
  // positioned in percent of the tape width.
  const first = Math.ceil((heading - TAPE_SPAN / 2) / TAPE_TICK) * TAPE_TICK
  const ticks: Array<{ deg: number; left: number }> = []
  for (let deg = first; deg <= heading + TAPE_SPAN / 2; deg += TAPE_TICK) {
    ticks.push({ deg, left: ((deg - heading) / TAPE_SPAN + 0.5) * 100 })
  }
  const normalized = Math.round(((heading % 360) + 360) % 360)
  return (
    <div className="compass-tape" role="img" aria-label={`Heading ${normalized} degrees`}>
      <div className="compass-track">
        {ticks.map(({ deg, left }) => {
          const wrapped = ((deg % 360) + 360) % 360
          const cardinal = wrapped % 45 === 0
          return (
            <span
              key={deg}
              className={`compass-tick${cardinal ? ' is-cardinal' : ''}`}
              style={{ left: `${left}%` }}
            >
              {cardinal && <b>{compassPoint(wrapped)}</b>}
            </span>
          )
        })}
      </div>
      <span className="compass-caret" />
      <span className="compass-readout">{String(normalized).padStart(3, '0')}</span>
    </div>
  )
}

function CalloutLine({ callout }: { callout: Callout }): React.JSX.Element {
  const typed = useTypewriter(callout.text, { perCharMs: 18, maxMs: 420 })
  return (
    <div className={`cockpit-callout tone-${callout.tone}`}>
      <span className="sr-only">{callout.text}</span>
      <span aria-hidden="true">
        <i className="cockpit-callout-mark">▸</i>
        {callout.text.slice(0, typed)}
      </span>
    </div>
  )
}
