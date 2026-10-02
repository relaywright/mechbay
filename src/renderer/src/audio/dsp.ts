/**
 * Pure sample/curve generators and envelope math for the synth engine.
 * Nothing here touches the Web Audio API, so it runs (and is tested) in Node.
 */

export type NoiseColor = 'white' | 'pink' | 'brown' | 'crackle'

/** Small seeded PRNG (mulberry32) so generated buffers are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Scale in place so the loudest sample sits at `peak`. */
function normalizePeak<T extends Float32Array>(data: T, peak = 1): T {
  let max = 0
  for (let i = 0; i < data.length; i++) max = Math.max(max, Math.abs(data[i]))
  if (max > 0) {
    const scale = peak / max
    for (let i = 0; i < data.length; i++) data[i] *= scale
  }
  return data
}

/**
 * Fill a mono noise buffer, peak-normalized to ±1. `crackle` is sparse
 * random impulses with a short decay (radio static / debris), the rest are
 * the usual spectral tilts: white (flat), pink (-3 dB/oct), brown (-6 dB/oct).
 */
export function generateNoise(
  color: NoiseColor,
  length: number,
  seed = 1
): Float32Array<ArrayBuffer> {
  const rand = mulberry32(seed)
  const out = new Float32Array(length)
  if (color === 'white') {
    for (let i = 0; i < length; i++) out[i] = rand() * 2 - 1
  } else if (color === 'pink') {
    // Paul Kellet's economy pink filter.
    let b0 = 0
    let b1 = 0
    let b2 = 0
    for (let i = 0; i < length; i++) {
      const w = rand() * 2 - 1
      b0 = 0.99765 * b0 + w * 0.099046
      b1 = 0.963 * b1 + w * 0.2965164
      b2 = 0.57 * b2 + w * 1.0526913
      out[i] = b0 + b1 + b2 + w * 0.1848
    }
  } else if (color === 'brown') {
    // Leaky integrator keeps the random walk from drifting off DC.
    let last = 0
    for (let i = 0; i < length; i++) {
      last = (last + 0.02 * (rand() * 2 - 1)) / 1.02
      out[i] = last
    }
  } else {
    // ~1 impulse per 90 samples (~500/s at 44.1k); squared amplitude keeps
    // most pops small with the occasional sharper snap.
    let env = 0
    let sign = 1
    for (let i = 0; i < length; i++) {
      if (rand() < 1 / 90) {
        env = rand() ** 2
        sign = rand() < 0.5 ? -1 : 1
      }
      out[i] = sign * env * (rand() * 0.6 + 0.4)
      env *= 0.8
    }
  }
  return normalizePeak(out)
}

/**
 * Normalized tanh waveshaper: odd-symmetric, maps ±1 → ±1, and more
 * `amount` means harder saturation. Output never exceeds the input range.
 */
export function driveCurve(amount: number, samples = 1024): Float32Array<ArrayBuffer> {
  const k = Math.max(0.01, amount)
  const norm = Math.tanh(k)
  const curve = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1
    curve[i] = Math.tanh(k * x) / norm
  }
  return curve
}

/**
 * Final safety stage: exact identity below `knee`, then a tanh shoulder
 * that approaches but never reaches full scale. A WaveShaper clamps its
 * input to ±1 before lookup, so whatever arrives, the output stays < 1.
 */
export function softClipCurve(knee = 0.8, samples = 4097): Float32Array<ArrayBuffer> {
  const room = 1 - knee
  const curve = new Float32Array(samples)
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1
    const mag = Math.abs(x)
    curve[i] = mag <= knee ? x : Math.sign(x) * (knee + room * Math.tanh((mag - knee) / room))
  }
  return curve
}

/**
 * Stereo impulse response for a small, dark metal room: decorrelated noise
 * with a 60 dB exponential decay over `seconds`, one-pole low-passed so the
 * tail doesn't hiss. Peak-normalized; the ConvolverNode normalizes energy.
 */
export function generateImpulseResponse(
  sampleRate: number,
  seconds: number,
  seed = 7
): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const length = Math.max(1, Math.floor(sampleRate * seconds))
  const channels: [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] = [
    new Float32Array(length),
    new Float32Array(length)
  ]
  const decayPerSample = Math.log(1000) / length
  const smoothing = 0.22
  channels.forEach((data, ch) => {
    const rand = mulberry32(seed + ch * 101)
    let y = 0
    for (let i = 0; i < length; i++) {
      y += smoothing * (rand() * 2 - 1 - y)
      data[i] = y * Math.exp(-decayPerSample * i)
    }
    normalizePeak(data)
  })
  return channels
}

export interface Envelope {
  /** Seconds after the voice starts before this layer sounds. */
  delay?: number
  attack: number
  hold?: number
  decay: number
  /** Linear gain at the top of the envelope. */
  peak: number
}

export interface EnvPoint {
  /** Seconds from voice start. */
  t: number
  v: number
  ramp: 'set' | 'linear' | 'exp'
}

/** Exponential ramps can't reach zero; this is -80 dB below the peak. */
const EXP_FLOOR = 1e-4
/** Shortest attack we allow; anything faster clicks. */
export const MIN_ATTACK_S = 0.001

/**
 * Gain automation for one layer as a list of points, with times divided by
 * `rate` (a faster, higher-pitched play is proportionally shorter). Always
 * starts and ends at exactly 0 and never exceeds `peak`.
 */
export function envelopeSchedule(env: Envelope, rate = 1): EnvPoint[] {
  const start = (env.delay ?? 0) / rate
  const attackEnd = start + Math.max(MIN_ATTACK_S, env.attack / rate)
  const holdEnd = attackEnd + (env.hold ?? 0) / rate
  const end = holdEnd + Math.max(MIN_ATTACK_S, env.decay / rate)
  const peak = Math.max(0, env.peak)
  const floor = Math.max(peak * EXP_FLOOR, 1e-6)
  const points: EnvPoint[] = [
    { t: start, v: 0, ramp: 'set' },
    { t: attackEnd, v: peak, ramp: 'linear' }
  ]
  if (holdEnd > attackEnd) points.push({ t: holdEnd, v: peak, ramp: 'linear' })
  points.push({ t: end, v: floor, ramp: 'exp' })
  points.push({ t: end, v: 0, ramp: 'set' })
  return points
}

/** Seconds from voice start until the layer's envelope has finished. */
export function envelopeEnd(env: Envelope, rate = 1): number {
  const points = envelopeSchedule(env, rate)
  return points[points.length - 1].t
}

/**
 * How long a feedback echo stays audible: repeats until the feedback has
 * decayed below -26 dB (5%), times the delay time.
 */
export function echoTail(time: number, feedback: number): number {
  const fb = Math.min(Math.max(feedback, 0), 0.9)
  if (fb <= 0) return time
  const repeats = Math.ceil(Math.log(0.05) / Math.log(fb))
  return time * (repeats + 1)
}
