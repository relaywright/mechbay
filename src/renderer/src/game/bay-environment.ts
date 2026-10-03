/**
 * Pure, Phaser-free helpers for the bay's environment layer: deterministic
 * deck-tile variation, conduit routing between facilities, and camera
 * zoom/pan clamping. Kept free of any Phaser import (mirrors
 * bay-animation.ts's pattern) so they can be unit tested without a
 * canvas/WebGL context. BayScene applies these values to Graphics/sprites;
 * this module only computes numbers.
 */

export type DeckVariant = 'plate' | 'grate' | 'hazard'

export interface DeckTile {
  /** 0..1 worn-steel tint variation — applied as tint/alpha, not a new asset. */
  shade: number
  variant: DeckVariant
}

/**
 * Small deterministic integer hash (a variant of the standard xorshift-mix
 * hash). Same (x, y) always produces the same value in [0, 1) — this is
 * what makes deck plating look "worn" instead of a flat repeat without
 * needing per-tile art or stored randomness.
 */
function hash2(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = (h ^ (h >> 13)) * 1274126177
  h = h ^ (h >> 16)
  return (h >>> 0) / 4294967295
}

/**
 * Deterministic per-tile deck appearance. Hazard striping is deliberately
 * sparse and confined to two "sensible" bands — the hangar row where mechs
 * stand (y === 10) and the grid's outer edge — rather than scattered
 * randomly across the field, so it reads as intentional wayfinding instead
 * of visual noise competing with the sprites.
 */
export function deckTile(x: number, y: number, gridW = 16, gridH = 16): DeckTile {
  const shade = 0.82 + hash2(x, y) * 0.36

  const isEdgeBand = x === 0 || y === 0 || x === gridW - 1 || y === gridH - 1
  const isHangarBand = y === 10 && x >= 2 && x <= gridW - 3

  let variant: DeckVariant = 'plate'
  if (isEdgeBand || isHangarBand) {
    // Only a fraction of the eligible band actually stripes — a sparse
    // accent, not a solid painted line.
    variant = hash2(x + 11, y + 53) < 0.35 ? 'hazard' : 'plate'
  } else if (hash2(x + 97, y + 31) < 0.1) {
    variant = 'grate'
  }

  return { shade, variant }
}

export interface TileCoord {
  x: number
  y: number
}

/**
 * L-shaped iso conduit route between two tiles: the x-leg first (along
 * `from`'s row), then the y-leg (along `to`'s column), both inclusive of
 * their endpoints. Degenerates to a straight line when `from`/`to` share an
 * axis, and to a single point when they're the same tile.
 */
export function conduitPath(from: TileCoord, to: TileCoord): TileCoord[] {
  const waypoints: TileCoord[] = [{ x: from.x, y: from.y }]

  const stepX = Math.sign(to.x - from.x)
  for (let x = from.x + stepX; stepX !== 0 && x !== to.x + stepX; x += stepX) {
    waypoints.push({ x, y: from.y })
  }

  const stepY = Math.sign(to.y - from.y)
  for (let y = from.y + stepY; stepY !== 0 && y !== to.y + stepY; y += stepY) {
    waypoints.push({ x: to.x, y })
  }

  return waypoints
}

/** Clamp range for the user's mouse-wheel camera zoom multiplier. */
export const MIN_USER_ZOOM = 0.8
export const MAX_USER_ZOOM = 2.2

/** Keep the user's zoom multiplier inside the framing bounds. */
export function clampZoom(zoom: number, min = MIN_USER_ZOOM, max = MAX_USER_ZOOM): number {
  return Math.min(max, Math.max(min, zoom))
}

export interface PanBounds {
  maxX: number
  maxY: number
}

/**
 * How far the camera is allowed to pan (in world px) at a given user zoom
 * level. More zoom means the diamond fills more of the frame, so there's
 * more slack before panning would push the bay entirely off-screen; at the
 * default zoom (1) the allowance is a small fixed margin, not zero, so a
 * light nudge still feels responsive.
 */
export function panBounds(userZoom: number, baseViewW = 1100, baseViewH = 640): PanBounds {
  const factor = Math.max(0, userZoom - 1)
  return {
    maxX: baseViewW * 0.5 * factor + baseViewW * 0.15,
    maxY: baseViewH * 0.5 * factor + baseViewH * 0.15
  }
}

/**
 * The pan that keeps one world point under the same screen point while the
 * camera zoom changes. `offset` is that screen point's distance from the
 * middle of the view, in canvas pixels; the world point there is
 * center + offset / zoom, so the center moves by offset × (1/from − 1/to).
 */
export function panToKeepPoint(
  pan: TileCoord,
  offset: TileCoord,
  fromZoom: number,
  toZoom: number
): TileCoord {
  const shift = 1 / fromZoom - 1 / toZoom
  return { x: pan.x + offset.x * shift, y: pan.y + offset.y * shift }
}

/** Clamp a pan offset within the given bounds (rectangular, symmetric around 0). */
export function clampPan(pan: TileCoord, bounds: PanBounds): TileCoord {
  return {
    x: Math.min(bounds.maxX, Math.max(-bounds.maxX, pan.x)),
    y: Math.min(bounds.maxY, Math.max(-bounds.maxY, pan.y))
  }
}
