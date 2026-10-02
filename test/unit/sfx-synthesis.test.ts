import { describe, expect, it } from 'vitest'
import {
  MIN_ATTACK_S,
  driveCurve,
  echoTail,
  envelopeEnd,
  envelopeSchedule,
  generateImpulseResponse,
  generateNoise,
  softClipCurve,
  type NoiseColor
} from '../../src/renderer/src/audio/dsp'
import {
  LOOPS,
  PATCHES,
  layerEnd,
  patchDuration,
  patchPeakBound,
  type Layer
} from '../../src/renderer/src/audio/patches'
import type { SfxId } from '../../src/renderer/src/audio/sfx'

const ALL_IDS = Object.keys(PATCHES) as SfxId[]

function rms(data: Float32Array): number {
  let sum = 0
  for (const v of data) sum += v * v
  return Math.sqrt(sum / data.length)
}

/** RMS of the first difference relative to RMS: a crude brightness measure. */
function brightness(data: Float32Array): number {
  let sum = 0
  for (let i = 1; i < data.length; i++) sum += (data[i] - data[i - 1]) ** 2
  return Math.sqrt(sum / (data.length - 1)) / rms(data)
}

function maxAbs(data: Float32Array): number {
  let max = 0
  for (const v of data) max = Math.max(max, Math.abs(v))
  return max
}

describe('envelopeSchedule', () => {
  const env = { delay: 0.1, attack: 0.01, hold: 0.05, decay: 0.2, peak: 0.4 }

  it('starts and ends at exactly zero and never exceeds the peak', () => {
    const points = envelopeSchedule(env)
    expect(points[0]).toMatchObject({ t: 0.1, v: 0, ramp: 'set' })
    expect(points[points.length - 1].v).toBe(0)
    for (const p of points) {
      expect(p.v).toBeGreaterThanOrEqual(0)
      expect(p.v).toBeLessThanOrEqual(0.4)
    }
  })

  it('has non-decreasing times and never ramps exponentially to zero', () => {
    const points = envelopeSchedule(env)
    for (let i = 1; i < points.length; i++) {
      expect(points[i].t).toBeGreaterThanOrEqual(points[i - 1].t)
    }
    // exponentialRampToValueAtTime(0) throws in Web Audio.
    for (const p of points.filter((q) => q.ramp === 'exp')) expect(p.v).toBeGreaterThan(0)
  })

  it('scales time by 1/rate', () => {
    expect(envelopeEnd(env, 1)).toBeCloseTo(0.36)
    expect(envelopeEnd(env, 2)).toBeCloseTo(0.18)
  })

  it('enforces a minimum attack so nothing clicks', () => {
    const points = envelopeSchedule({ attack: 0, decay: 0.05, peak: 1 })
    expect(points[1].t - points[0].t).toBeGreaterThanOrEqual(MIN_ATTACK_S)
  })

  it('stays silent (not NaN) for a zero peak', () => {
    for (const p of envelopeSchedule({ attack: 0.01, decay: 0.01, peak: 0 })) {
      expect(Number.isFinite(p.v)).toBe(true)
    }
  })
})

