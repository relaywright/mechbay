import Phaser from 'phaser'

/**
 * RTS minimap: a second camera in a corner of the canvas looking at a
 * schematic of the bay drawn far away from the playfield (so the main
 * camera never sees it and nothing needs per-object ignore lists). The
 * schematic reuses world coordinates 1:1, offset by ORIGIN, so a world
 * point maps to the minimap by a single translation.
 */
const ORIGIN = { x: -60000, y: -60000 }

/** Minimap size in logical (1100×640 design-viewport) pixels. */
const LOGICAL_W = 176
const LOGICAL_H = 96
const LOGICAL_MARGIN = 14

export interface MinimapBlip {
  x: number
  y: number
  color: number
  kind: 'mech' | 'facility'
  /** Draw an outer ring (selected mech / facility with active work). */
  ring?: boolean
}

export class Minimap {
  private readonly camera: Phaser.Cameras.Scene2D.Camera
  private readonly base: Phaser.GameObjects.Graphics
  private readonly overlay: Phaser.GameObjects.Graphics
  private zoom = 1

  constructor(
    private readonly scene: Phaser.Scene,
    /** The iso diamond's four corners in world coordinates (N, E, S, W). */
    private readonly diamond: Array<{ x: number; y: number }>,
    private readonly reducedMotion: () => boolean
  ) {
    this.camera = scene.cameras.add(0, 0, 10, 10, false, 'minimap')
    this.camera.setBackgroundColor('rgba(9, 12, 8, 0.86)')
    this.base = scene.add.graphics().setDepth(0)
    this.overlay = scene.add.graphics().setDepth(1)
    // Each camera only draws its own world: the main camera never renders
    // the schematic, and the minimap camera skips every playfield object
    // (including ones created later) instead of re-drawing the whole bay.
    scene.cameras.main.ignore([this.base, this.overlay])
    for (const child of scene.children.list) this.adopt(child)
    scene.events.on(Phaser.Scenes.Events.ADDED_TO_SCENE, this.adopt, this)
    this.layout()
  }

  private adopt(child: Phaser.GameObjects.GameObject): void {
    if (child === this.base || child === this.overlay) return
    this.camera.ignore(child)
  }

  /** Re-place and re-zoom the camera for the current game size (call on resize). */
  layout(): void {
    const gameW = this.scene.scale.gameSize.width
    const renderScale = gameW / 1100
    const w = Math.round(LOGICAL_W * renderScale)
    const h = Math.round(LOGICAL_H * renderScale)
    const margin = Math.round(LOGICAL_MARGIN * renderScale)
    this.camera.setViewport(gameW - w - margin, margin + Math.round(22 * renderScale), w, h)

    const xs = this.diamond.map((p) => p.x)
    const ys = this.diamond.map((p) => p.y)
    const spanW = Math.max(...xs) - Math.min(...xs)
    const spanH = Math.max(...ys) - Math.min(...ys)
    this.zoom = Math.min(w / (spanW * 1.12), h / (spanH * 1.16))
    this.camera.setZoom(this.zoom)
    this.camera.centerOn(
      ORIGIN.x + (Math.min(...xs) + Math.max(...xs)) / 2,
      ORIGIN.y + (Math.min(...ys) + Math.max(...ys)) / 2
    )
    this.drawBase()
  }

  /** Screen px → world units at the minimap's zoom. */
  private px(n: number): number {
    return n / this.zoom
  }

