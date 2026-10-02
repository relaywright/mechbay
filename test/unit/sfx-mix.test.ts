import { describe, expect, it } from 'vitest'
import {
  GLOBAL_VOICE_CAP,
  MAX_RATE,
  MIN_RATE,
  REPEAT_GUARD_S,
  VoiceLimiter,
  createThrottle,
  normalizePlayOptions,
  voiceCap,
  volumeToGain
} from '../../src/renderer/src/audio/mix'
import {
  DEFAULT_SOUND_VOLUME,
  clampSoundVolume,
  resolveSoundSettings
} from '../../src/shared/sound-settings'
import type { SfxId } from '../../src/renderer/src/audio/sfx'

describe('resolveSoundSettings', () => {
  it('defaults to sound on at 0.6 when nothing is persisted', () => {
    expect(resolveSoundSettings({})).toEqual({ enabled: true, volume: DEFAULT_SOUND_VOLUME })
    expect(DEFAULT_SOUND_VOLUME).toBe(0.6)
  })

  it('respects persisted values', () => {
    expect(resolveSoundSettings({ sound: false, soundVolume: 0.2 })).toEqual({
      enabled: false,
      volume: 0.2
    })
  })

  it('falls back to the default for a corrupt persisted volume', () => {
    expect(resolveSoundSettings({ soundVolume: Number.NaN }).volume).toBe(DEFAULT_SOUND_VOLUME)
    expect(resolveSoundSettings({ soundVolume: 7 }).volume).toBe(1)
  })
})

describe('clampSoundVolume', () => {
  it('clamps finite numbers into 0..1', () => {
    expect(clampSoundVolume(-1)).toBe(0)
    expect(clampSoundVolume(0.35)).toBe(0.35)
    expect(clampSoundVolume(1.5)).toBe(1)
  })

  it('rejects non-numbers and non-finite numbers', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, '0.5', null, undefined, {}]) {
      expect(clampSoundVolume(bad)).toBeUndefined()
    }
  })
})

describe('normalizePlayOptions', () => {
  it('fills defaults', () => {
    expect(normalizePlayOptions()).toEqual({ volume: 1, rate: 1, pan: 0 })
    expect(normalizePlayOptions({})).toEqual({ volume: 1, rate: 1, pan: 0 })
  })

  it('clamps volume, rate, and pan into safe ranges', () => {
    expect(normalizePlayOptions({ volume: 4, rate: 10, pan: -3 })).toEqual({
      volume: 1,
      rate: MAX_RATE,
      pan: -1
    })
    expect(normalizePlayOptions({ volume: -1, rate: 0.01, pan: 2 })).toEqual({
      volume: 0,
      rate: MIN_RATE,
      pan: 1
    })
  })

  it('treats NaN / non-positive rate as the default instead of silence or a crash', () => {
    expect(normalizePlayOptions({ volume: Number.NaN, rate: Number.NaN, pan: Number.NaN })).toEqual(
      { volume: 1, rate: 1, pan: 0 }
    )
    expect(normalizePlayOptions({ rate: 0 }).rate).toBe(1)
    expect(normalizePlayOptions({ rate: -2 }).rate).toBe(1)
  })
})

describe('volumeToGain', () => {
  it('uses a square-law taper bounded to 0..1', () => {
    expect(volumeToGain(0)).toBe(0)
    expect(volumeToGain(0.5)).toBeCloseTo(0.25)
    expect(volumeToGain(1)).toBe(1)
    expect(volumeToGain(2)).toBe(1)
    expect(volumeToGain(Number.NaN)).toBe(0)
  })

  it('is monotonic', () => {
    let last = -1
    for (let v = 0; v <= 1; v += 0.05) {
      const gain = volumeToGain(v)
      expect(gain).toBeGreaterThanOrEqual(last)
      last = gain
    }
  })
})

describe('voiceCap', () => {
  it('allows more footsteps than hover ticks', () => {
    expect(voiceCap('footstep-heavy')).toBe(4)
    expect(voiceCap('footstep-light')).toBe(4)
    expect(voiceCap('ui-hover')).toBe(2)
    expect(voiceCap('complete')).toBe(3)
  })
})

describe('VoiceLimiter', () => {
  const limiter = (): VoiceLimiter<SfxId> => new VoiceLimiter<SfxId>(voiceCap)

  it('drops a repeat of the same id inside the repeat guard', () => {
    const l = limiter()
    expect(l.tryStart('ui-click', 1, 0.05)).toBe(true)
    expect(l.tryStart('ui-click', 1 + REPEAT_GUARD_S / 2, 0.05)).toBe(false)
    expect(l.tryStart('ui-click', 1 + REPEAT_GUARD_S, 0.05)).toBe(true)
  })

  it('does not apply the repeat guard across different ids', () => {
    const l = limiter()
    expect(l.tryStart('ui-click', 1, 0.05)).toBe(true)
    expect(l.tryStart('ui-tab', 1, 0.05)).toBe(true)
  })

  it('caps concurrent instances per id and frees them when they end', () => {
    const l = limiter()
    const starts = [0, 0.05, 0.1, 0.15, 0.2].map((t) => l.tryStart('footstep-heavy', t, 1))
    expect(starts).toEqual([true, true, true, true, false])
    expect(l.active(0.2, 'footstep-heavy')).toBe(4)
    // First voice ended at t=1.
    expect(l.tryStart('footstep-heavy', 1.01, 1)).toBe(true)
  })

  it('caps hover ticks at two', () => {
    const l = limiter()
    expect(l.tryStart('ui-hover', 0, 0.5)).toBe(true)
    expect(l.tryStart('ui-hover', 0.1, 0.5)).toBe(true)
    expect(l.tryStart('ui-hover', 0.2, 0.5)).toBe(false)
  })

  it('enforces the global voice cap across ids', () => {
    const l = new VoiceLimiter<string>(() => 100)
    for (let i = 0; i < GLOBAL_VOICE_CAP; i++) {
      expect(l.tryStart(`id-${i}`, 0, 5)).toBe(true)
    }
    expect(l.tryStart('one-more', 0, 5)).toBe(false)
    expect(l.active(0)).toBe(GLOBAL_VOICE_CAP)
    expect(l.active(6)).toBe(0)
  })

  it('forgets voices after reset or a clock that moved backwards', () => {
    const l = limiter()
    l.tryStart('explosion', 10, 1)
    expect(l.active(10)).toBe(1)
    expect(l.active(0)).toBe(0)
    l.tryStart('explosion', 20, 1)
    l.reset()
    expect(l.active(20)).toBe(0)
  })
})

describe('createThrottle', () => {
  it('lets one call through per interval', () => {
    const allow = createThrottle(70)
    expect(allow(0)).toBe(true)
    expect(allow(30)).toBe(false)
    expect(allow(69)).toBe(false)
    expect(allow(70)).toBe(true)
    expect(allow(100)).toBe(false)
  })
})
