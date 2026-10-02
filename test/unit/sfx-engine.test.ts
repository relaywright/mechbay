import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSfxEngine } from '../../src/renderer/src/audio/engine'
import { PATCHES } from '../../src/renderer/src/audio/patches'
import { sfx, type SfxId } from '../../src/renderer/src/audio/sfx'

/**
 * A strict stand-in for the Web Audio graph: it records automation and
 * throws (and logs) wherever a real AudioContext would reject the call, so
 * errors the engine would otherwise swallow still fail the test.
 */
const errors: string[] = []
function fail(message: string): never {
  errors.push(message)
  throw new RangeError(message)
}

interface ParamEvent {
  type: string
  v: number
  t: number
}

class MockParam {
  events: ParamEvent[] = []
  constructor(
    public value: number,
    public readonly name: string
  ) {}
  private record(type: string, v: number, t: number): this {
    if (!Number.isFinite(v)) fail(`${this.name}: non-finite value ${v}`)
    if (!Number.isFinite(t) || t < 0) fail(`${this.name}: bad time ${t}`)
    this.events.push({ type, v, t })
    return this
  }
  setValueAtTime(v: number, t: number): this {
    return this.record('set', v, t)
  }
  linearRampToValueAtTime(v: number, t: number): this {
    return this.record('linear', v, t)
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    if (v <= 0) fail(`${this.name}: exponential ramp to ${v}`)
    return this.record('exp', v, t)
  }
  setTargetAtTime(v: number, t: number, tc: number): this {
    if (tc <= 0) fail(`${this.name}: bad time constant`)
    return this.record('target', v, t)
  }
  cancelScheduledValues(t: number): this {
    return this.record('cancel', 0, t)
  }
  cancelAndHoldAtTime(t: number): this {
    return this.record('hold', 0, t)
  }
  /** Every value this param is ever set or ramped to. */
  values(): number[] {
    return [
      this.value,
      ...this.events.filter((e) => e.type !== 'cancel' && e.type !== 'hold').map((e) => e.v)
    ]
  }
}

class MockNode {
  outputs: unknown[] = []
  constructor(public readonly ctx: MockContext) {
    ctx.nodes.push(this)
  }
  connect<T>(dest: T): T {
    this.outputs.push(dest)
    return dest
  }
  disconnect(): void {
    this.outputs = []
  }
}

class MockSource extends MockNode {
  startedAt: number | null = null
  stoppedAt: number | null = null
  onended: (() => void) | null = null
  start(t = 0): void {
    if (this.startedAt !== null) fail('source started twice')
    this.startedAt = t
  }
  stop(t = 0): void {
    if (this.startedAt === null) fail('stop before start')
    this.stoppedAt = t
  }
}

class MockOscillator extends MockSource {
  type = 'sine'
  frequency = new MockParam(440, 'osc.frequency')
  detune = new MockParam(0, 'osc.detune')
}

class MockBufferSource extends MockSource {
  buffer: MockBuffer | null = null
  loop = false
}

class MockGain extends MockNode {
  gain = new MockParam(1, 'gain')
}

class MockBuffer {
  data: Float32Array[]
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number
  ) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length))
  }
  get duration(): number {
    return this.length / this.sampleRate
  }
  copyToChannel(source: Float32Array, channel: number): void {
    for (const v of source) if (!(Math.abs(v) <= 1)) fail(`buffer sample out of range: ${v}`)
    this.data[channel].set(source)
  }
}

