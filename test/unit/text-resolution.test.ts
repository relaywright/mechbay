import { describe, expect, it } from 'vitest'
import { MAX_USER_ZOOM, MIN_USER_ZOOM } from '../../src/renderer/src/game/bay-environment'
import {
  MAX_TEXT_RESOLUTION,
  MIN_TEXT_RESOLUTION,
  textResolutionForZoom
} from '../../src/renderer/src/game/text-resolution'

// Camera zoom = BASE_ZOOM (0.6, BayScene.ts) × renderScale (clamped to [1, 4]
// in App.tsx) × userZoom. Keep these in sync if those constants change.
const MIN_CAMERA_ZOOM = 0.6 * 1 * MIN_USER_ZOOM
const MAX_CAMERA_ZOOM = 0.6 * 4 * MAX_USER_ZOOM

describe('textResolutionForZoom', () => {
  it('never renders labels below screen resolution anywhere in the zoom range', () => {
    for (let zoom = MIN_CAMERA_ZOOM; zoom <= MAX_CAMERA_ZOOM; zoom += 0.01) {
      const resolution = textResolutionForZoom(zoom)
      expect(resolution).toBeGreaterThanOrEqual(zoom - 1e-9)
      expect(resolution - zoom).toBeLessThan(0.05 + 1e-9)
    }
  })

  it('covers the largest camera zoom the bay allows', () => {
    expect(MAX_TEXT_RESOLUTION).toBeGreaterThanOrEqual(MAX_CAMERA_ZOOM)
  })

  it('renders a maximized 4K window at about 2x, not 1x (the blurry-label bug)', () => {
    const renderScale = Math.min(4, Math.max(1, (1920 * 2) / 1100))
    expect(textResolutionForZoom(0.6 * renderScale)).toBeGreaterThanOrEqual(2)
  })

  it('clamps extreme zooms and falls back to 1 for invalid ones', () => {
    expect(textResolutionForZoom(0.01)).toBe(MIN_TEXT_RESOLUTION)
    expect(textResolutionForZoom(100)).toBe(MAX_TEXT_RESOLUTION)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(textResolutionForZoom(bad)).toBe(1)
    }
  })

  it('moves in 0.05 steps so tiny zoom changes do not re-rasterize labels', () => {
    expect(textResolutionForZoom(1)).toBe(1)
    expect(textResolutionForZoom(1.001)).toBe(1.05)
  })
})