  private drawBase(): void {
    const g = this.base
    g.clear()
    const pts = this.diamond.map((p) => ({ x: p.x + ORIGIN.x, y: p.y + ORIGIN.y }))
    g.fillStyle(0x1a2116, 0.95)
    g.fillPoints(pts, true)
    g.lineStyle(this.px(1), 0x3f4a33, 1)
    // Quarter grid, matching the field's own survey lines.
    for (let i = 1; i < 4; i++) {
      const t = i / 4
      const a = lerp(pts[0], pts[3], t)
      const b = lerp(pts[1], pts[2], t)
      g.lineBetween(a.x, a.y, b.x, b.y)
      const c = lerp(pts[0], pts[1], t)
      const d = lerp(pts[3], pts[2], t)
      g.lineBetween(c.x, c.y, d.x, d.y)
    }
    g.lineStyle(this.px(1.2), 0xd1ba72, 0.7)
    g.strokePoints(pts, true)

    // Frame: a hairline border plus amber corner ticks around the viewport.
    const view = this.camera.worldView
    const inset = this.px(0.5)
    g.lineStyle(this.px(1), 0x404b36, 1)
    g.strokeRect(view.x + inset, view.y + inset, view.width - inset * 2, view.height - inset * 2)
    const tick = this.px(7)
    g.lineStyle(this.px(1.5), 0xefc36d, 0.9)
    for (const [cx, cy, sx, sy] of [
      [view.left, view.top, 1, 1],
      [view.right, view.top, -1, 1],
      [view.right, view.bottom, -1, -1],
      [view.left, view.bottom, 1, -1]
    ]) {
      const x = cx + sx * inset * 2
      const y = cy + sy * inset * 2
      g.lineBetween(x, y, x + sx * tick, y)
      g.lineBetween(x, y, x, y + sy * tick)
    }
  }

  /** Redraw blips and the main camera's view box. Cheap: a handful of shapes per frame. */
  update(blips: MinimapBlip[], mainView: Phaser.Geom.Rectangle, timeMs: number): void {
    const g = this.overlay
    g.clear()
    const pulse = this.reducedMotion() ? 1 : 0.55 + 0.45 * Math.sin(timeMs / 260)
    for (const blip of blips) {
      const x = blip.x + ORIGIN.x
      const y = blip.y + ORIGIN.y
      if (blip.kind === 'facility') {
        const r = this.px(4)
        g.fillStyle(blip.color, 0.95)
        g.fillPoints(
          [
            { x, y: y - r * 0.6 },
            { x: x + r, y },
            { x, y: y + r * 0.6 },
            { x: x - r, y }
          ],
          true
        )
        if (blip.ring) {
          g.lineStyle(this.px(1), blip.color, 0.35 + 0.5 * pulse)
          g.strokeEllipse(x, y, r * 3.6, r * 2.1)
        }
      } else {
        g.fillStyle(0x000000, 0.6)
        g.fillCircle(x, y, this.px(3.2))
        g.fillStyle(blip.color, 1)
        g.fillCircle(x, y, this.px(2.2))
        if (blip.ring) {
          g.lineStyle(this.px(1), 0x91c7bc, 0.9)
          g.strokeCircle(x, y, this.px(4.6))
        }
      }
    }
    // The main camera's visible area, clipped to the minimap frame.
    const view = this.camera.worldView
    const left = Math.max(view.left + this.px(1), mainView.left + ORIGIN.x)
    const top = Math.max(view.top + this.px(1), mainView.top + ORIGIN.y)
    const right = Math.min(view.right - this.px(1), mainView.right + ORIGIN.x)
    const bottom = Math.min(view.bottom - this.px(1), mainView.bottom + ORIGIN.y)
    if (right > left && bottom > top) {
      g.lineStyle(this.px(1), 0xecece2, 0.55)
      g.strokeRect(left, top, right - left, bottom - top)
    }
  }

  /** True when a pointer (in game-canvas pixels) is over the minimap. */
  contains(pointer: { x: number; y: number }): boolean {
    const v = this.camera
    return (
      pointer.x >= v.x &&
      pointer.x <= v.x + v.width &&
      pointer.y >= v.y &&
      pointer.y <= v.y + v.height
    )
  }

  /** World point (playfield coordinates) under a pointer on the minimap. */
  worldPointAt(pointer: { x: number; y: number }): { x: number; y: number } {
    const p = this.camera.getWorldPoint(pointer.x, pointer.y)
    return { x: p.x - ORIGIN.x, y: p.y - ORIGIN.y }
  }

  destroy(): void {
    this.scene.events.off(Phaser.Scenes.Events.ADDED_TO_SCENE, this.adopt, this)
    this.base.destroy()
    this.overlay.destroy()
    this.scene.cameras.remove(this.camera)
  }
}

function lerp(
  a: { x: number; y: number },
  b: { x: number; y: number },
  t: number
): { x: number; y: number } {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}