class MockContext {
  static instances: MockContext[] = []
  nodes: MockNode[] = []
  currentTime = 0
  sampleRate = 48000
  state: 'running' | 'suspended' = 'running'
  destination: MockNode
  constructor() {
    this.destination = new MockNode(this)
    MockContext.instances.push(this)
  }
  createGain(): MockGain {
    return new MockGain(this)
  }
  createOscillator(): MockOscillator {
    return new MockOscillator(this)
  }
  createBufferSource(): MockBufferSource {
    return new MockBufferSource(this)
  }
  createBuffer(channels: number, length: number, rate: number): MockBuffer {
    return new MockBuffer(channels, length, rate)
  }
  createBiquadFilter(): MockNode {
    return Object.assign(new MockNode(this), {
      type: 'lowpass',
      frequency: new MockParam(350, 'filter.frequency'),
      Q: new MockParam(1, 'filter.Q')
    })
  }
  createWaveShaper(): MockNode {
    return Object.assign(new MockNode(this), { curve: null, oversample: 'none' })
  }
  createDelay(max: number): MockNode {
    return Object.assign(new MockNode(this), { delayTime: new MockParam(0, `delay(max ${max})`) })
  }
  createConvolver(): MockNode {
    return Object.assign(new MockNode(this), { buffer: null })
  }
  createStereoPanner(): MockNode {
    return Object.assign(new MockNode(this), { pan: new MockParam(0, 'pan') })
  }
  createDynamicsCompressor(): MockNode {
    const p = (n: string): MockParam => new MockParam(0, n)
    return Object.assign(new MockNode(this), {
      threshold: p('threshold'),
      knee: p('knee'),
      ratio: p('ratio'),
      attack: p('attack'),
      release: p('release')
    })
  }
  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }
  suspend(): Promise<void> {
    this.state = 'suspended'
    return Promise.resolve()
  }
}

const g = globalThis as { AudioContext?: unknown }

function sources(ctx: MockContext): MockSource[] {
  return ctx.nodes.filter((n): n is MockSource => n instanceof MockSource)
}

function gains(ctx: MockContext): MockGain[] {
  return ctx.nodes.filter((n): n is MockGain => n instanceof MockGain)
}

/** The master volume gain feeds the soft clipper, which feeds the speakers. */
function masterGain(ctx: MockContext): MockGain {
  const clipper = ctx.nodes.find((n) => n.outputs.includes(ctx.destination))
  const master = gains(ctx).find((n) => n.outputs.includes(clipper))
  if (!master) throw new Error('master gain not found')
  return master
}

describe('sfx singleton without Web Audio', () => {
  it('is a silent no-op that never throws', () => {
    expect(g.AudioContext).toBeUndefined()
    expect(() => {
      sfx.unlock()
      sfx.play('explosion', { volume: 2, rate: Number.NaN, pan: 9 })
      sfx.startLoop('ambient', 'ambient')
      sfx.setVolume(Number.NaN)
      sfx.setEnabled(false)
      sfx.setEnabled(true)
      sfx.stopLoop('ambient')
      sfx.stopLoop('never-started')
    }).not.toThrow()
  })
})

