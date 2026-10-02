import { describe, it, expect } from 'vitest'
import {
  alphaBounds,
  clearPockets,
  despillMagenta,
  flipHorizontal,
  footAnchorX,
  inkEdges,
  removeSpecks,
  schematicFrom,
  type Pixels
} from '../../scripts/sprite-forge'

function blank(width: number, height: number): Pixels {
  return { width, height, data: new Uint8Array(width * height * 4) }
}

function set(px: Pixels, x: number, y: number, rgba: [number, number, number, number]): void {
  px.data.set(rgba, (y * px.width + x) * 4)
}

function get(px: Pixels, x: number, y: number): number[] {
  const i = (y * px.width + x) * 4
  return Array.from(px.data.slice(i, i + 4))
}

function fillRect(
  px: Pixels,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgba: [number, number, number, number]
): void {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(px, x, y, rgba)
}

describe('despillMagenta', () => {
  it('pulls magenta spill down to the green level', () => {
    const px = blank(1, 1)
    set(px, 0, 0, [200, 40, 180, 255])
    despillMagenta(px)
    expect(get(px, 0, 0)).toEqual([60, 40, 40, 255])
  })

  it('leaves palette colours (orange, cyan, gray) untouched', () => {
    const px = blank(3, 1)
    set(px, 0, 0, [230, 120, 30, 255])
    set(px, 1, 0, [40, 200, 210, 255])
    set(px, 2, 0, [90, 90, 90, 255])
    const before = Array.from(px.data)
    despillMagenta(px)
    expect(Array.from(px.data)).toEqual(before)
  })
})

describe('inkEdges', () => {
  it('drops near-invisible pixels and pulls partial ones toward the ink tone', () => {
    const px = blank(3, 1)
    set(px, 0, 0, [200, 200, 200, 10])
    set(px, 1, 0, [200, 200, 200, 128])
    set(px, 2, 0, [200, 200, 200, 255])
    inkEdges(px)
    expect(get(px, 0, 0)[3]).toBe(0)
    const [r, , , a] = get(px, 1, 0)
    expect(a).toBe(128)
    expect(r).toBeLessThan(80)
    expect(get(px, 2, 0)).toEqual([200, 200, 200, 255])
  })
})

describe('removeSpecks', () => {
  it('removes small islands but keeps the main silhouette', () => {
    const px = blank(40, 40)
    fillRect(px, 5, 5, 20, 20, [80, 80, 80, 255])
    set(px, 35, 35, [255, 255, 255, 255])
    removeSpecks(px, 0.01)
    expect(get(px, 10, 10)[3]).toBe(255)
    expect(get(px, 35, 35)[3]).toBe(0)
  })

  it('keeps faint anti-aliasing that borders the silhouette', () => {
    const px = blank(30, 30)
    fillRect(px, 5, 5, 10, 10, [80, 80, 80, 255])
    set(px, 15, 8, [80, 80, 80, 40])
    set(px, 28, 28, [80, 80, 80, 40])
    removeSpecks(px)
    expect(get(px, 15, 8)[3]).toBe(40)
    expect(get(px, 28, 28)[3]).toBe(0)
  })
})

describe('flipHorizontal', () => {
  it('mirrors rows, including odd widths', () => {
    const px = blank(3, 1)
    set(px, 0, 0, [1, 0, 0, 255])
    set(px, 2, 0, [3, 0, 0, 255])
    flipHorizontal(px)
    expect(get(px, 0, 0)[0]).toBe(3)
    expect(get(px, 2, 0)[0]).toBe(1)
  })
})

describe('alphaBounds / footAnchorX', () => {
  it('returns null for an empty image', () => {
    expect(alphaBounds(blank(4, 4))).toBeNull()
  })

  it('anchors on the feet, not on an outstretched arm', () => {
    const px = blank(60, 60)
    fillRect(px, 20, 10, 10, 48, [80, 80, 80, 255]) // body + legs at x 20..29
    fillRect(px, 30, 20, 28, 4, [80, 80, 80, 255]) // long gun arm to the right
    const b = alphaBounds(px)!
    expect(b).toEqual({ x0: 20, y0: 10, x1: 57, y1: 57 })
    expect(footAnchorX(px, b)).toBeCloseTo(24.5, 5)
  })
})

describe('clearPockets', () => {
  it('clears neutral gray inside the polygon but keeps ink and tinted paint', () => {
    const px = blank(10, 10)
    fillRect(px, 0, 0, 10, 10, [60, 60, 60, 255]) // checker-like gray
    set(px, 4, 4, [5, 5, 5, 255]) // ink outline
    set(px, 5, 5, [200, 100, 30, 255]) // orange paint
    const cleared = clearPockets(px, [
      [
        [2, 2],
        [8, 2],
        [8, 8],
        [2, 8]
      ]
    ])
    expect(get(px, 3, 3)[3]).toBe(0)
    expect(get(px, 4, 4)[3]).toBe(255)
    expect(get(px, 5, 5)[3]).toBe(255)
    expect(get(px, 0, 0)[3]).toBe(255)
    expect(cleared).toBe(34)
  })
})

describe('schematicFrom', () => {
  it('traces the silhouette brightly, ghosts the interior, and leaves the outside clear', () => {
    const px = blank(20, 20)
    fillRect(px, 4, 4, 12, 12, [80, 80, 80, 255])
    const out = schematicFrom(px)
    expect(get(out, 4, 10)[3]).toBe(255) // rim
    expect(get(out, 10, 10)[3]).toBe(22) // flat interior: ghost fill only
    expect(get(out, 1, 1)[3]).toBe(0) // outside
    expect(get(out, 4, 10).slice(0, 3)).toEqual([125, 255, 154])
  })

  it('draws internal panel edges where brightness changes sharply', () => {
    const px = blank(20, 20)
    fillRect(px, 2, 2, 16, 16, [40, 40, 40, 255])
    fillRect(px, 10, 2, 8, 16, [220, 220, 220, 255])
    const out = schematicFrom(px)
    expect(get(out, 10, 10)[3]).toBeGreaterThan(90)
    expect(get(out, 6, 10)[3]).toBe(22)
  })
})
