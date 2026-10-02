import { describe, it, expect } from 'vitest'
import {
  deckTile,
  conduitPath,
  clampZoom,
  clampPan,
  panBounds,
  panToKeepPoint,
  MIN_USER_ZOOM,
  MAX_USER_ZOOM
} from '../../src/renderer/src/game/bay-environment'

describe('deckTile', () => {
  it('is deterministic — the same tile always produces the same result', () => {
    expect(deckTile(4, 7)).toEqual(deckTile(4, 7))
    expect(deckTile(0, 0)).toEqual(deckTile(0, 0))
  })

  it('produces shade values within the documented 0..1-ish range', () => {
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        const tile = deckTile(x, y)
        expect(tile.shade).toBeGreaterThanOrEqual(0.82)
        expect(tile.shade).toBeLessThanOrEqual(1.18)
      }
    }
  })

  it('produces a distribution of all three variants across the grid (not a flat repeat)', () => {
    const seen = new Set<string>()
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        seen.add(deckTile(x, y).variant)
      }
    }
    expect(seen.has('plate')).toBe(true)
    expect(seen.has('grate')).toBe(true)
    expect(seen.has('hazard')).toBe(true)
  })

  it('confines hazard striping to the hangar row and the grid edge, not scattered randomly', () => {
    for (let x = 2; x < 14; x++) {
      for (let y = 1; y < 15; y++) {
        if (y === 10) continue // hangar band — hazard is expected here
        const tile = deckTile(x, y)
        expect(tile.variant).not.toBe('hazard')
      }
    }
  })

  it('differs from its neighbors often enough to read as varied, not uniform', () => {
    const shades = Array.from({ length: 16 }, (_, x) => deckTile(x, 3).shade)
    const uniqueShades = new Set(shades.map((s) => s.toFixed(4)))
    expect(uniqueShades.size).toBeGreaterThan(1)
  })
})

describe('conduitPath', () => {
  it('returns a single point when from and to are the same tile (edge case)', () => {
    expect(conduitPath({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual([{ x: 5, y: 5 }])
  })

  it('includes both endpoints', () => {
    const path = conduitPath({ x: 2, y: 8 }, { x: 9, y: 3 })
    expect(path[0]).toEqual({ x: 2, y: 8 })
    expect(path[path.length - 1]).toEqual({ x: 9, y: 3 })
  })

  it('routes the x-leg first (along the start row), then the y-leg (along the end column)', () => {
    const path = conduitPath({ x: 2, y: 8 }, { x: 5, y: 11 })
    // Every waypoint before the x reaches its destination stays on the start row.
    const xLeg = path.filter((p) => p.x !== 5)
    for (const point of xLeg) expect(point.y).toBe(8)
    // Every waypoint after x has settled sits on the destination column.
    const yLeg = path.filter((p) => p.y !== 8)
    for (const point of yLeg) expect(point.x).toBe(5)
  })

  it('degenerates to a straight line when the tiles share a row', () => {
    const path = conduitPath({ x: 1, y: 4 }, { x: 6, y: 4 })
    expect(path.every((p) => p.y === 4)).toBe(true)
    expect(path[0]).toEqual({ x: 1, y: 4 })
    expect(path[path.length - 1]).toEqual({ x: 6, y: 4 })
  })

  it('degenerates to a straight line when the tiles share a column', () => {
    const path = conduitPath({ x: 3, y: 1 }, { x: 3, y: 9 })
    expect(path.every((p) => p.x === 3)).toBe(true)
    expect(path[0]).toEqual({ x: 3, y: 1 })
    expect(path[path.length - 1]).toEqual({ x: 3, y: 9 })
  })

  it('handles routing toward a lower/earlier tile (negative steps)', () => {
    const path = conduitPath({ x: 9, y: 9 }, { x: 3, y: 2 })
    expect(path[0]).toEqual({ x: 9, y: 9 })
    expect(path[path.length - 1]).toEqual({ x: 3, y: 2 })
    expect(path.every((p) => p.x >= 3 && p.x <= 9 && p.y >= 2 && p.y <= 9)).toBe(true)
  })
})

describe('clampZoom', () => {
  it('leaves values within the default range untouched', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(1.5)).toBe(1.5)
  })

  it('clamps below the minimum', () => {
    expect(clampZoom(0.1)).toBe(MIN_USER_ZOOM)
  })

  it('clamps above the maximum', () => {
    expect(clampZoom(9)).toBe(MAX_USER_ZOOM)
  })

  it('respects custom min/max bounds', () => {
    expect(clampZoom(5, 0.5, 3)).toBe(3)
    expect(clampZoom(0.1, 0.5, 3)).toBe(0.5)
  })
})

describe('panBounds + clampPan', () => {
  it('gives a small nonzero allowance at the default (1x) zoom', () => {
    const bounds = panBounds(1)
    expect(bounds.maxX).toBeGreaterThan(0)
    expect(bounds.maxY).toBeGreaterThan(0)
  })

  it('grows the pan allowance as the user zooms in', () => {
    const atDefault = panBounds(1)
    const zoomedIn = panBounds(2)
    expect(zoomedIn.maxX).toBeGreaterThan(atDefault.maxX)
    expect(zoomedIn.maxY).toBeGreaterThan(atDefault.maxY)
  })

  it('clampPan leaves an in-bounds pan untouched', () => {
    const bounds = { maxX: 100, maxY: 50 }
    expect(clampPan({ x: 20, y: -10 }, bounds)).toEqual({ x: 20, y: -10 })
  })

  it('clampPan clamps an out-of-bounds pan symmetrically', () => {
    const bounds = { maxX: 100, maxY: 50 }
    expect(clampPan({ x: 500, y: -500 }, bounds)).toEqual({ x: 100, y: -50 })
  })
})

describe('panToKeepPoint', () => {
  // The world point under a screen point is center + offset / zoom, where
  // offset is the screen point's distance from the middle of the view.
  const worldAt = (center: number, offset: number, zoom: number): number => center + offset / zoom

  it('keeps the world point under the cursor fixed while zooming in', () => {
    const pan = { x: 40, y: -10 }
    const offset = { x: -600, y: 150 } // cursor over Salvage Dock, left of center
    const next = panToKeepPoint(pan, offset, 1.3, 1.69)
    expect(worldAt(next.x, offset.x, 1.69)).toBeCloseTo(worldAt(pan.x, offset.x, 1.3))
    expect(worldAt(next.y, offset.y, 1.69)).toBeCloseTo(worldAt(pan.y, offset.y, 1.3))
    expect(next.x).toBeLessThan(pan.x) // the view moves toward the cursor
  })

  it('leaves the pan alone for a cursor at the center or an unchanged zoom', () => {
    expect(panToKeepPoint({ x: 5, y: 7 }, { x: 0, y: 0 }, 1, 2)).toEqual({ x: 5, y: 7 })
    expect(panToKeepPoint({ x: 5, y: 7 }, { x: 300, y: -90 }, 1.5, 1.5)).toEqual({ x: 5, y: 7 })
  })
})
