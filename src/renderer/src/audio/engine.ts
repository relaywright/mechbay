/**
 * Web Audio renderer for the patches in patches.ts, plus the master mix.
 *
 * Signal flow:
 *   layers (osc|noise → filter → shaper → envelope)
 *     → voice gain ─┬───────────────→ [panner] → bus
 *                   ├→ [echo] ──────→ [panner]
 *                   └→ reverb send → convolver → bus
 *   bus → compressor → master volume → soft clip → speakers
 *
 * Chromium's DynamicsCompressorNode adds automatic makeup gain derived from
 * threshold/ratio (about +3 dB with the settings below, measured), so the
 * bus trims 6 dB going in: a single full-scale voice leaves the compressor
 * near -4 dBFS before master volume, and overlapping voices get squeezed
 * rather than clipped. The soft clipper is only a backstop that keeps a
 * freak pile-up from ever producing digital overs.
 *
 * Every public method is wrapped so a missing or broken AudioContext (Node
 * tests, a locked-down renderer) degrades to silence instead of throwing.
 */
import { DEFAULT_SOUND_VOLUME, clampSoundVolume } from '../../../shared/sound-settings'
import {
  driveCurve,
  echoTail,
  envelopeSchedule,
  generateImpulseResponse,
  generateNoise,
  softClipCurve,
  type NoiseColor
} from './dsp'
import { VoiceLimiter, normalizePlayOptions, voiceCap, volumeToGain } from './mix'
import type { ResolvedPlayOptions } from './mix'
import { LOOPS, LOOP_FADE_S, PATCHES, layerEnd, patchDuration } from './patches'
import type { Layer, LoopPatch, Patch } from './patches'
import type { LoopId, PlayOptions, SfxEngine, SfxId } from './sfx'

const BUS_TRIM = 0.5
const NOISE_SECONDS = 2
const REVERB_SECONDS = 1.1
const REVERB_RETURN = 0.6
/** Scheduling lookahead so a voice's first envelope point is never in the past. */
const START_LOOKAHEAD_S = 0.005
/** Master fade when toggling sound, and how long to wait before suspending. */
const MASTER_FADE_TC = 0.03
const SUSPEND_AFTER_MS = 600

interface RunningLoop {
  out: GainNode
  nodes: AudioNode[]
  sources: AudioScheduledSourceNode[]
}

interface LoopEntry {
  id: LoopId
  opts?: PlayOptions
  running: RunningLoop | null
}

