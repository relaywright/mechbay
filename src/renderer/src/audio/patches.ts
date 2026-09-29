/**
 * The sound design, as plain data. Each one-shot is a stack of layers
 * (an oscillator or a looped noise buffer, optionally filtered and
 * saturated, shaped by an attack/hold/decay envelope) that engine.ts
 * renders into Web Audio nodes. Keeping it declarative lets the unit tests
 * check every sound's length, level, and spectrum ceiling without a browser.
 *
 * Levels are linear gain before the master chain. Most interface energy
 * sits under ~3 kHz; there are no bare high sine beeps.
 */
import { envelopeEnd, type Envelope, type NoiseColor } from './dsp'
import type { LoopId, SfxId } from './sfx'

export type Wave = 'sine' | 'triangle' | 'sawtooth' | 'square'

export interface FilterSpec {
  type: 'lowpass' | 'highpass' | 'bandpass'
  freq: number
  /** Exponential sweep target, reached when the layer's envelope ends. */
  to?: number
  q?: number
}

/** Pitch change `at` seconds after the layer starts: a jump, or a glide arriving then. */
export interface PitchStep {
  at: number
  freq: number
  glide?: boolean
}

export interface ToneLayer {
  kind: 'tone'
  wave: Wave
  freq: number
  steps?: PitchStep[]
  filter?: FilterSpec
  /** Waveshaper saturation amount (tanh drive); adds grit to low thumps. */
  drive?: number
  env: Envelope
}

export interface NoiseLayer {
  kind: 'noise'
  color: NoiseColor
  filter?: FilterSpec
  env: Envelope
}

export type Layer = ToneLayer | NoiseLayer

export interface Patch {
  /** Overall trim on the summed layers. */
  gain: number
  layers: Layer[]
  /** Feedback delay on the voice output. */
  echo?: { time: number; feedback: number; mix: number }
  /** Send level into the shared hangar reverb. */
  reverb?: number
  /** ± fractional random rate variation so repeats don't machine-gun. */
  jitter?: number
}

// --- Building blocks ---------------------------------------------------------

/** Band-passed white-noise transient: the "t" of a tick or a radio key click. */
function tick(delay: number, center: number, peak: number, decay = 0.012, q = 1.2): NoiseLayer {
  return {
    kind: 'noise',
    color: 'white',
    filter: { type: 'bandpass', freq: center, q },
    env: { delay, attack: 0.001, decay, peak }
  }
}

/** Short sine with a falling pitch: the body ("thock") under a tick. */
function thock(delay: number, from: number, to: number, peak: number, decay: number): ToneLayer {
  return {
    kind: 'tone',
    wave: 'sine',
    freq: from,
    steps: [{ at: decay * 0.8, freq: to, glide: true }],
    env: { delay, attack: 0.002, decay, peak }
  }
}

/** Plucked note through a lowpass so square/triangle stay warm, not buzzy. */
function note(
  delay: number,
  freq: number,
  peak: number,
  hold: number,
  decay: number,
  wave: Wave = 'triangle',
  cutoff = 1800
): ToneLayer {
  return {
    kind: 'tone',
    wave,
    freq,
    filter: { type: 'lowpass', freq: cutoff, q: 1 },
    env: { delay, attack: 0.004, hold, decay, peak }
  }
}

/**
 * Metallic clank: sine partials at inharmonic ratios (a struck plate), each
 * quieter and shorter than the last so the tail is the fundamental.
 */
function clank(
  delay: number,
  base: number,
  ratios: number[],
  peak: number,
  decay: number
): ToneLayer[] {
  return ratios.map((ratio, i) => ({
    kind: 'tone',
    wave: 'sine',
    freq: base * ratio,
    env: { delay, attack: 0.001, decay: decay / (1 + i * 0.4), peak: peak / (1 + i) }
  }))
}

/** Pitch-dropping sub sine: the weight of a footfall or landing. */
function sub(
  from: number,
  to: number,
  dropTime: number,
  peak: number,
  hold: number,
  decay: number,
  drive: number
): ToneLayer {
  return {
    kind: 'tone',
    wave: 'sine',
    freq: from,
    steps: [{ at: dropTime, freq: to, glide: true }],
    drive,
    env: { attack: 0.004, hold, decay, peak }
  }
}

