import { describe, it, expect } from 'vitest'
import {
  computeFacingFlipX,
  computeWalkBob,
  computeWalkFrame,
  DEFAULT_WALK_BOB,
  WALK_FRAME_COUNT,
  WALK_FRAME_MS
} from '../../src/renderer/src/game/bay-animation'

describe('computeFacingFlipX', () => {
  it('faces left (flipX true) when moving in the negative screen-x direction', () => {
    expect(computeFacingFlipX(false, -42)).toBe(true)
  })

  it('faces right (flipX false) when moving in the positive screen-x direction', () => {
    expect(computeFacingFlipX(true, 42)).toBe(false)
  })

  it('keeps the current facing on a purely vertical step (deltaX === 0)', () => {
    expect(computeFacingFlipX(true, 0)).toBe(true)
    expect(computeFacingFlipX(false, 0)).toBe(false)
  })

  it('treats negative zero as no horizontal movement (edge case)', () => {
    expect(computeFacingFlipX(true, -0)).toBe(true)
  })
})

describe('computeWalkBob', () => {
  it('starts a fresh walk leg at zero vertical offset', () => {
    const bob = computeWalkBob(0)
    expect(bob.yOffset).toBeCloseTo(0, 5)
  })

  it('reaches peak amplitude a quarter of the way through one bob cycle', () => {
    const quarterPeriodMs = 1000 / DEFAULT_WALK_BOB.frequencyHz / 4
    const bob = computeWalkBob(quarterPeriodMs)
    expect(bob.yOffset).toBeCloseTo(DEFAULT_WALK_BOB.amplitudePx, 5)
  })

  it('never exceeds the configured amplitude or sway bounds', () => {
    for (let ms = 0; ms < 5000; ms += 37) {
      const bob = computeWalkBob(ms)
      expect(Math.abs(bob.yOffset)).toBeLessThanOrEqual(DEFAULT_WALK_BOB.amplitudePx + 1e-9)
      expect(Math.abs(bob.angleDeg)).toBeLessThanOrEqual(DEFAULT_WALK_BOB.swayDeg + 1e-9)
    }
  })

  it('degrades to a flat zero offset when frequency is zero (edge case)', () => {
    const bob = computeWalkBob(1234, { amplitudePx: 3, frequencyHz: 0, swayDeg: 1 })
    expect(bob.yOffset).toBeCloseTo(0, 5)
  })
})

describe('computeWalkFrame', () => {
  it('starts a walk on frame 0', () => {
    expect(computeWalkFrame(0)).toBe(0)
  })

  it('advances one frame per frame-duration window', () => {
    expect(computeWalkFrame(WALK_FRAME_MS)).toBe(1)
    expect(computeWalkFrame(WALK_FRAME_MS * 2)).toBe(2)
    expect(computeWalkFrame(WALK_FRAME_MS * 3)).toBe(3)
  })

  it('wraps back to frame 0 after a full cycle', () => {
    expect(computeWalkFrame(WALK_FRAME_MS * WALK_FRAME_COUNT)).toBe(0)
    expect(computeWalkFrame(WALK_FRAME_MS * (WALK_FRAME_COUNT * 5 + 2))).toBe(2)
  })

  it('stays on the current frame within a frame-duration window', () => {
    expect(computeWalkFrame(WALK_FRAME_MS - 1)).toBe(0)
    expect(computeWalkFrame(WALK_FRAME_MS * 2 - 1)).toBe(1)
  })

  it('clamps negative elapsed time to frame 0 instead of a negative index (edge case)', () => {
    expect(computeWalkFrame(-50)).toBe(0)
  })

  it('always returns a valid frame index across a long walk', () => {
    for (let ms = 0; ms < 20000; ms += 33) {
      const frame = computeWalkFrame(ms)
      expect(frame).toBeGreaterThanOrEqual(0)
      expect(frame).toBeLessThan(WALK_FRAME_COUNT)
    }
  })
})
