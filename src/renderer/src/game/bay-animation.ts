/**
 * Pure animation math for BayScene, kept free of any Phaser import so it can
 * be unit tested without a canvas/WebGL context. BayScene applies these
 * values to sprites each frame; this module only computes numbers.
 */
import type { MechClass } from '../../../shared/types'

/**
 * Sprite facing based on horizontal screen-space travel direction. A mech
 * only re-faces when it actually moves horizontally — a purely vertical
 * step (straight north/south on the iso grid) keeps whatever facing it had.
 * The forged sheets are all right-facing, so flipX means "facing left".
 */
export function computeFacingFlipX(currentFlipX: boolean, deltaX: number): boolean {
  if (deltaX > 0) return false
  if (deltaX < 0) return true
  return currentFlipX
}

/** Frames per walk cycle in the forged sheets (sheet frames 1..4). */
export const WALK_FRAME_COUNT = 4

export type FootstepSound = 'footstep-heavy' | 'footstep-medium' | 'footstep-light'

/**
 * How a mech class moves. Weight is sold through timing, not art: an Atlas
 * takes slow, deep strides that shake the camera; a Locust skitters.
 */
export interface GaitProfile {
  /** Ground speed in world px per second. */
  speedPxPerSec: number
  /** How long each walk frame is held; one step spans two frames. */
  frameMs: number
  /** How far the body rises between footfalls (px). */
  bobPx: number
  /** Forward lean into the direction of travel (degrees). */
  leanDeg: number
  /** Side-to-side roll that alternates with each step (degrees). */
  swayDeg: number
  /** Camera shake intensity per footfall (0 = none). */
  shake: number
  footstep: FootstepSound
  /** Pitch multiplier for the footstep sound. */
  stepRate: number
  /** Scale of the dust kicked up per footfall. */
  dust: number
  /** Squash (fraction of height) on each footfall and on landing. */
  squash: number
}

export const GAITS: Record<MechClass, GaitProfile> = {
  atlas: {
    speedPxPerSec: 96,
    frameMs: 190,
    bobPx: 3.6,
    leanDeg: 2,
    swayDeg: 1.2,
    shake: 0.0016,
    footstep: 'footstep-heavy',
    stepRate: 0.9,
    dust: 1.4,
    squash: 0.035
  },
  marauder: {
    speedPxPerSec: 118,
    frameMs: 155,
    bobPx: 3,
    leanDeg: 2.6,
    swayDeg: 1,
    shake: 0.0009,
    footstep: 'footstep-heavy',
    stepRate: 1.1,
    dust: 1.15,
    squash: 0.028
  },
  catapult: {
    speedPxPerSec: 108,
    frameMs: 165,
    bobPx: 2.8,
    leanDeg: 1.6,
    swayDeg: 1.4,
    shake: 0.0007,
    footstep: 'footstep-medium',
    stepRate: 0.95,
    dust: 1.1,
    squash: 0.03
  },
  raven: {
    speedPxPerSec: 158,
    frameMs: 118,
    bobPx: 2.2,
    leanDeg: 3.6,
    swayDeg: 0.8,
    shake: 0,
    footstep: 'footstep-light',
    stepRate: 1,
    dust: 0.8,
    squash: 0.018
  },
  locust: {
    speedPxPerSec: 190,
    frameMs: 92,
    bobPx: 1.7,
    leanDeg: 4.5,
    swayDeg: 0.6,
    shake: 0,
    footstep: 'footstep-light',
    stepRate: 1.25,
    dust: 0.6,
    squash: 0.014
  }
}

/** Clamp range for a walk's duration so very short or very long treks still read well. */
export const WALK_MIN_MS = 900
export const WALK_MAX_MS = 6000

/** Constant-speed walk duration for a given distance and gait. */
export function walkDurationMs(distancePx: number, gait: GaitProfile): number {
  const ms = (distancePx / gait.speedPxPerSec) * 1000
  return Math.min(WALK_MAX_MS, Math.max(WALK_MIN_MS, ms))
}

export interface GaitPose {
  /** Walk-cycle frame, 0..WALK_FRAME_COUNT-1. */
  frame: number
  /** Vertical offset in px (≤ 0: the body rises between footfalls). */
  yOffset: number
  /** Body rotation in degrees (lean + per-step roll). */
  angleDeg: number
  /** Footfalls so far; a change from the previous pose means a foot just landed. */
  step: number
}

/** Time for the forward lean to ease in at the start of a walk. */
const LEAN_RAMP_MS = 260

/**
 * Pose at `elapsedMs` into a walk. Each step lasts two frames: the body
 * sits lowest at the moment of contact and rises mid-stride (|sin| arc,
 * which reads as weight far better than a plain sine bob), the roll
 * alternates direction every step, and the lean eases in so a mech doesn't
 * snap forward. `direction` is +1 walking right, -1 walking left.
 */
export function computeGait(elapsedMs: number, gait: GaitProfile, direction: 1 | -1): GaitPose {
  const t = Math.max(0, elapsedMs)
  const stepMs = gait.frameMs * 2
  const step = Math.floor(t / stepMs)
  const phase = (t % stepMs) / stepMs
  const lift = Math.sin(Math.PI * phase)
  const roll = (step % 2 === 0 ? 1 : -1) * gait.swayDeg * lift
  const lean = direction * gait.leanDeg * Math.min(1, t / LEAN_RAMP_MS)
  return {
    frame: Math.floor(t / gait.frameMs) % WALK_FRAME_COUNT,
    yOffset: -gait.bobPx * lift,
    angleDeg: lean + roll,
    step
  }
}

/**
 * Stereo pan for a world point given the camera's visible world rectangle:
 * -1 at the left edge, +1 at the right, softened so sounds never hard-pan.
 */
export function stereoPan(worldX: number, viewLeft: number, viewWidth: number): number {
  if (viewWidth <= 0) return 0
  const normalized = ((worldX - viewLeft) / viewWidth) * 2 - 1
  return Math.max(-1, Math.min(1, normalized)) * 0.6
}
