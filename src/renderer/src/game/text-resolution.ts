/**
 * Phaser Text draws into its own canvas at `resolution` texels per world
 * unit, and the camera then scales that texture by its zoom. Matching the
 * resolution to the camera zoom gives about one texel per screen pixel, so
 * labels stay crisp at every zoom and renderScale instead of being stretched
 * (the 4K blur). Rounded up to 0.05 steps so the texture is never coarser
 * than the screen and tiny zoom changes do not re-rasterize every label.
 */
export const MIN_TEXT_RESOLUTION = 0.5
export const MAX_TEXT_RESOLUTION = 6
const STEPS_PER_UNIT = 20

export function textResolutionForZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  const clamped = Math.min(MAX_TEXT_RESOLUTION, Math.max(MIN_TEXT_RESOLUTION, zoom))
  return Math.ceil(clamped * STEPS_PER_UNIT) / STEPS_PER_UNIT
}