/** Low-passed noise burst with a closing filter: the impact/dust of a step. */
function impact(
  color: NoiseColor,
  from: number,
  to: number,
  peak: number,
  decay: number,
  hold = 0
): NoiseLayer {
  return {
    kind: 'noise',
    color,
    filter: { type: 'lowpass', freq: from, to, q: 1 },
    env: { attack: 0.002, hold, decay, peak }
  }
}

function withSteps(layer: ToneLayer, scale: number): ToneLayer {
  return {
    ...layer,
    freq: layer.freq * scale,
    steps: layer.steps?.map((s) => ({ ...s, freq: s.freq * scale }))
  }
}

const INHARMONIC = [1, 2.76, 4.72]

// --- One-shots -----------------------------------------------------------------

const servoMotor: ToneLayer = {
  kind: 'tone',
  wave: 'sawtooth',
  freq: 170,
  steps: [
    { at: 0.07, freq: 320, glide: true },
    { at: 0.2, freq: 260, glide: true }
  ],
  filter: { type: 'lowpass', freq: 700, to: 1500, q: 3 },
  drive: 1.2,
  env: { attack: 0.025, hold: 0.13, decay: 0.09, peak: 0.1 }
}

const klaxon: ToneLayer = {
  kind: 'tone',
  wave: 'sawtooth',
  freq: 392,
  steps: [
    { at: 0.225, freq: 294 },
    { at: 0.45, freq: 392 },
    { at: 0.675, freq: 294 }
  ],
  filter: { type: 'lowpass', freq: 1500, q: 2 },
  drive: 1.5,
  env: { attack: 0.01, hold: 0.82, decay: 0.07, peak: 0.11 }
}

const confirmTone: ToneLayer = {
  kind: 'tone',
  wave: 'square',
  freq: 587.33,
  steps: [
    { at: 0.075, freq: 440 },
    { at: 0.15, freq: 659.25 }
  ],
  filter: { type: 'lowpass', freq: 1800, q: 1 },
  env: { delay: 0.14, attack: 0.004, hold: 0.22, decay: 0.09, peak: 0.1 }
}

