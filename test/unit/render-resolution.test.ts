import { describe, expect, it } from 'vitest'
import {
  BASE_VIEW_H,
  BASE_VIEW_W,
  MAX_RENDER_SCALE,
  gameSizeFor,
  renderScaleFor
} from '../../src/renderer/src/game/render-resolution'

describe('gameSizeFor', () => {
  // A maximized 4K window: the field is far wider than 1100:640. A canvas at
  // the base aspect is letterboxed by Scale.FIT, so zooming in cut the deck
  // off at the canvas's straight edges in the middle of the panel.
  it('matches the parent aspect so Scale.FIT fills the whole field', () => {
    const size = gameSizeFor(1472, 533, 2)
    expect(size.width / size.height).toBeCloseTo(1472 / 533, 2)
    expect(size).toEqual({ width: 2944, height: 1066 })
  })

  it('renders at device-pixel resolution', () => {
    expect(gameSizeFor(1100, 640, 1)).toEqual({ width: 1100, height: 640 })
    expect(gameSizeFor(1100, 640, 2)).toEqual({ width: 2200, height: 1280 })
  })

  it('never renders the base view below 1x, even in a small window', () => {
    const size = gameSizeFor(800, 300, 1)
    expect(renderScaleFor(size.width, size.height)).toBeCloseTo(1, 2)
    expect(size.width / size.height).toBeCloseTo(800 / 300, 2)
  })

  it('caps the render scale so a huge display cannot blow up the GPU backing store', () => {
    const size = gameSizeFor(3000, 1700, 4)
    expect(renderScaleFor(size.width, size.height)).toBeCloseTo(MAX_RENDER_SCALE, 2)
  })

  it('never draws more than 3 render pixels per device pixel in a short, wide panel', () => {
    // 2000x121 CSS: holding the base view at 1x would take 5.3 render px per CSS px.
    const size = gameSizeFor(2000, 121, 1)
    expect(size.width).toBeLessThanOrEqual(2000 * 3)
    expect(size.width / size.height).toBeCloseTo(2000 / 121, 1)
  })

  it('holds the 3x oversampling cap per device pixel when the page is zoomed out below 1x', () => {
    // Zoomed out to 50%: 2000x121 CSS px are 1000x60.5 device px.
    const size = gameSizeFor(2000, 121, 0.5)
    expect(size.width).toBeLessThanOrEqual(1000 * 3)
  })

  it('treats a missing or broken devicePixelRatio as 1', () => {
    const expected = gameSizeFor(1600, 900, 1)
    for (const dpr of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(gameSizeFor(1600, 900, dpr)).toEqual(expected)
    }
  })

  it('falls back to the base aspect before the parent has been laid out', () => {
    expect(gameSizeFor(0, 0, 1)).toEqual({ width: BASE_VIEW_W, height: BASE_VIEW_H })
  })
})

describe('renderScaleFor', () => {
  it('fits the whole base view inside the game, whichever side is tighter', () => {
    expect(renderScaleFor(2200, 1280)).toBe(2)
    // Wider than the base aspect: height limits, the extra width shows more apron.
    expect(renderScaleFor(2944, 1066)).toBeCloseTo(1066 / BASE_VIEW_H, 5)
    // Taller than the base aspect: width limits.
    expect(renderScaleFor(1100, 1000)).toBe(1)
  })
})
