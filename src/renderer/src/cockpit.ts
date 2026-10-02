/**
 * The cockpit computer: MechWarrior-2-flavoured system callouts and
 * instrument readings, derived purely from real state (no timers, no
 * invented telemetry) so it can be unit tested without a DOM.
 *
 * The mechs talk on the radio (comms.ts); the computer speaks separately —
 * terse, all caps, one line at a time — about the lance as a whole.
 */
import type { AppState, Deployment } from '../../shared/types'
import { concurrencyCap, waitingInLine } from '../../shared/mission-queue'

export type CalloutTone = 'nominal' | 'warning' | 'critical'

export interface Callout {
  /** Stable per event, so a re-render never re-announces it. */
  id: string
  text: string
  tone: CalloutTone
}

const ACTIVE: ReadonlySet<Deployment['status']> = new Set([
  'walking-to',
  'working',
  'awaiting-input',
  'returning'
])

function upper(value: string | undefined, fallback: string): string {
  return (value ?? fallback).toUpperCase()
}

/**
 * Callouts for what changed between two snapshots. With no previous
 * snapshot (first load) nothing is announced — boot has its own checklist.
 */
export function computeCallouts(prev: AppState | null, next: AppState): Callout[] {
  if (!prev) return []
  const callouts: Callout[] = []
  const mech = (id: string): string => upper(next.companions.find((c) => c.id === id)?.name, 'UNIT')
  const facility = (id: string): string =>
    upper(next.facilities.find((f) => f.id === id)?.name, 'OBJECTIVE')
  const before = new Map(prev.deployments.map((d) => [d.id, d.status]))
  const waiting = waitingInLine(next)

  for (const d of next.deployments) {
    const was = before.get(d.id)
    if (was === d.status) continue
    const launched =
      (d.status === 'walking-to' || d.status === 'working') &&
      (was === undefined || was === 'queued')
    if (launched) {
      callouts.push({
        id: `${d.id}:launch`,
        text: `TARGET LOCKED · ${facility(d.facilityId)}`,
        tone: 'nominal'
      })
    } else if (d.status === 'queued' && was === undefined && waiting.has(d.id)) {
      callouts.push({
        id: `${d.id}:queued`,
        text: `LANCE AT CAPACITY · ${mech(d.companionId)} HOLDING`,
        tone: 'warning'
      })
    } else if (d.status === 'awaiting-input') {
      callouts.push({
        id: `${d.id}:input`,
        text: `INPUT REQUIRED · ${mech(d.companionId)}`,
        tone: 'warning'
      })
    } else if (d.status === 'completed' && was !== 'completed') {
      callouts.push({
        id: `${d.id}:complete`,
        text: `OBJECTIVE COMPLETE · ${facility(d.facilityId)}`,
        tone: 'nominal'
      })
    } else if (d.status === 'failed' && was !== 'failed') {
      callouts.push({
        id: `${d.id}:failed`,
        text: `WARNING · ${mech(d.companionId)} DOWN`,
        tone: 'critical'
      })
    }
  }

  const linkedBefore = new Set(prev.facilities.filter((f) => f.path).map((f) => f.id))
  for (const f of next.facilities) {
    if (f.path && !linkedBefore.has(f.id) && prev.facilities.some((p) => p.id === f.id)) {
      callouts.push({
        id: `${f.id}:linked`,
        text: `NAV POINT ONLINE · ${upper(f.name, '')}`,
        tone: 'nominal'
      })
    }
  }

  const activeBefore = prev.deployments.filter((d) => ACTIVE.has(d.status)).length
  const activeNow = next.deployments.filter((d) => ACTIVE.has(d.status)).length
  const queuedNow = next.deployments.some((d) => d.status === 'queued')
  if (activeBefore > 0 && activeNow === 0 && !queuedNow) {
    const lastFinished = next.deployments.find(
      (d) => before.has(d.id) && ACTIVE.has(before.get(d.id)!) && !ACTIVE.has(d.status)
    )
    callouts.push({
      id: `${lastFinished?.id ?? 'lance'}:standby`,
      text: 'ALL UNITS STANDING BY',
      tone: 'nominal'
    })
  }
  return callouts
}

export interface LanceHeat {
  active: number
  queued: number
  cap: number
  /** 0..1 — active missions against the concurrency cap. */
  level: number
  band: 'cool' | 'warm' | 'hot'
}

/**
 * Lance "heat": how much of the concurrency cap is in use. Hot means every
 * slot is taken; anything more waits in the queue.
 */
export function lanceHeat(state: AppState): LanceHeat {
  // The scheduler's own reading of the cap, so the gauge and the queue agree.
  const cap = concurrencyCap(state.settings.concurrencyCap)
  const active = state.deployments.filter((d) => ACTIVE.has(d.status)).length
  const queued = state.deployments.filter((d) => d.status === 'queued').length
  const level = Math.min(1, active / cap)
  return {
    active,
    queued,
    cap,
    level,
    band: active >= cap ? 'hot' : active >= cap - 1 && active > 0 ? 'warm' : 'cool'
  }
}

/**
 * Compass heading (degrees clockwise from north = up the screen) for a
 * movement in screen space. Screen y grows downward.
 */
export function headingFromDelta(dx: number, dy: number): number {
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI
  return (degrees + 360) % 360
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** Nearest of the eight compass points for a heading. */
export function compassPoint(heading: number): (typeof POINTS)[number] {
  const normalized = ((heading % 360) + 360) % 360
  return POINTS[Math.round(normalized / 45) % 8]
}