export const PATCHES: Record<SfxId, Patch> = {
  // Interface: short, soft, dry.
  'ui-click': {
    gain: 1,
    layers: [thock(0, 190, 95, 0.2, 0.05), tick(0, 1700, 0.1)]
  },
  'ui-hover': {
    gain: 0.7,
    layers: [tick(0, 2000, 0.045, 0.01, 1.5), thock(0, 300, 220, 0.03, 0.018)]
  },
  'ui-tab': {
    gain: 0.8,
    layers: [
      tick(0, 1500, 0.09),
      thock(0, 230, 140, 0.14, 0.035),
      tick(0.045, 2100, 0.08),
      thock(0.045, 320, 200, 0.12, 0.035)
    ]
  },
  'ui-open': {
    gain: 0.8,
    layers: [
      {
        kind: 'noise',
        color: 'pink',
        filter: { type: 'bandpass', freq: 350, to: 1800, q: 1.4 },
        env: { attack: 0.055, decay: 0.04, peak: 0.22 }
      },
      thock(0.085, 260, 170, 0.12, 0.028),
      tick(0.085, 1900, 0.07, 0.01)
    ]
  },
  'ui-close': {
    gain: 0.8,
    layers: [
      thock(0, 220, 130, 0.12, 0.03),
      tick(0, 1400, 0.07),
      {
        kind: 'noise',
        color: 'pink',
        filter: { type: 'bandpass', freq: 1800, to: 350, q: 1.4 },
        env: { delay: 0.01, attack: 0.012, decay: 0.085, peak: 0.2 }
      }
    ]
  },
  'ui-error': {
    gain: 0.9,
    layers: [98, 92].map((freq, i): ToneLayer => ({
      kind: 'tone',
      wave: 'sawtooth',
      freq,
      filter: { type: 'lowpass', freq: 750, q: 3 },
      drive: 2,
      env: { delay: i * 0.06, attack: 0.003, hold: 0.028, decay: 0.014, peak: 0.14 }
    }))
  },

  // Command: radio comms flavour.
  select: {
    gain: 0.8,
    layers: [
      tick(0, 2400, 0.1, 0.014, 2.5),
      note(0.02, 659.25, 0.12, 0.03, 0.035, 'square', 1500),
      note(0.075, 880, 0.12, 0.035, 0.06, 'square', 1700)
    ]
  },
  acknowledge: {
    gain: 0.85,
    layers: [
      // Key-up.
      tick(0, 2600, 0.1),
      thock(0, 160, 110, 0.12, 0.025),
      // Open-carrier static.
      {
        kind: 'noise',
        color: 'white',
        filter: { type: 'bandpass', freq: 1800, q: 2 },
        env: { delay: 0.012, attack: 0.01, hold: 0.07, decay: 0.04, peak: 0.09 }
      },
      {
        kind: 'noise',
        color: 'crackle',
        filter: { type: 'bandpass', freq: 2200, q: 1 },
        env: { delay: 0.012, attack: 0.01, hold: 0.07, decay: 0.04, peak: 0.14 }
      },
      // Down-then-up confirm, doubled an octave below for weight.
      confirmTone,
      {
        ...withSteps(confirmTone, 0.5),
        wave: 'triangle',
        filter: { type: 'lowpass', freq: 1200, q: 1 },
        env: { ...confirmTone.env, peak: 0.08 }
      },
      // Unkey.
      tick(0.46, 2400, 0.06, 0.01)
    ]
  },
  radio: {
    gain: 1,
    layers: [
      {
        kind: 'noise',
        color: 'white',
        filter: { type: 'bandpass', freq: 1200, to: 1800, q: 1.6 },
        env: { attack: 0.006, hold: 0.12, decay: 0.07, peak: 0.11 }
      },
      {
        kind: 'noise',
        color: 'crackle',
        filter: { type: 'bandpass', freq: 1600, q: 1.2 },
        env: { attack: 0.006, hold: 0.12, decay: 0.07, peak: 0.16 }
      },
      // Squelch tail as the carrier drops.
      {
        kind: 'noise',
        color: 'white',
        filter: { type: 'bandpass', freq: 2000, q: 0.8 },
        env: { delay: 0.2, attack: 0.002, hold: 0.025, decay: 0.11, peak: 0.09 }
      },
      tick(0.2, 1800, 0.07)
    ]
  },
  'target-lock': {
    gain: 0.8,
    layers: [0, 0.09].flatMap((delay): ToneLayer[] => [
      {
        kind: 'tone',
        wave: 'triangle',
        freq: 880,
        filter: { type: 'lowpass', freq: 1800, q: 1 },
        env: { delay, attack: 0.002, decay: 0.07, peak: 0.09 }
      },
      {
        kind: 'tone',
        wave: 'sine',
        freq: 440,
        env: { delay, attack: 0.002, decay: 0.06, peak: 0.05 }
      }
    ])
  },

  // Mech movement: weight lives in the sub; the clank is only a glint.
  'footstep-heavy': {
    gain: 0.55,
    jitter: 0.05,
    reverb: 0.12,
    layers: [
      sub(62, 34, 0.18, 0.5, 0.02, 0.24, 1.6),
      impact('brown', 420, 110, 0.4, 0.13),
      tick(0, 700, 0.06, 0.025, 0.8),
      ...clank(0.004, 380, INHARMONIC, 0.045, 0.06)
    ]
  },
  'footstep-medium': {
    gain: 0.5,
    jitter: 0.05,
    reverb: 0.1,
    layers: [
      sub(85, 48, 0.14, 0.42, 0.015, 0.17, 1.4),
      impact('brown', 650, 170, 0.32, 0.09),
      tick(0, 900, 0.05, 0.02, 0.8),
      ...clank(0.003, 520, INHARMONIC, 0.04, 0.045)
    ]
  },
  'footstep-light': {
    gain: 0.5,
    jitter: 0.06,
    reverb: 0.08,
    layers: [
      sub(120, 70, 0.09, 0.3, 0.01, 0.11, 1.2),
      impact('pink', 1100, 320, 0.2, 0.06),
      tick(0, 1200, 0.05, 0.015, 0.8),
      ...clank(0.002, 700, INHARMONIC.slice(0, 2), 0.03, 0.035)
    ]
  },
  servo: {
    gain: 0.9,
    jitter: 0.04,
    layers: [
      servoMotor,
      { ...withSteps(servoMotor, 1.009), env: { ...servoMotor.env, peak: 0.07 } },
      {
        kind: 'noise',
        color: 'white',
        filter: { type: 'bandpass', freq: 2000, q: 0.7 },
        env: { attack: 0.02, hold: 0.1, decay: 0.1, peak: 0.05 }
      },
      tick(0, 1200, 0.04, 0.015)
    ]
  },
  'power-up': {
    gain: 0.85,
    layers: [
      {
        kind: 'tone',
        wave: 'sawtooth',
        freq: 55,
        steps: [{ at: 0.6, freq: 220, glide: true }],
        filter: { type: 'lowpass', freq: 250, to: 1800, q: 2 },
        env: { attack: 0.15, hold: 0.42, decay: 0.12, peak: 0.12 }
      },
      {
        kind: 'tone',
        wave: 'sine',
        freq: 110,
        steps: [{ at: 0.6, freq: 440, glide: true }],
        env: { attack: 0.2, hold: 0.37, decay: 0.12, peak: 0.09 }
      },
      {
        kind: 'noise',
        color: 'pink',
        filter: { type: 'bandpass', freq: 300, to: 1600, q: 1.2 },
        env: { attack: 0.3, hold: 0.25, decay: 0.12, peak: 0.08 }
      },
      // Reactor catches: a soft settle note and a relay click.
      note(0.58, 440, 0.07, 0.02, 0.1, 'triangle', 1500),
      tick(0.58, 1400, 0.06)
    ]
  },
  land: {
    gain: 0.7,
    reverb: 0.2,
    layers: [
      sub(55, 30, 0.3, 0.55, 0.04, 0.42, 2),
      impact('brown', 500, 90, 0.45, 0.3),
      ...clank(0.006, 300, [1, 2.9, 4.8], 0.05, 0.09),
      // Hydraulic vent as the legs take the weight.
      {
        kind: 'noise',
        color: 'white',
        filter: { type: 'bandpass', freq: 2300, to: 1400, q: 0.8 },
        env: { delay: 0.09, attack: 0.02, hold: 0.06, decay: 0.24, peak: 0.07 }
      }
    ]
  },

  // Outcomes.
  complete: {
    gain: 0.85,
    echo: { time: 0.15, feedback: 0.28, mix: 0.22 },
    layers: [
      note(0, 523.25, 0.12, 0.06, 0.2),
      note(0, 523.25, 0.05, 0.06, 0.2, 'square', 1400),
      note(0.12, 659.25, 0.12, 0.06, 0.2),
      note(0.12, 659.25, 0.05, 0.06, 0.2, 'square', 1400),
      note(0.24, 783.99, 0.14, 0.18, 0.42),
      note(0.24, 783.99, 0.06, 0.18, 0.42, 'square', 1400),
      // Warm root and fifth underneath.
      {
        kind: 'tone',
        wave: 'triangle',
        freq: 130.81,
        filter: { type: 'lowpass', freq: 600, q: 1 },
        env: { attack: 0.04, hold: 0.3, decay: 0.45, peak: 0.08 }
      },
      {
        kind: 'tone',
        wave: 'triangle',
        freq: 196,
        filter: { type: 'lowpass', freq: 600, q: 1 },
        env: { delay: 0.12, attack: 0.06, hold: 0.2, decay: 0.4, peak: 0.05 }
      }
    ]
  },
  fail: {
    gain: 0.85,
    layers: [
      klaxon,
      {
        ...withSteps(klaxon, 0.5),
        wave: 'square',
        filter: { type: 'lowpass', freq: 700, q: 1 },
        drive: undefined,
        env: { ...klaxon.env, peak: 0.06 }
      },
      {
        kind: 'noise',
        color: 'crackle',
        filter: { type: 'bandpass', freq: 1800, q: 0.8 },
        env: { attack: 0.005, hold: 0.45, decay: 0.35, peak: 0.12 }
      },
      tick(0, 2200, 0.07)
    ]
  },
  explosion: {
    gain: 0.75,
    reverb: 0.25,
    layers: [
      sub(70, 28, 0.5, 0.5, 0.05, 0.7, 3),
      impact('brown', 900, 110, 0.45, 0.7, 0.05),
      {
        kind: 'noise',
        color: 'white',
        filter: { type: 'lowpass', freq: 2500, q: 0.7 },
        env: { attack: 0.001, decay: 0.07, peak: 0.15 }
      },
      {
        kind: 'noise',
        color: 'crackle',
        filter: { type: 'bandpass', freq: 1300, to: 500, q: 0.7 },
        env: { delay: 0.03, attack: 0.02, hold: 0.1, decay: 0.62, peak: 0.2 }
      }
    ]
  }
}

