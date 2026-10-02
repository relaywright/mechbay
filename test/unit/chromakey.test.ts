import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdir, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { Jimp, rgbaToInt, intToRGBA } from 'jimp'

const asImagePath = (path: string): `${string}.${string}` => path as `${string}.${string}`

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const TEST_DIR = join(__dirname, '.test-temp')

// Helper to create a synthetic checkerboard PNG
async function createCheckerboardPNG(
  path: string,
  size: number = 16,
  color1: { r: number; g: number; b: number } = { r: 128, g: 128, b: 128 }, // gray
  color2: { r: number; g: number; b: number } = { r: 204, g: 204, b: 204 } // white-ish
): Promise<void> {
  const image = new Jimp({ width: size, height: size })

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const isEven = (x + y) % 2 === 0
      const color = isEven ? color1 : color2
      const hex = rgbaToInt(color.r, color.g, color.b, 255)
      image.setPixelColor(hex, x, y)
    }
  }

  await image.write(asImagePath(path))
}

// Helper to create a solid color PNG
async function createSolidPNG(
  path: string,
  size: number = 16,
  color: { r: number; g: number; b: number } = { r: 255, g: 0, b: 0 }
): Promise<void> {
  const image = new Jimp({ width: size, height: size })
  const hex = rgbaToInt(color.r, color.g, color.b, 255)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      image.setPixelColor(hex, x, y)
    }
  }

  await image.write(asImagePath(path))
}

// Helper to load all alphas from an image
async function getAllAlphas(path: string): Promise<number[]> {
  const image = await Jimp.read(path)
  const alphas: number[] = []

  image.scan(0, 0, image.bitmap.width, image.bitmap.height, (_x, _y, idx) => {
    alphas.push(image.bitmap.data[idx + 3])
  })

  return alphas
}

describe('chromakey', () => {
  beforeAll(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true })
    }
    await mkdir(TEST_DIR, { recursive: true })
  })

  afterAll(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true })
    }
  })

  it('detects and alpha-outs checkerboard pattern', async () => {
    const testFile = join(TEST_DIR, 'checker.png')
    await createCheckerboardPNG(testFile, 16)

    // Import and run chromakey
    const { processImage } = await import('../../scripts/chromakey.js')
    await processImage(testFile)

    // Check that all pixels have alpha = 0
    const alphas = await getAllAlphas(testFile)
    expect(alphas.every((a) => a === 0)).toBe(true)
  })

  it('preserves solid colors', async () => {
    const testFile = join(TEST_DIR, 'solid-red.png')
    await createSolidPNG(testFile, 16, { r: 255, g: 0, b: 0 })

    const { processImage } = await import('../../scripts/chromakey.js')
    await processImage(testFile)

    // Check that all pixels still have alpha = 255
    const alphas = await getAllAlphas(testFile)
    expect(alphas.every((a) => a === 255)).toBe(true)
  })

  it('detects checker across threshold variations', async () => {
    // Create checkerboard with slightly off shades (within tolerance)
    const testFile = join(TEST_DIR, 'checker-variation.png')
    await createCheckerboardPNG(
      testFile,
      16,
      { r: 130, g: 125, b: 128 }, // slightly off gray
      { r: 200, g: 208, b: 202 } // slightly off white-ish
    )

    const { processImage } = await import('../../scripts/chromakey.js')
    await processImage(testFile)

    // Most pixels should be transparent (allowing for edge preservation)
    const alphas = await getAllAlphas(testFile)
    const transparentCount = alphas.filter((a) => a === 0).length
    const totalCount = alphas.length

    // At least 80% should be transparent (edges may be preserved)
    expect(transparentCount / totalCount).toBeGreaterThan(0.8)
  })

  it('preserves silhouette edges', async () => {
    // Create an image with checkerboard in middle but solid color on edges
    const testFile = join(TEST_DIR, 'silhouette.png')
    const size = 16
    const image = new Jimp({ width: size, height: size })

    // Fill with checkerboard
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const isEven = (x + y) % 2 === 0
        const color = isEven ? { r: 128, g: 128, b: 128 } : { r: 204, g: 204, b: 204 }
        const hex = rgbaToInt(color.r, color.g, color.b, 255)
        image.setPixelColor(hex, x, y)
      }
    }

    // Add a solid red "mech" in the center (4x4)
    for (let y = 6; y < 10; y++) {
      for (let x = 6; x < 10; x++) {
        const hex = rgbaToInt(255, 0, 0, 255)
        image.setPixelColor(hex, x, y)
      }
    }

    await image.write(asImagePath(testFile))

    const { processImage } = await import('../../scripts/chromakey.js')
    await processImage(testFile)

    // Check that the mech pixels are still opaque
    const resultImage = await Jimp.read(testFile)

    // Center mech pixels should be opaque
    for (let y = 6; y < 10; y++) {
      for (let x = 6; x < 10; x++) {
        const color = intToRGBA(resultImage.getPixelColor(x, y))
        expect(color.a).toBe(255)
        expect(color.r).toBe(255)
        expect(color.g).toBe(0)
        expect(color.b).toBe(0)
      }
    }
  })
})
