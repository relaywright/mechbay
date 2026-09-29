/**
 * Procedural effect sprites for the bay, drawn once at scene start with
 * Canvas 2D instead of shipping PNGs. Everything is white/neutral so a
 * single texture serves every colour through Phaser tints; alpha carries
 * the shape. Keys are exported so BayScene never repeats string literals.
 */
import type Phaser from 'phaser'

export const FX = {
  /** Soft radial light: glows, flashes, beacons, packets. */
  glow: 'fx-glow',
  /** Elongated hot streak; particles rotate it along their velocity. */
  spark: 'fx-spark',
  /** Thin soft-edged ring for shockwaves (flattened to iso by scaleY). */
  ring: 'fx-ring',
  /** Contact shadow under mechs. */
  shadow: 'fx-shadow',
  /** Radar sweep wedge with a fading trail. */
  sweep: 'fx-sweep',
  /** Lumpy smoke puff. */
  puff: 'fx-puff',
  /** Vertical light pillar. */
  beam: 'fx-beam',
  /** Small hard-edged chunk for explosion debris. */
  debris: 'fx-debris',
  /** Four-point lens flare for sparks at the weld point. */
  flare: 'fx-flare'
} as const

type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void

function make(scene: Phaser.Scene, key: string, w: number, h: number, draw: Draw): void {
  if (scene.textures.exists(key)) return
  const canvas = scene.textures.createCanvas(key, w, h)
  if (!canvas) return
  draw(canvas.getContext(), w, h)
  canvas.refresh()
}

/** Deterministic PRNG so the smoke puff looks identical on every launch. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function generateFxTextures(scene: Phaser.Scene): void {
  make(scene, FX.glow, 64, 64, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.25, 'rgba(255,255,255,0.55)')
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })

  make(scene, FX.spark, 32, 6, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, 0)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.7, 'rgba(255,255,255,0.8)')
    g.addColorStop(1, 'rgba(255,255,255,1)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2 - 0.5, 0, 0, Math.PI * 2)
    ctx.fill()
  })

  make(scene, FX.ring, 128, 128, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, w * 0.36, w / 2, h / 2, w / 2)
    g.addColorStop(0, 'rgba(255,255,255,0)')
    g.addColorStop(0.55, 'rgba(255,255,255,1)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  })

  make(scene, FX.shadow, 128, 64, (ctx, w, h) => {
    ctx.save()
    ctx.scale(1, h / w)
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2)
    g.addColorStop(0, 'rgba(0,0,0,0.62)')
    g.addColorStop(0.55, 'rgba(0,0,0,0.38)')
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, w)
    ctx.restore()
  })

  make(scene, FX.sweep, 256, 256, (ctx, w, h) => {
    // A wedge whose leading edge (angle 0) is brightest, fading over ~70°
    // of trail behind it, plus radial falloff toward the rim.
    const cx = w / 2
    const cy = h / 2
    const r = w / 2
    const slices = 70
    for (let i = 0; i < slices; i++) {
      const a0 = (-i * Math.PI) / 180
      const a1 = (-(i + 1.4) * Math.PI) / 180
      const alpha = Math.pow(1 - i / slices, 2.2)
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
      g.addColorStop(0, `rgba(255,255,255,${alpha * 0.9})`)
      g.addColorStop(0.85, `rgba(255,255,255,${alpha * 0.45})`)
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, r, a1, a0)
      ctx.closePath()
      ctx.fill()
    }
  })

  make(scene, FX.puff, 64, 64, (ctx, w, h) => {
    const rand = mulberry32(7)
    for (let i = 0; i < 14; i++) {
      const x = w / 2 + (rand() - 0.5) * w * 0.42
      const y = h / 2 + (rand() - 0.5) * h * 0.42
      const r = w * (0.16 + rand() * 0.16)
      const g = ctx.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, 'rgba(255,255,255,0.22)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
    }
  })

  make(scene, FX.beam, 48, 256, (ctx, w, h) => {
    const across = ctx.createLinearGradient(0, 0, w, 0)
    across.addColorStop(0, 'rgba(255,255,255,0)')
    across.addColorStop(0.5, 'rgba(255,255,255,1)')
    across.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = across
    ctx.fillRect(0, 0, w, h)
    // Fade toward the top so the pillar dissolves into the sky.
    ctx.globalCompositeOperation = 'destination-in'
    const up = ctx.createLinearGradient(0, 0, 0, h)
    up.addColorStop(0, 'rgba(255,255,255,0)')
    up.addColorStop(0.7, 'rgba(255,255,255,0.8)')
    up.addColorStop(1, 'rgba(255,255,255,1)')
    ctx.fillStyle = up
    ctx.fillRect(0, 0, w, h)
  })

  make(scene, FX.debris, 6, 6, (ctx, w, h) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
  })

  make(scene, FX.flare, 64, 64, (ctx, w, h) => {
    const cx = w / 2
    const cy = h / 2
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, w * 0.22)
    core.addColorStop(0, 'rgba(255,255,255,1)')
    core.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = core
    ctx.fillRect(0, 0, w, h)
    for (const [dx, dy] of [
      [1, 0],
      [0, 1]
    ]) {
      const g = ctx.createLinearGradient(
        cx - (dx * w) / 2,
        cy - (dy * h) / 2,
        cx + (dx * w) / 2,
        cy + (dy * h) / 2
      )
      g.addColorStop(0, 'rgba(255,255,255,0)')
      g.addColorStop(0.5, 'rgba(255,255,255,0.9)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      if (dx) ctx.fillRect(0, cy - 1, w, 2)
      else ctx.fillRect(cx - 1, 0, 2, h)
    }
  })
}
