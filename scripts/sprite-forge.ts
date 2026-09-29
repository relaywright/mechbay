/**
 * Sprite forge: turns the raw generated mech art into game-ready sheets.
 *
 * The source art came out of an image generator in two batches (1024px idle
 * portraits on a checkerboard, 4-frame walk strips on magenta) and does not
 * agree with itself: every image has different padding, three mechs face
 * left while the bay assumes right-facing art, Raven's last walk frame is
 * mirrored, and the cut-outs carry magenta spill and stray specks. Scaling
 * each texture to one fixed display box then makes mechs change size the
 * moment they start walking.
 *
 * This script normalises all of it into one sheet per mech:
 *   assets/mechs/sheets/<class>.png    5 cells of 256×256: idle, walk 0..3
 *   assets/mechs/portraits/<class>.png tight-cropped idle art for the HUD
 * Every cell is right-facing, feet on a shared baseline, and sized by the
 * mech's weight class, so the bay can place any frame at one fixed scale.
 *
 * Usage: node --experimental-strip-types scripts/sprite-forge.ts
 */
import { Jimp, ResizeStrategy } from 'jimp'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface Pixels {
  width: number
  height: number
  data: Uint8Array
}

export const CELL = 256
/** Screen-space y of the feet inside every cell (a few px of floor margin). */
export const BASELINE_Y = 250
export const SHEET_FRAMES = ['idle', 'walk0', 'walk1', 'walk2', 'walk3'] as const

/** Dark outline tone of the art; semi-transparent edge pixels are pulled toward it. */
const OUTLINE = { r: 18, g: 16, b: 14 }

/**
 * Remove magenta background spill. Magenta never appears in the mech
 * palette (gunmetal, orange, amber, cyan), so any pixel whose red AND blue
 * both exceed green is spill: pull both down to green's level.
 */
export function despillMagenta(px: Pixels): void {
  const d = px.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue
    const r = d[i]
    const g = d[i + 1]
    const b = d[i + 2]
    if (r > g && b > g) {
      const spill = Math.min(r, b) - g
      d[i] = r - spill
      d[i + 2] = b - spill
    }
  }
}

/**
 * Anti-aliased edge pixels still carry the old background colour (light
 * checker gray or magenta), which reads as a halo on the dark bay floor.
 * The art has a dark ink outline, so partially transparent pixels are
 * blended toward that ink, and near-invisible ones are dropped entirely.
 */
export function inkEdges(px: Pixels, minAlpha = 24, blend = 0.75): void {
  const d = px.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]
    if (a === 255) continue
    if (a < minAlpha) {
      d[i] = OUTLINE.r
      d[i + 1] = OUTLINE.g
      d[i + 2] = OUTLINE.b
      d[i + 3] = 0
      continue
    }
    d[i] = Math.round(d[i] + (OUTLINE.r - d[i]) * blend)
    d[i + 1] = Math.round(d[i + 1] + (OUTLINE.g - d[i + 1]) * blend)
    d[i + 2] = Math.round(d[i + 2] + (OUTLINE.b - d[i + 2]) * blend)
  }
}

/**
 * Drop specks: 8-connected islands of solid pixels much smaller than the
 * mech itself (leftover background noise the cut-out missed). Faint pixels
 * that don't border a surviving island go with them.
 */
export function removeSpecks(px: Pixels, keepFraction = 0.004, solidAlpha = 64): void {
  const { width, height, data } = px
  const label = new Int32Array(width * height).fill(-1)
  const sizes: number[] = []
  const stack: number[] = []
  for (let start = 0; start < width * height; start++) {
    if (label[start] !== -1 || data[start * 4 + 3] < solidAlpha) continue
    const id = sizes.length
    let size = 0
    label[start] = id
    stack.push(start)
    while (stack.length > 0) {
      const p = stack.pop()!
      size++
      const x = p % width
      const y = (p - x) / width
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const n = ny * width + nx
          if (label[n] !== -1 || data[n * 4 + 3] < solidAlpha) continue
          label[n] = id
          stack.push(n)
        }
      }
    }
    sizes.push(size)
  }
  if (sizes.length === 0) return
  const threshold = Math.max(...sizes) * keepFraction
  const kept = sizes.map((size) => size >= threshold)

  for (let p = 0; p < width * height; p++) {
    const a = data[p * 4 + 3]
    if (a === 0) continue
    if (label[p] >= 0) {
      if (!kept[label[p]]) data[p * 4 + 3] = 0
      continue
    }
    // Faint pixel: keep only if it touches a kept island within 2px.
    const x = p % width
    const y = (p - x) / width
    let near = false
    for (let dy = -2; dy <= 2 && !near; dy++) {
      for (let dx = -2; dx <= 2 && !near; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const l = label[ny * width + nx]
        if (l >= 0 && kept[l]) near = true
      }
    }
    if (!near) data[p * 4 + 3] = 0
  }
}

