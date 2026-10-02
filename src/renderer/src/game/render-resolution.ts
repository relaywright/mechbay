/**
 * Render-resolution math shared by App.tsx (which sizes the Phaser game) and
 * BayScene / Minimap (which derive their zoom from that size). Phaser-free so
 * it can be unit tested.
 *
 * BASE_VIEW is the logical viewport the camera framing was tuned against.
 * The game is created at the bay panel's own aspect ratio and true
 * device-pixel size, so Scale.FIT fills the panel edge to edge instead of
 * letterboxing a 1100:640 canvas inside it. renderScale is how many render
 * pixels one base-view pixel gets: the base view is fitted inside the game,
 * so the default framing never changes and any extra width or height simply
 * shows more of the world around the bay.
 */
export const BASE_VIEW_W = 1100
export const BASE_VIEW_H = 640
/** Cap so an enormous display can't blow up the GPU backing store. */
export const MAX_RENDER_SCALE = 4
/** Hard limit on either canvas side, well inside common WebGL texture limits. */
const MAX_RENDER_SIDE = 8192

/** Render pixels per base-view pixel for a game of this size (base view contained). */
export function renderScaleFor(gameW: number, gameH: number): number {
  return Math.min(gameW / BASE_VIEW_W, gameH / BASE_VIEW_H)
}

/**
 * Game (render) size for a parent of cssW × cssH CSS pixels at the given
 * devicePixelRatio: the parent's aspect, at device resolution, with the
 * resulting renderScale clamped to [1, MAX_RENDER_SCALE].
 */
export function gameSizeFor(
  cssW: number,
  cssH: number,
  dpr: number
): { width: number; height: number } {
  // Before layout the parent can report 0; fall back to the base aspect.
  const w = cssW > 0 ? cssW : BASE_VIEW_W
  const h = cssH > 0 ? cssH : (w * BASE_VIEW_H) / BASE_VIEW_W
  const cssScale = renderScaleFor(w, h)
  const renderScale = Math.min(Math.max(cssScale * (dpr || 1), 1), MAX_RENDER_SCALE)
  const pxPerCss = Math.min(renderScale / cssScale, MAX_RENDER_SIDE / Math.max(w, h))
  return { width: Math.round(w * pxPerCss), height: Math.round(h * pxPerCss) }
}
