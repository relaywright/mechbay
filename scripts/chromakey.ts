import { Jimp, rgbaToInt, intToRGBA } from 'jimp'
import { mkdir, copyFile, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join, dirname, basename } from 'path'

// Checkerboard detection colors (typical Gemini checker shades)
const CHECKER_GRAY = { r: 128, g: 128, b: 128 }
const CHECKER_WHITE = { r: 204, g: 204, b: 204 }
const TOLERANCE = 25

/**
 * Check if a pixel color matches the checkerboard pattern
 */
function isCheckerColor(r: number, g: number, b: number): boolean {
  // Check against gray checker color
  const grayDiff =
    Math.abs(r - CHECKER_GRAY.r) + Math.abs(g - CHECKER_GRAY.g) + Math.abs(b - CHECKER_GRAY.b)
  if (grayDiff <= TOLERANCE * 3) return true

  // Check against white-ish checker color
  const whiteDiff =
    Math.abs(r - CHECKER_WHITE.r) + Math.abs(g - CHECKER_WHITE.g) + Math.abs(b - CHECKER_WHITE.b)
  if (whiteDiff <= TOLERANCE * 3) return true

  return false
}

/**
 * Process a single image: detect and alpha-out checkerboard pixels
 * Uses neighbor-aware clearing to preserve silhouette edges
 */
export async function processImage(imagePath: string): Promise<void> {
  const image = await Jimp.read(imagePath)
  const { width, height, data } = image.bitmap

  // First pass: mark which pixels are checkerboard
  const isChecker = new Array(width * height).fill(false)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const r = data[idx]
      const g = data[idx + 1]
      const b = data[idx + 2]

      if (isCheckerColor(r, g, b)) {
        isChecker[y * width + x] = true
      }
    }
  }

  // Second pass: clear alpha only for pixels whose 8-neighbors are ALL checker
  // This preserves silhouette edges (checker pixels adjacent to non-checker content)
  // For edge pixels (at image boundary), we treat out-of-bounds as "checker" so
  // pure checkerboard backgrounds get fully cleared
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIdx = y * width + x

      if (!isChecker[pixelIdx]) continue

      // Check all 8 neighbors
      let allNeighborsAreChecker = true
      let hasNonCheckerNeighbor = false

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue

          const nx = x + dx
          const ny = y + dy

          // Out of bounds counts as "checker" (allows clearing edge pixels)
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            continue
          }

          if (!isChecker[ny * width + nx]) {
            hasNonCheckerNeighbor = true
            allNeighborsAreChecker = false
            break
          }
        }
        if (hasNonCheckerNeighbor) break
      }

      // Clear alpha if all neighbors are also checker (interior checker pixels)
      // Keep pixels that touch non-checker content (silhouette edges)
      if (allNeighborsAreChecker) {
        const idx = pixelIdx * 4
        data[idx + 3] = 0 // Set alpha to 0
      }
    }
  }

  // Write the processed image back
  await image.write(imagePath)
}

/**
 * Backup original image to original/ subdirectory
 */
async function backupOriginal(imagePath: string): Promise<void> {
  const dir = dirname(imagePath)
  const file = basename(imagePath)
  const backupDir = join(dir, 'original')

  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true })
  }

  const backupPath = join(backupDir, file)

  // Only backup if backup doesn't already exist
  if (!existsSync(backupPath)) {
    await copyFile(imagePath, backupPath)
  }
}

/**
 * Process all PNG files in a directory
 */
export async function processDirectory(dirPath: string): Promise<number> {
  if (!existsSync(dirPath)) {
    throw new Error(`Directory not found: ${dirPath}`)
  }

  const entries = await readdir(dirPath)
  const pngFiles = entries.filter((f) => f.toLowerCase().endsWith('.png'))

  let processed = 0

  for (const file of pngFiles) {
    const filePath = join(dirPath, file)
    const fileStat = await stat(filePath)

    if (!fileStat.isFile()) continue

    // Skip files in the original/ subdirectory
    if (filePath.includes('/original/') || filePath.includes('\\original\\')) {
      continue
    }

    // Backup original first
    await backupOriginal(filePath)

    // Process the image
    await processImage(filePath)
    processed++

    console.log(`Processed: ${file}`)
  }

  return processed
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('chromakey.ts')) {
  const targetDir = process.argv[2]

  if (!targetDir) {
    console.error('Usage: tsx scripts/chromakey.ts <directory>')
    process.exit(1)
  }

  processDirectory(targetDir)
    .then((count) => {
      console.log(`\nChromakey complete: ${count} images processed`)
    })
    .catch((err) => {
      console.error('Error:', err.message)
      process.exit(1)
    })
}