/**
 * Checkerboard pockets: background enclosed by the silhouette (between
 * legs, behind a gun arm) that the original edge-flood cut-out never
 * reached. Automatic detection can't tell these from gray-painted armour
 * (Catapult is neutral gray all over, and so is Marauder's gun), so each
 * pocket is traced by hand as a polygon in SOURCE-image pixels, inset from
 * the ink outline, and verified visually.
 */
export const POCKETS: Record<string, Array<Array<[number, number]>>> = {
  'marauder-poc': [
    [
      [691, 414],
      [729, 422],
      [727, 440],
      [722, 454],
      [716, 468],
      [713, 480],
      [702, 490],
      [684, 484],
      [670, 473],
      [668, 462],
      [672, 448],
      [682, 430]
    ],
    [
      [806, 282],
      [821, 284],
      [826, 310],
      [832, 330],
      [838, 346],
      [840, 364],
      [828, 382],
      [810, 376],
      [790, 362],
      [789, 330],
      [792, 310],
      [800, 292]
    ]
  ],
  'catapult-poc': [
    [
      [661, 489],
      [704, 489],
      [704, 507],
      [692, 519],
      [690, 563],
      [672, 565],
      [662, 548],
      [660, 520]
    ]
  ]
}

function insidePolygon(x: number, y: number, polygon: Array<[number, number]>): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]
    const [xj, yj] = polygon[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Clear neutral-gray pixels inside each pocket polygon. The near-black ink
 * outline (and any tinted paint) is left alone, so a polygon only needs to
 * sit roughly inside the outline. Returns the number of pixels cleared.
 */
export function clearPockets(
  px: Pixels,
  polygons: Array<Array<[number, number]>>,
  inkLevel = 14
): number {
  const { width, data } = px
  let cleared = 0
  for (const polygon of polygons) {
    const xs = polygon.map(([x]) => x)
    const ys = polygon.map(([, y]) => y)
    for (let y = Math.min(...ys); y <= Math.max(...ys); y++) {
      for (let x = Math.min(...xs); x <= Math.max(...xs); x++) {
        if (!insidePolygon(x + 0.5, y + 0.5, polygon)) continue
        const p = y * width + x
        const i = p * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        if (data[i + 3] === 0) continue
        if (Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b)) > 12) continue
        if ((r + g + b) / 3 < inkLevel) continue
        data[i + 3] = 0
        cleared++
      }
    }
  }
  return cleared
}

export function flipHorizontal(px: Pixels): void {
  const { width, height, data } = px
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width >> 1; x++) {
      const a = (y * width + x) * 4
      const b = (y * width + (width - 1 - x)) * 4
      for (let c = 0; c < 4; c++) {
        const t = data[a + c]
        data[a + c] = data[b + c]
        data[b + c] = t
      }
    }
  }
}

