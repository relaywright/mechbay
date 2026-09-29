import { describe, it, expect } from 'vitest'
import {
  computeFacingFlipX,
  computeGait,
  GAITS,
  stereoPan,
  walkDurationMs,
  WALK_FRAME_COUNT,
  WALK_MAX_MS,
  WALK_MIN_MS
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

describe('computeGait', () => {
  const gait = GAITS.atlas

  it('starts a walk on frame 0, at rest height, with no footfalls yet', () => {
    const pose = computeGait(0, gait, 1)
    expect(pose.frame).toBe(0)
    expect(pose.yOffset).toBeCloseTo(0, 5)
    expect(pose.step).toBe(0)
  })

  it('advances one frame per frameMs and wraps the cycle', () => {
    expect(computeGait(gait.frameMs, gait, 1).frame).toBe(1)
    expect(computeGait(gait.frameMs * 3, gait, 1).frame).toBe(3)
    expect(computeGait(gait.frameMs * WALK_FRAME_COUNT, gait, 1).frame).toBe(0)
  })

  it('counts a footfall every two frames', () => {
    expect(computeGait(gait.frameMs * 2 - 1, gait, 1).step).toBe(0)
    expect(computeGait(gait.frameMs * 2, gait, 1).step).toBe(1)
    expect(computeGait(gait.frameMs * 9, gait, 1).step).toBe(4)
  })

  it('rises to the full bob height mid-stride and sits lowest on contact', () => {
    expect(computeGait(gait.frameMs, gait, 1).yOffset).toBeCloseTo(-gait.bobPx, 5)
    expect(computeGait(gait.frameMs * 2, gait, 1).yOffset).toBeCloseTo(0, 5)
    for (let ms = 0; ms < 4000; ms += 23) {
      const y = computeGait(ms, gait, 1).yOffset
      expect(y).toBeLessThanOrEqual(1e-9)
      expect(y).toBeGreaterThanOrEqual(-gait.bobPx - 1e-9)
    }
  })

  it('leans into the direction of travel once the lean has ramped in', () => {
    const contact = gait.frameMs * 4 // on contact, roll is zero
    expect(computeGait(contact, gait, 1).angleDeg).toBeCloseTo(gait.leanDeg, 5)
    expect(computeGait(contact, gait, -1).angleDeg).toBeCloseTo(-gait.leanDeg, 5)
  })

  it('treats negative elapsed time as the start of the walk', () => {
    expect(computeGait(-50, gait, 1)).toEqual(computeGait(0, gait, 1))
  })

  it('makes heavier mechs slower and heavier-stepping than scouts', () => {
    expect(GAITS.atlas.speedPxPerSec).toBeLessThan(GAITS.locust.speedPxPerSec)
    expect(GAITS.atlas.frameMs).toBeGreaterThan(GAITS.locust.frameMs)
    expect(GAITS.atlas.shake).toBeGreaterThan(0)
    expect(GAITS.locust.shake).toBe(0)
  })
})

describe('walkDurationMs', () => {
  it('scales with distance at the gait speed', () => {
    const gait = GAITS.marauder
    expect(walkDurationMs(gait.speedPxPerSec * 2, gait)).toBeCloseTo(2000, 5)
  })

  it('clamps very short and very long walks', () => {
    expect(walkDurationMs(1, GAITS.atlas)).toBe(WALK_MIN_MS)
    expect(walkDurationMs(1e6, GAITS.atlas)).toBe(WALK_MAX_MS)
  })
})

describe('stereoPan', () => {
  it('centres a point in the middle of the view and softens the edges', () => {
    expect(stereoPan(500, 0, 1000)).toBeCloseTo(0, 5)
    expect(stereoPan(0, 0, 1000)).toBeCloseTo(-0.6, 5)
    expect(stereoPan(1000, 0, 1000)).toBeCloseTo(0.6, 5)
  })

  it('clamps points outside the view and handles an empty view', () => {
    expect(stereoPan(-5000, 0, 1000)).toBeCloseTo(-0.6, 5)
    expect(stereoPan(10, 0, 0)).toBe(0)
  })
})