interface Graph {
  ctx: AudioContext
  bus: GainNode
  master: GainNode
  reverbIn: GainNode | null
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

function audioContextCtor(): AudioContextCtor | undefined {
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
  return g.AudioContext ?? g.webkitAudioContext
}

function disconnectAll(nodes: AudioNode[]): void {
  for (const node of nodes) {
    try {
      node.disconnect()
    } catch {
      // already disconnected
    }
  }
}

export function createSfxEngine(): SfxEngine {
  let graph: Graph | null = null
  let unavailable = false
  let enabled = true
  let volume = DEFAULT_SOUND_VOLUME
  let suspendTimer: ReturnType<typeof setTimeout> | null = null
  let detachUnlock: (() => void) | null = null

  const limiter = new VoiceLimiter<SfxId>(voiceCap)
  const loops = new Map<string, LoopEntry>()
  const noiseCache = new Map<NoiseColor, AudioBuffer>()
  const curveCache = new Map<number, Float32Array<ArrayBuffer>>()

  function masterTarget(): number {
    return enabled ? volumeToGain(volume) : 0
  }

  function ensureGraph(): Graph | null {
    if (graph) return graph
    if (unavailable) return null
    const Ctor = audioContextCtor()
    if (!Ctor) {
      unavailable = true
      return null
    }
    try {
      const ctx = new Ctor({ latencyHint: 'interactive' })
      const bus = ctx.createGain()
      bus.gain.value = BUS_TRIM
      const comp = ctx.createDynamicsCompressor()
      comp.threshold.value = -10
      comp.knee.value = 8
      comp.ratio.value = 4
      comp.attack.value = 0.003
      comp.release.value = 0.2
      const master = ctx.createGain()
      master.gain.value = masterTarget()
      const clipper = ctx.createWaveShaper()
      clipper.curve = softClipCurve()
      bus.connect(comp)
      comp.connect(master)
      master.connect(clipper)
      clipper.connect(ctx.destination)

      let reverbIn: GainNode | null = null
      try {
        const convolver = ctx.createConvolver()
        const ir = generateImpulseResponse(ctx.sampleRate, REVERB_SECONDS)
        const buffer = ctx.createBuffer(2, ir[0].length, ctx.sampleRate)
        buffer.copyToChannel(ir[0], 0)
        buffer.copyToChannel(ir[1], 1)
        convolver.buffer = buffer
        reverbIn = ctx.createGain()
        const ret = ctx.createGain()
        ret.gain.value = REVERB_RETURN
        reverbIn.connect(convolver)
        convolver.connect(ret)
        ret.connect(bus)
      } catch {
        reverbIn = null // dry is fine
      }

      graph = { ctx, bus, master, reverbIn }
      return graph
    } catch {
      unavailable = true
      return null
    }
  }

  function resume(ctx: AudioContext): void {
    if (ctx.state !== 'suspended') return
    ctx.resume().then(
      () => {
        if (ctx.state === 'running') detachUnlock?.()
      },
      () => undefined
    )
  }

  function noiseBuffer(ctx: AudioContext, color: NoiseColor): AudioBuffer {
    let buffer = noiseCache.get(color)
    if (!buffer) {
      const length = Math.floor(ctx.sampleRate * NOISE_SECONDS)
      buffer = ctx.createBuffer(1, length, ctx.sampleRate)
      buffer.copyToChannel(generateNoise(color, length, color.length * 7919), 0)
      noiseCache.set(color, buffer)
    }
    return buffer
  }

  function shaper(ctx: AudioContext, amount: number): WaveShaperNode {
    const key = Math.round(amount * 100) / 100
    let curve = curveCache.get(key)
    if (!curve) {
      curve = driveCurve(key)
      curveCache.set(key, curve)
    }
    const node = ctx.createWaveShaper()
    node.curve = curve
    node.oversample = '2x'
    return node
  }

  function clampFreq(ctx: AudioContext, freq: number): number {
    return Math.min(Math.max(freq, 10), ctx.sampleRate / 2 - 100)
  }

  /** Build one layer into `out`; returns its source and every node it made. */
  function renderLayer(
    ctx: AudioContext,
    layer: Layer,
    t0: number,
    rate: number,
    stopAt: number,
    out: AudioNode
  ): { source: AudioScheduledSourceNode; nodes: AudioNode[] } {
    const start = t0 + (layer.env.delay ?? 0) / rate
    const end = t0 + layerEnd(layer) / rate
    const nodes: AudioNode[] = []
    let source: AudioScheduledSourceNode
    let offset: number | undefined

    if (layer.kind === 'tone') {
      const osc = ctx.createOscillator()
      osc.type = layer.wave
      osc.frequency.setValueAtTime(clampFreq(ctx, layer.freq * rate), start)
      for (const step of layer.steps ?? []) {
        const at = start + step.at / rate
        const freq = clampFreq(ctx, step.freq * rate)
        if (step.glide) osc.frequency.exponentialRampToValueAtTime(freq, at)
        else osc.frequency.setValueAtTime(freq, at)
      }
      source = osc
    } else {
      const noise = ctx.createBufferSource()
      noise.buffer = noiseBuffer(ctx, layer.color)
      noise.loop = true
      // Random read position so back-to-back noise hits aren't identical.
      offset = Math.random() * noise.buffer.duration
      source = noise
    }
    nodes.push(source)
    let head: AudioNode = source

    if (layer.filter) {
      const filter = ctx.createBiquadFilter()
      filter.type = layer.filter.type
      filter.Q.value = layer.filter.q ?? 1
      filter.frequency.setValueAtTime(clampFreq(ctx, layer.filter.freq * rate), start)
      if (layer.filter.to !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(clampFreq(ctx, layer.filter.to * rate), end)
      }
      head.connect(filter)
      head = filter
      nodes.push(filter)
    }

    if (layer.kind === 'tone' && layer.drive) {
      const drive = shaper(ctx, layer.drive)
      head.connect(drive)
      head = drive
      nodes.push(drive)
    }

    const amp = ctx.createGain()
    amp.gain.value = 0
    for (const point of envelopeSchedule(layer.env, rate)) {
      const t = t0 + point.t
      if (point.ramp === 'set') amp.gain.setValueAtTime(point.v, t)
      else if (point.ramp === 'linear') amp.gain.linearRampToValueAtTime(point.v, t)
      else amp.gain.exponentialRampToValueAtTime(point.v, t)
    }
    head.connect(amp)
    amp.connect(out)
    nodes.push(amp)

    if (offset === undefined) source.start(start)
    else (source as AudioBufferSourceNode).start(start, offset)
    source.stop(stopAt)
    return { source, nodes }
  }

  function renderVoice(g: Graph, patch: Patch, opts: ResolvedPlayOptions, rate: number): void {
    const { ctx, bus } = g
    const t0 = ctx.currentTime + START_LOOKAHEAD_S
    const dry = patchDuration(patch) / rate
    const tail = patch.echo ? echoTail(patch.echo.time / rate, patch.echo.feedback) : 0
    const stopAt = t0 + dry + tail + 0.05

    const nodes: AudioNode[] = []
    const voice = ctx.createGain()
    voice.gain.value = patch.gain * opts.volume
    nodes.push(voice)

    let dest: AudioNode = bus
    if (opts.pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner()
      panner.pan.value = opts.pan
      panner.connect(bus)
      dest = panner
      nodes.push(panner)
    }
    voice.connect(dest)

    if (patch.echo) {
      const delay = ctx.createDelay(1)
      delay.delayTime.value = patch.echo.time / rate
      const feedback = ctx.createGain()
      feedback.gain.value = Math.min(patch.echo.feedback, 0.9)
      const wet = ctx.createGain()
      wet.gain.value = patch.echo.mix
      voice.connect(delay)
      delay.connect(feedback)
      feedback.connect(delay)
      delay.connect(wet)
      wet.connect(dest)
      nodes.push(delay, feedback, wet)
    }

    if (patch.reverb && g.reverbIn) {
      const send = ctx.createGain()
      send.gain.value = patch.reverb
      voice.connect(send)
      send.connect(g.reverbIn)
      nodes.push(send)
    }

    const sources: AudioScheduledSourceNode[] = []
    for (const layer of patch.layers) {
      const built = renderLayer(ctx, layer, t0, rate, stopAt, voice)
      sources.push(built.source)
      nodes.push(...built.nodes)
    }
    // All sources stop together; the first to report tears the voice down
    // (the echo's feedback loop would otherwise keep itself alive).
    if (sources[0]) sources[0].onended = () => disconnectAll(nodes)
  }

  function startLoopVoice(g: Graph, spec: LoopPatch, options?: PlayOptions): RunningLoop {
    const { ctx } = g
    const opts = normalizePlayOptions(options)
    const now = ctx.currentTime
    const nodes: AudioNode[] = []
    const sources: AudioScheduledSourceNode[] = []

    const out = ctx.createGain()
    out.gain.setValueAtTime(0, now)
    out.gain.linearRampToValueAtTime(spec.gain * opts.volume, now + LOOP_FADE_S)
    nodes.push(out)
    let dest: AudioNode = g.bus
    if (opts.pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner()
      panner.pan.value = opts.pan
      panner.connect(g.bus)
      dest = panner
      nodes.push(panner)
    }
    out.connect(dest)

    for (const layer of spec.layers) {
      let source: AudioScheduledSourceNode
      let pitchParam: AudioParam | null = null
      if (layer.kind === 'tone') {
        const osc = ctx.createOscillator()
        osc.type = layer.wave
        osc.frequency.value = clampFreq(ctx, layer.freq * opts.rate)
        pitchParam = osc.detune
        source = osc
      } else {
        const noise = ctx.createBufferSource()
        noise.buffer = noiseBuffer(ctx, layer.color)
        noise.loop = true
        source = noise
      }
      sources.push(source)
      nodes.push(source)
      let head: AudioNode = source
      let filterParam: AudioParam | null = null
      if (layer.filter) {
        const filter = ctx.createBiquadFilter()
        filter.type = layer.filter.type
        filter.Q.value = layer.filter.q ?? 1
        filter.frequency.value = clampFreq(ctx, layer.filter.freq * opts.rate)
        filterParam = filter.frequency
        head.connect(filter)
        head = filter
        nodes.push(filter)
      }
      const level = ctx.createGain()
      level.gain.value = layer.level
      head.connect(level)
      level.connect(out)
      nodes.push(level)

      if (layer.lfo) {
        const target =
          layer.lfo.target === 'gain'
            ? level.gain
            : layer.lfo.target === 'filter'
              ? filterParam
              : pitchParam
        if (target) {
          const lfo = ctx.createOscillator()
          lfo.frequency.value = layer.lfo.rate
          const depth = ctx.createGain()
          depth.gain.value =
            layer.lfo.target === 'filter' ? layer.lfo.depth * opts.rate : layer.lfo.depth
          lfo.connect(depth)
          depth.connect(target)
          sources.push(lfo)
          nodes.push(lfo, depth)
        }
      }
    }
    for (const source of sources) source.start(now)
    return { out, nodes, sources }
  }

  function fadeOutLoop(g: Graph, running: RunningLoop): void {
    const now = g.ctx.currentTime
    const param = running.out.gain
    if (typeof param.cancelAndHoldAtTime === 'function') {
      param.cancelAndHoldAtTime(now)
    } else {
      param.cancelScheduledValues(now)
      param.setValueAtTime(param.value, now)
    }
    param.linearRampToValueAtTime(0, now + LOOP_FADE_S)
    const stopAt = now + LOOP_FADE_S + 0.05
    for (const source of running.sources) source.stop(stopAt)
    const first = running.sources[0]
    if (first) first.onended = () => disconnectAll(running.nodes)
    else disconnectAll(running.nodes)
  }

  function startPendingLoops(g: Graph): void {
    for (const entry of loops.values()) {
      if (!entry.running) entry.running = startLoopVoice(g, LOOPS[entry.id], entry.opts)
    }
  }

  function applyMaster(g: Graph): void {
    const now = g.ctx.currentTime
    g.master.gain.cancelScheduledValues(now)
    g.master.gain.setTargetAtTime(masterTarget(), now, MASTER_FADE_TC)
  }

  function clearSuspendTimer(): void {
    if (suspendTimer !== null) {
      clearTimeout(suspendTimer)
      suspendTimer = null
    }
  }

  const engine: SfxEngine = {
    play(id: SfxId, opts?: PlayOptions): void {
      try {
        if (!enabled) return
        const patch = PATCHES[id]
        if (!patch) return
        const resolved = normalizePlayOptions(opts)
        if (resolved.volume <= 0) return
        const g = ensureGraph()
        if (!g) return
        resume(g.ctx)
        const jitter = patch.jitter ? 1 + (Math.random() * 2 - 1) * patch.jitter : 1
        const rate = resolved.rate * jitter
        if (!limiter.tryStart(id, g.ctx.currentTime, patchDuration(patch) / rate)) return
        renderVoice(g, patch, resolved, rate)
      } catch {
        // Sound is decoration; never let it break the UI.
      }
    },

    startLoop(key: string, id: LoopId, opts?: PlayOptions): void {
      try {
        const existing = loops.get(key)
        if (existing?.id === id) return
        if (existing) engine.stopLoop(key)
        if (!LOOPS[id]) return
        const entry: LoopEntry = { id, opts, running: null }
        loops.set(key, entry)
        if (!enabled) return // remembered; starts when sound is re-enabled
        const g = ensureGraph()
        if (!g) return
        resume(g.ctx)
        entry.running = startLoopVoice(g, LOOPS[id], opts)
      } catch {
        // see play()
      }
    },

    stopLoop(key: string): void {
      try {
        const entry = loops.get(key)
        if (!entry) return
        loops.delete(key)
        if (entry.running && graph) fadeOutLoop(graph, entry.running)
      } catch {
        // see play()
      }
    },

    setEnabled(next: boolean): void {
      try {
        if (typeof next !== 'boolean' || next === enabled) return
        enabled = next
        clearSuspendTimer()
        if (!enabled) {
          if (!graph) return
          const g = graph
          applyMaster(g)
          for (const entry of loops.values()) {
            if (entry.running) fadeOutLoop(g, entry.running)
            entry.running = null
          }
          limiter.reset()
          // Park the audio thread once the fade has finished.
          suspendTimer = setTimeout(() => {
            suspendTimer = null
            if (!enabled && g.ctx.state === 'running') void g.ctx.suspend().catch(() => undefined)
          }, SUSPEND_AFTER_MS)
          return
        }
        // Only spin up a context on enable if something needs to sound now.
        const g = graph ?? (loops.size > 0 ? ensureGraph() : null)
        if (!g) return
        resume(g.ctx)
        applyMaster(g)
        startPendingLoops(g)
      } catch {
        // see play()
      }
    },

    setVolume(next: number): void {
      try {
        const clamped = clampSoundVolume(next)
        if (clamped === undefined) return
        volume = clamped
        if (graph) applyMaster(graph)
      } catch {
        // see play()
      }
    },

    unlock(): void {
      try {
        if (!enabled) return
        const g = ensureGraph()
        if (!g) return
        if (g.ctx.state === 'running') detachUnlock?.()
        else resume(g.ctx)
      } catch {
        // see play()
      }
    }
  }

  // Browsers (and some Electron configs) start contexts suspended until a
  // user gesture; the first pointer/key press anywhere unlocks audio.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    const onGesture = (): void => engine.unlock()
    const options = { capture: true, passive: true } as const
    document.addEventListener('pointerdown', onGesture, options)
    document.addEventListener('keydown', onGesture, options)
    detachUnlock = () => {
      document.removeEventListener('pointerdown', onGesture, options)
      document.removeEventListener('keydown', onGesture, options)
      detachUnlock = null
    }
  }

  return engine
}