describe('generateNoise', () => {
  const colors: NoiseColor[] = ['white', 'pink', 'brown', 'crackle']
  const length = 48000

  it.each(colors)('%s noise is peak-normalized, bounded, and not silent', (color) => {
    const data = generateNoise(color, length, 3)
    expect(data.length).toBe(length)
    expect(maxAbs(data)).toBeCloseTo(1, 5)
    expect(rms(data)).toBeGreaterThan(0.02)
    expect(data.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('is deterministic for a seed', () => {
    expect(generateNoise('pink', 256, 9)).toEqual(generateNoise('pink', 256, 9))
    expect(generateNoise('pink', 256, 9)).not.toEqual(generateNoise('pink', 256, 10))
  })

  it('gets darker from white to pink to brown', () => {
    const white = brightness(generateNoise('white', length, 5))
    const pink = brightness(generateNoise('pink', length, 5))
    const brown = brightness(generateNoise('brown', length, 5))
    expect(pink).toBeLessThan(white)
    expect(brown).toBeLessThan(pink)
  })

  it('keeps white and pink noise centred on zero', () => {
    for (const color of ['white', 'pink'] as const) {
      const data = generateNoise(color, length, 11)
      const mean = data.reduce((sum, v) => sum + v, 0) / data.length
      expect(Math.abs(mean)).toBeLessThan(0.05)
    }
  })
})

describe('driveCurve', () => {
  it.each([0.5, 1.5, 3])('is bounded, odd-symmetric, and monotonic (amount %s)', (amount) => {
    const curve = driveCurve(amount, 257)
    expect(curve[0]).toBeCloseTo(-1, 5)
    expect(curve[256]).toBeCloseTo(1, 5)
    expect(curve[128]).toBeCloseTo(0, 5)
    for (let i = 0; i < curve.length; i++) {
      expect(Math.abs(curve[i])).toBeLessThanOrEqual(1 + 1e-6)
      expect(curve[i]).toBeCloseTo(-curve[curve.length - 1 - i], 5)
      if (i > 0) expect(curve[i]).toBeGreaterThan(curve[i - 1])
    }
  })
})

describe('softClipCurve', () => {
  it('is an exact identity below the knee and stays under full scale above it', () => {
    const samples = 4097
    const curve = softClipCurve(0.8, samples)
    for (let i = 0; i < samples; i++) {
      const x = (i / (samples - 1)) * 2 - 1
      if (Math.abs(x) <= 0.8) expect(curve[i]).toBeCloseTo(x, 6)
      expect(Math.abs(curve[i])).toBeLessThan(1)
      if (i > 0) expect(curve[i]).toBeGreaterThan(curve[i - 1])
    }
  })
})

describe('generateImpulseResponse', () => {
  it('builds a bounded stereo tail that decays', () => {
    const [left, right] = generateImpulseResponse(48000, 1)
    expect(left.length).toBe(48000)
    expect(right.length).toBe(48000)
    expect(maxAbs(left)).toBeLessThanOrEqual(1 + 1e-6)
    const head = rms(left.subarray(0, 4800))
    const tail = rms(left.subarray(43200))
    expect(tail).toBeLessThan(head * 0.01)
    expect(left).not.toEqual(right) // decorrelated for width
  })
})

describe('echoTail', () => {
  it('is finite and grows with feedback', () => {
    expect(echoTail(0.15, 0)).toBeCloseTo(0.15)
    expect(echoTail(0.15, 0.3)).toBeLessThan(echoTail(0.15, 0.6))
    expect(Number.isFinite(echoTail(0.15, 5))).toBe(true)
  })
})

function toneFrequencies(layer: Layer): number[] {
  if (layer.kind !== 'tone') return []
  return [layer.freq, ...(layer.steps ?? []).map((s) => s.freq)]
}

describe('PATCHES', () => {
  it('defines every sound id', () => {
    expect(ALL_IDS.sort()).toEqual(
      [
        'ui-click',
        'ui-hover',
        'ui-tab',
        'ui-open',
        'ui-close',
        'ui-error',
        'select',
        'acknowledge',
        'radio',
        'target-lock',
        'computer',
        'computer-alert',
        'footstep-heavy',
        'footstep-medium',
        'footstep-light',
        'servo',
        'power-up',
        'land',
        'complete',
        'fail',
        'explosion'
      ].sort()
    )
  })

  it('keeps interface sounds under 120ms and soft', () => {
    for (const id of ALL_IDS.filter((i) => i.startsWith('ui-'))) {
      expect(patchDuration(PATCHES[id]), id).toBeLessThan(0.12)
      expect(patchPeakBound(PATCHES[id]), id).toBeLessThanOrEqual(0.35)
    }
    expect(patchPeakBound(PATCHES['ui-hover'])).toBeLessThanOrEqual(0.1)
    expect(patchDuration(PATCHES['ui-hover'])).toBeLessThanOrEqual(0.03)
  })

  it('keeps footsteps short enough to overlap on every footfall', () => {
    const heavy = patchDuration(PATCHES['footstep-heavy'])
    const medium = patchDuration(PATCHES['footstep-medium'])
    const light = patchDuration(PATCHES['footstep-light'])
    expect(heavy).toBeLessThan(0.35)
    expect(medium).toBeLessThan(heavy)
    expect(light).toBeLessThan(medium)
  })

  it('matches the target lengths of the longer cues', () => {
    const within = (id: SfxId, min: number, max: number): void => {
      const d = patchDuration(PATCHES[id])
      expect(d, id).toBeGreaterThanOrEqual(min)
      expect(d, id).toBeLessThanOrEqual(max)
    }
    within('servo', 0.2, 0.3)
    within('power-up', 0.6, 0.8)
    within('complete', 0.75, 1)
    within('fail', 0.8, 1)
    within('explosion', 0.65, 0.9)
  })

  it('cannot exceed unity gain even if every layer peaked together', () => {
    for (const id of ALL_IDS) expect(patchPeakBound(PATCHES[id]), id).toBeLessThanOrEqual(1)
  })

  it('keeps pitched energy low and bright partials quiet and short', () => {
    for (const id of ALL_IDS) {
      for (const layer of PATCHES[id].layers) {
        for (const freq of toneFrequencies(layer)) {
          expect(freq, id).toBeGreaterThan(0)
          expect(freq, id).toBeLessThan(3000)
          if (freq > 1000) {
            // Only clank partials live up here, and only as a glint.
            expect(layer.env.peak, id).toBeLessThanOrEqual(0.05)
            expect(layer.env.decay, id).toBeLessThanOrEqual(0.1)
          }
        }
      }
    }
  })

  it('keeps filters under ~3kHz with tame resonance', () => {
    for (const id of ALL_IDS) {
      for (const layer of PATCHES[id].layers) {
        const f = layer.filter
        if (!f) continue
        expect(f.freq, id).toBeLessThanOrEqual(3000)
        if (f.to !== undefined) {
          expect(f.to, id).toBeGreaterThan(0)
          expect(f.to, id).toBeLessThanOrEqual(3000)
        }
        // Lowpass/highpass Q is resonance in dB in Web Audio; bandpass is 0 dB at centre.
        if (f.type !== 'bandpass') expect(f.q ?? 1, id).toBeLessThanOrEqual(4)
      }
    }
  })

  it('schedules pitch steps inside their layer, in order', () => {
    for (const id of ALL_IDS) {
      for (const layer of PATCHES[id].layers) {
        if (layer.kind !== 'tone' || !layer.steps) continue
        const span = layerEnd(layer) - (layer.env.delay ?? 0)
        let last = 0
        for (const step of layer.steps) {
          expect(step.at, id).toBeGreaterThan(last)
          expect(step.at, id).toBeLessThanOrEqual(span)
          last = step.at
        }
      }
    }
  })

  it('uses stable echo settings and modest reverb sends', () => {
    for (const id of ALL_IDS) {
      const { echo, reverb, jitter } = PATCHES[id]
      if (echo) {
        expect(echo.feedback, id).toBeLessThan(0.5)
        expect(echo.mix, id).toBeLessThanOrEqual(0.3)
        expect(echo.time, id).toBeLessThan(1) // DelayNode max
      }
      if (reverb !== undefined) expect(reverb, id).toBeLessThanOrEqual(0.3)
      if (jitter !== undefined) expect(jitter, id).toBeLessThanOrEqual(0.1)
    }
  })
})

describe('LOOPS', () => {
  it.each(Object.entries(LOOPS))('%s stays very quiet and its LFOs stay in range', (_id, loop) => {
    let peak = 0
    for (const layer of loop.layers) {
      const lfo = layer.lfo
      let layerPeak = layer.level
      if (lfo?.target === 'gain') {
        expect(lfo.depth).toBeLessThan(layer.level) // gain never inverts
        layerPeak += lfo.depth
      }
      if (lfo?.target === 'filter') {
        expect(layer.filter).toBeDefined()
        expect(layer.filter!.freq - lfo.depth).toBeGreaterThan(20)
      }
      if (lfo) expect(lfo.rate).toBeLessThan(1) // slow drift, not wobble
      peak += layerPeak
    }
    expect(peak * loop.gain).toBeLessThanOrEqual(0.2)
  })

  it('keeps the hangar drone in the 50-80Hz register', () => {
    for (const layer of LOOPS.ambient.layers) {
      if (layer.kind === 'tone') {
        expect(layer.freq).toBeGreaterThanOrEqual(50)
        expect(layer.freq).toBeLessThanOrEqual(85)
      }
    }
  })
})