// --- Loops -----------------------------------------------------------------------

/**
 * Slow modulation on one parameter: `gain` depth is linear gain around the
 * layer level, `filter` depth is Hz around the cutoff, `pitch` depth is cents.
 */
export interface Lfo {
  target: 'gain' | 'filter' | 'pitch'
  rate: number
  depth: number
}

interface LoopLayerBase {
  filter?: Omit<FilterSpec, 'to'>
  level: number
  lfo?: Lfo
}

export type LoopLayer =
  | (LoopLayerBase & { kind: 'tone'; wave: Wave; freq: number })
  | (LoopLayerBase & { kind: 'noise'; color: NoiseColor })

export interface LoopPatch {
  gain: number
  layers: LoopLayer[]
}

/** Fade applied when a loop starts or stops, so it never clicks. */
export const LOOP_FADE_S = 0.4

export const LOOPS: Record<LoopId, LoopPatch> = {
  // Hangar room tone: a low drone felt more than heard, plus faint air.
  ambient: {
    gain: 0.5,
    layers: [
      {
        kind: 'noise',
        color: 'brown',
        filter: { type: 'lowpass', freq: 160, q: 1 },
        level: 0.14,
        lfo: { target: 'filter', rate: 0.05, depth: 50 }
      },
      {
        kind: 'tone',
        wave: 'sawtooth',
        freq: 55,
        filter: { type: 'lowpass', freq: 110, q: 2 },
        level: 0.05,
        lfo: { target: 'filter', rate: 0.031, depth: 35 }
      },
      { kind: 'tone', wave: 'sine', freq: 55, level: 0.06 },
      {
        kind: 'tone',
        wave: 'sine',
        freq: 82.41,
        level: 0.025,
        lfo: { target: 'gain', rate: 0.07, depth: 0.02 }
      },
      {
        kind: 'noise',
        color: 'pink',
        filter: { type: 'bandpass', freq: 800, q: 0.6 },
        level: 0.012,
        lfo: { target: 'gain', rate: 0.11, depth: 0.008 }
      }
    ]
  },
  // Data-processing hum: mains-ish tone stack that breathes slowly.
  work: {
    gain: 0.5,
    layers: [
      {
        kind: 'tone',
        wave: 'sine',
        freq: 110,
        level: 0.05,
        lfo: { target: 'gain', rate: 0.3, depth: 0.02 }
      },
      {
        kind: 'tone',
        wave: 'sine',
        freq: 220,
        level: 0.03,
        lfo: { target: 'pitch', rate: 0.13, depth: 6 }
      },
      {
        kind: 'tone',
        wave: 'triangle',
        freq: 330,
        filter: { type: 'lowpass', freq: 500, q: 1 },
        level: 0.02,
        lfo: { target: 'filter', rate: 0.2, depth: 120 }
      },
      {
        kind: 'noise',
        color: 'white',
        filter: { type: 'bandpass', freq: 1400, q: 5 },
        level: 0.03,
        lfo: { target: 'gain', rate: 0.9, depth: 0.02 }
      }
    ]
  }
}

// --- Derived measurements (shared by the engine and the tests) ------------------

/** Seconds a layer lasts from voice start, before any rate scaling. */
export function layerEnd(layer: Layer): number {
  return envelopeEnd(layer.env)
}

/** Dry length of a patch in seconds (echo/reverb tails excluded). */
export function patchDuration(patch: Patch): number {
  return patch.layers.reduce((max, layer) => Math.max(max, layerEnd(layer)), 0)
}

/** Worst-case summed peak if every layer peaked at once, times the patch trim. */
export function patchPeakBound(patch: Patch): number {
  return patch.gain * patch.layers.reduce((sum, layer) => sum + layer.env.peak, 0)
}