describe('createSfxEngine with a Web Audio graph', () => {
  beforeEach(() => {
    errors.length = 0
    MockContext.instances = []
    g.AudioContext = MockContext
  })
  afterEach(() => {
    delete g.AudioContext
  })

  it('creates the AudioContext lazily', () => {
    const engine = createSfxEngine()
    engine.setVolume(0.5)
    expect(MockContext.instances).toHaveLength(0)
    engine.play('ui-click')
    expect(MockContext.instances).toHaveLength(1)
  })

  it.each(Object.keys(PATCHES) as SfxId[])('renders %s with valid, bounded automation', (id) => {
    const engine = createSfxEngine()
    engine.play(id, { pan: 0.4 })
    const ctx = MockContext.instances[0]
    expect(errors).toEqual([])

    const srcs = sources(ctx)
    expect(srcs.length).toBeGreaterThan(0)
    for (const s of srcs) {
      expect(s.startedAt).not.toBeNull()
      expect(s.stoppedAt).toBeGreaterThan(s.startedAt!)
      expect(s.stoppedAt! - s.startedAt!).toBeLessThan(2)
    }
    for (const gain of gains(ctx)) {
      for (const v of gain.gain.values()) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
    for (const osc of srcs.filter((s): s is MockOscillator => s instanceof MockOscillator)) {
      for (const f of osc.frequency.values()) {
        expect(f).toBeGreaterThan(0)
        expect(f).toBeLessThan(ctx.sampleRate / 2)
      }
    }
  })

  it('tears a voice down once its sources end', () => {
    const engine = createSfxEngine()
    engine.unlock() // builds the master graph without playing anything
    const ctx = MockContext.instances[0]
    const graphSize = ctx.nodes.length
    engine.play('complete') // has an echo feedback loop to break
    const voiceNodes = ctx.nodes.slice(graphSize)
    expect(voiceNodes.some((n) => n.outputs.length > 0)).toBe(true)
    const ended = sources(ctx).find((s) => s.onended)
    expect(ended).toBeDefined()
    ended!.onended!()
    expect(voiceNodes.every((n) => n.outputs.length === 0)).toBe(true)
  })

  it('limits voices per id and drops same-id spam', () => {
    const engine = createSfxEngine()
    engine.play('footstep-heavy')
    const ctx = MockContext.instances[0]
    const perPlay = sources(ctx).length

    engine.play('footstep-heavy') // same instant: repeat guard
    expect(sources(ctx).length).toBe(perPlay)

    for (let i = 1; i <= 5; i++) {
      ctx.currentTime = i * 0.05
      engine.play('footstep-heavy')
    }
    expect(sources(ctx).length).toBe(perPlay * 4)
  })

  it('scales pitch and shortens envelopes with rate', () => {
    const engine = createSfxEngine()
    engine.play('select', { rate: 2 })
    const ctx = MockContext.instances[0]
    const oscs = sources(ctx).filter((s): s is MockOscillator => s instanceof MockOscillator)
    expect(oscs.map((o) => o.frequency.events[0].v)).toContain(1760)
    const longest = Math.max(...sources(ctx).map((s) => s.stoppedAt!))
    expect(longest).toBeLessThan(0.18)
  })

  it('does nothing while disabled and silences the master', () => {
    const engine = createSfxEngine()
    engine.play('ui-click')
    const ctx = MockContext.instances[0]
    const before = ctx.nodes.length
    engine.setEnabled(false)
    engine.play('explosion')
    engine.unlock()
    expect(ctx.nodes.length).toBe(before)
    const master = masterGain(ctx)
    expect(master.gain.events.at(-1)).toMatchObject({ type: 'target', v: 0 })
  })

  it('applies the master volume with a square-law taper', () => {
    const engine = createSfxEngine()
    engine.play('ui-click')
    const ctx = MockContext.instances[0]
    const master = masterGain(ctx)
    expect(master.gain.value).toBeCloseTo(0.36) // default 0.6²
    engine.setVolume(0.5)
    expect(master.gain.events.at(-1)).toMatchObject({ type: 'target', v: 0.25 })
    engine.setVolume(3)
    expect(master.gain.events.at(-1)).toMatchObject({ type: 'target', v: 1 })
  })

  it('fades loops in and out, is idempotent per key, and resumes them on re-enable', () => {
    const engine = createSfxEngine()
    engine.startLoop('ambient', 'ambient')
    const ctx = MockContext.instances[0]
    const count = sources(ctx).length
    expect(count).toBeGreaterThan(0)
    expect(sources(ctx).every((s) => s.stoppedAt === null)).toBe(true)

    engine.startLoop('ambient', 'ambient')
    expect(sources(ctx).length).toBe(count)

    // The loop's output gain ramps up from 0 rather than jumping.
    const out = gains(ctx).find(
      (n) => n.gain.events[0]?.type === 'set' && n.gain.events[1]?.type === 'linear'
    )!
    expect(out.gain.events[0].v).toBe(0)
    expect(out.gain.events[1].t).toBeCloseTo(0.4)

    engine.setEnabled(false)
    expect(sources(ctx).every((s) => s.stoppedAt !== null)).toBe(true)
    expect(out.gain.events.at(-1)).toMatchObject({ type: 'linear', v: 0 })

    engine.setEnabled(true)
    expect(sources(ctx).length).toBe(count * 2)

    engine.stopLoop('ambient')
    expect(sources(ctx).every((s) => s.stoppedAt !== null)).toBe(true)
    expect(errors).toEqual([])
  })

  it('remembers a loop started while disabled', () => {
    const engine = createSfxEngine()
    engine.setEnabled(false)
    engine.startLoop('hum', 'work')
    expect(MockContext.instances).toHaveLength(0)
    engine.setEnabled(true)
    expect(sources(MockContext.instances[0]).length).toBeGreaterThan(0)
  })

  it('survives an AudioContext constructor that throws', () => {
    g.AudioContext = class {
      constructor() {
        throw new Error('no audio device')
      }
    }
    const engine = createSfxEngine()
    expect(() => {
      engine.play('ui-click')
      engine.startLoop('ambient', 'ambient')
      engine.unlock()
    }).not.toThrow()
  })
})
