import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { bootLines, bootTimings } from '../../src/renderer/src/components/boot-splash'

const LINES = bootLines('9.9.9')

describe('boot splash lines', () => {
  it('shows the version it is given, never a hard-coded one', () => {
    expect(LINES[0]).toBe('MECHBAY OS v9.9.9 · COMBINE STANDARD BOOT')
    expect(bootLines('1.4.1')[0]).toContain('v1.4.1')
  })

  it('contains no em dashes', () => {
    expect(LINES.join('\n')).not.toContain('\u2014')
  })

  it('gets the version from package.json at build time', async () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }
    const config = (await import('../../electron.vite.config')).default as {
      renderer?: { define?: Record<string, string> }
    }
    expect(config.renderer?.define?.__APP_VERSION__).toBe(JSON.stringify(pkg.version))
  })
})

describe('boot splash schedule', () => {
  it('types every line sequentially across the full boot window', () => {
    const timings = bootTimings(false, LINES)

    expect(timings.sequenceDuration).toBe(2200)
    expect(timings.fadeDuration).toBe(400)
    expect(timings.lines.map((line) => line.text)).toEqual(LINES)
    expect(timings.lines[0].startAt).toBe(0)
    expect(timings.lines.at(-1)?.endAt).toBe(2200)
    timings.lines.slice(1).forEach((line, index) => {
      expect(line.startAt).toBe(timings.lines[index].endAt)
    })
  })

  it('shows the complete text briefly with no animation when motion is reduced', () => {
    const timings = bootTimings(true, LINES)

    expect(timings).toMatchObject({ sequenceDuration: 0, holdDuration: 600, fadeDuration: 0 })
    expect(timings.lines.every((line) => line.startAt === 0 && line.endAt === 0)).toBe(true)
  })
})
