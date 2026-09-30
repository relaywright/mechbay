/**
 * Pure mixing policy for the synth engine: option clamping, the master
 * volume taper, and voice-limit bookkeeping. DOM- and Web Audio-free.
 */
import type { PlayOptions, SfxId } from './sfx'

/** Hard ceiling on simultaneously sounding one-shots (loops excluded). */
export const GLOBAL_VOICE_CAP = 16
/** A second play of the same id this soon after the first is dropped. */
export const REPEAT_GUARD_S = 0.03
/** Clamp for PlayOptions.rate; beyond this envelopes and pitch get silly. */
export const MIN_RATE = 0.5
export const MAX_RATE = 2

/** Per-id concurrency: walking mechs need more footsteps than anything else. */
export function voiceCap(id: SfxId): number {
  if (id.startsWith('footstep-')) return 4
  if (id === 'ui-hover') return 2
  return 3
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export interface ResolvedPlayOptions {
  volume: number
  rate: number
  pan: number
}

/** Fill defaults and clamp caller options into safe ranges; never throws. */
export function normalizePlayOptions(opts?: PlayOptions): ResolvedPlayOptions {
  const rate = finiteOr(opts?.rate, 1)
  return {
    volume: clamp(finiteOr(opts?.volume, 1), 0, 1),
    rate: rate > 0 ? clamp(rate, MIN_RATE, MAX_RATE) : 1,
    pan: clamp(finiteOr(opts?.pan, 0), -1, 1)
  }
}

/**
 * Master slider position (0..1) → linear gain. Square-law taper: a linear
 * fader feels like it does nothing across its top half, this spreads the
 * audible range more evenly. Invalid input falls back to silence, not blast.
 */
export function volumeToGain(volume: number): number {
  const v = clamp(finiteOr(volume, 0), 0, 1)
  return v * v
}

interface ActiveVoice<Id> {
  id: Id
  startedAt: number
  endsAt: number
}

/**
 * Tracks which one-shots are still sounding, by their scheduled end time,
 * and decides whether a new one may start. New voices over a cap are
 * dropped rather than stealing old ones: a clipped footstep is more
 * noticeable than a missing one. Times are in seconds on any clock.
 */
export class VoiceLimiter<Id extends string> {
  private voices: ActiveVoice<Id>[] = []

  constructor(
    private readonly capFor: (id: Id) => number,
    private readonly globalCap = GLOBAL_VOICE_CAP,
    private readonly repeatGuard = REPEAT_GUARD_S
  ) {}

  tryStart(id: Id, now: number, duration: number): boolean {
    this.prune(now)
    let sameId = 0
    for (const voice of this.voices) {
      if (voice.id !== id) continue
      if (now - voice.startedAt < this.repeatGuard) return false
      sameId++
    }
    if (sameId >= this.capFor(id) || this.voices.length >= this.globalCap) return false
    this.voices.push({ id, startedAt: now, endsAt: now + Math.max(0, duration) })
    return true
  }

  active(now: number, id?: Id): number {
    this.prune(now)
    return id === undefined ? this.voices.length : this.voices.filter((v) => v.id === id).length
  }

  reset(): void {
    this.voices = []
  }

  private prune(now: number): void {
    // A clock that jumped backwards (new AudioContext) invalidates everything.
    this.voices = this.voices.filter((v) => v.endsAt > now && v.startedAt <= now)
  }
}

/** Returns true at most once per `intervalMs`; for hover spam at the DOM layer. */
export function createThrottle(intervalMs: number): (nowMs: number) => boolean {
  let last = Number.NEGATIVE_INFINITY
  return (nowMs) => {
    if (nowMs - last < intervalMs) return false
    last = nowMs
    return true
  }
}