export interface Bounds {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Bounding box of pixels at or above `minAlpha`, or null if the image is empty. */
export function alphaBounds(px: Pixels, minAlpha = 64): Bounds | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      if (px.data[(y * px.width + x) * 4 + 3] < minAlpha) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

/**
 * Horizontal anchor for the feet: the solid-pixel centroid of the bottom
 * slice of the silhouette. Centering on the bounding box instead would make
 * a mech slide sideways whenever an arm or gun barrel swings out.
 */
export function footAnchorX(px: Pixels, bounds: Bounds, sliceFraction = 0.14): number {
  const top = Math.round(bounds.y1 - (bounds.y1 - bounds.y0) * sliceFraction)
  let sum = 0
  let count = 0
  for (let y = top; y <= bounds.y1; y++) {
    for (let x = bounds.x0; x <= bounds.x1; x++) {
      if (px.data[(y * px.width + x) * 4 + 3] < 64) continue
      sum += x
      count++
    }
  }
  return count === 0 ? (bounds.x0 + bounds.x1) / 2 : sum / count
}

/** Full cleanup pass applied to every source frame. */
export function cleanFrame(
  px: Pixels,
  flip: boolean,
  pockets: Array<Array<[number, number]>> = []
): void {
  if (pockets.length > 0) clearPockets(px, pockets)
  despillMagenta(px)
  inkEdges(px)
  removeSpecks(px)
  if (flip) flipHorizontal(px)
}

type MechClass = 'atlas' | 'marauder' | 'raven' | 'catapult' | 'locust'

interface MechSpec {
  /** Silhouette height (px) inside the 256 cell. Heavier mechs stand taller. */
  height: number
  /** Source idle art faces left and must be mirrored. */
  flipIdle: boolean
  /** Per walk frame: source faces left and must be mirrored. */
  flipWalk: [boolean, boolean, boolean, boolean]
}

/**
 * Weight classes drive on-field size: Atlas 100t assault down to Locust 20t
 * scout. Raven is light but tall (antenna mast), so it sits between.
 */
export const MECH_SPECS: Record<MechClass, MechSpec> = {
  atlas: { height: 236, flipIdle: false, flipWalk: [false, false, false, false] },
  marauder: { height: 214, flipIdle: true, flipWalk: [true, true, true, true] },
  raven: { height: 214, flipIdle: false, flipWalk: [false, false, false, true] },
  catapult: { height: 190, flipIdle: true, flipWalk: [true, true, true, true] },
  locust: { height: 166, flipIdle: true, flipWalk: [true, true, true, true] }
}

type JimpImage = Awaited<ReturnType<typeof Jimp.read>>

function toPixels(image: JimpImage): Pixels {
  return {
    width: image.bitmap.width,
    height: image.bitmap.height,
    data: image.bitmap.data as unknown as Uint8Array
  }
}

/**
 * Downscale in successive halvings before the final resize. Jimp's
 * resamplers don't prefilter, so one big 1024→240 jump aliases fine
 * panel lines into sparkle.
 */
function downscale(image: JimpImage, targetW: number, targetH: number): void {
  while (image.bitmap.width / 2 >= targetW && image.bitmap.height / 2 >= targetH) {
    image.resize({
      w: Math.round(image.bitmap.width / 2),
      h: Math.round(image.bitmap.height / 2),
      mode: ResizeStrategy.BILINEAR
    })
  }
  image.resize({ w: targetW, h: targetH, mode: ResizeStrategy.BICUBIC })
}

async function forgeMech(root: string, mech: MechClass): Promise<void> {
  const spec = MECH_SPECS[mech]
  const idle = await Jimp.read(join(root, 'assets/mechs', `${mech}-poc.png`))
  const walkSheet = await Jimp.read(join(root, 'assets/mechs/walk', `${mech}-walk.png`))
  const walkCell = walkSheet.bitmap.height
  const frames: JimpImage[] = [idle]
  for (let i = 0; i < 4; i++) {
    frames.push(walkSheet.clone().crop({ x: i * walkCell, y: 0, w: walkCell, h: walkCell }))
  }
  const flips = [spec.flipIdle, ...spec.flipWalk]
  frames.forEach((frame, i) =>
    cleanFrame(toPixels(frame), flips[i], i === 0 ? (POCKETS[`${mech}-poc`] ?? []) : [])
  )

  const bounds = frames.map((frame) => {
    const b = alphaBounds(toPixels(frame))
    if (!b) throw new Error(`${mech}: frame ${frameName(frames.indexOf(frame))} is empty`)
    return b
  })

  // The idle frame gets its own scale; the walk frames share one scale
  // (from their median height) so the per-frame bob baked into the walk art
  // survives normalisation instead of being flattened out.
  const heightOf = (b: Bounds): number => b.y1 - b.y0 + 1
  const walkHeights = bounds
    .slice(1)
    .map(heightOf)
    .sort((a, b) => a - b)
  const walkMedian = (walkHeights[1] + walkHeights[2]) / 2
  const scales = bounds.map((b, i) => spec.height / (i === 0 ? heightOf(b) : walkMedian))

  const sheet = new Jimp({ width: CELL * SHEET_FRAMES.length, height: CELL, color: 0x00000000 })
  frames.forEach((frame, i) => {
    const b = bounds[i]
    const anchor = footAnchorX(toPixels(frame), b)
    let scale = scales[i]
    const cropW = b.x1 - b.x0 + 1
    // Never let a wide pose (gun barrels, missile racks) overflow the cell.
    scale = Math.min(scale, (CELL - 8) / cropW)
    const piece = frame.clone().crop({ x: b.x0, y: b.y0, w: cropW, h: heightOf(b) })
    const w = Math.max(1, Math.round(cropW * scale))
    const h = Math.max(1, Math.round(heightOf(b) * scale))
    downscale(piece, w, h)
    const x = Math.round(CELL / 2 - (anchor - b.x0) * scale)
    const clampedX = Math.min(Math.max(x, 2), CELL - w - 2)
    sheet.composite(piece, i * CELL + clampedX, BASELINE_Y - h)
  })
  mkdirSync(join(root, 'assets/mechs/sheets'), { recursive: true })
  await sheet.write(join(root, 'assets/mechs/sheets', `${mech}.png`) as `${string}.png`)

  // HUD portrait: the cleaned idle art, tight-cropped, at most 384px tall.
  const b = bounds[0]
  const portrait = frames[0].clone().crop({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: heightOf(b) })
  const pScale = Math.min(1, 384 / heightOf(b))
  downscale(
    portrait,
    Math.round(portrait.bitmap.width * pScale),
    Math.round(portrait.bitmap.height * pScale)
  )
  mkdirSync(join(root, 'assets/mechs/portraits'), { recursive: true })
  await portrait.write(join(root, 'assets/mechs/portraits', `${mech}.png`) as `${string}.png`)
  console.log(`forged ${mech}`)
}

function frameName(index: number): string {
  return SHEET_FRAMES[index] ?? String(index)
}

if (process.argv[1]?.endsWith('sprite-forge.ts')) {
  const root = resolve(import.meta.dirname, '..')
  for (const mech of Object.keys(MECH_SPECS) as MechClass[]) await forgeMech(root, mech)
}
