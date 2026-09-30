import type { AppState } from './types'

/** Master volume used when `settings.soundVolume` has never been set. */
export const DEFAULT_SOUND_VOLUME = 0.6

/**
 * Coerce an untrusted volume to 0..1. Returns undefined for anything that
 * isn't a finite number so callers can ignore it, matching how the other
 * settings drop values of the wrong type instead of guessing.
 */
export function clampSoundVolume(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

export interface SoundSettings {
  enabled: boolean
  volume: number
}

/** Apply defaults to the optional persisted fields: sound ON at 0.6. */
export function resolveSoundSettings(
  settings: Pick<AppState['settings'], 'sound' | 'soundVolume'>
): SoundSettings {
  return {
    enabled: settings.sound ?? true,
    volume: clampSoundVolume(settings.soundVolume) ?? DEFAULT_SOUND_VOLUME
  }
}
