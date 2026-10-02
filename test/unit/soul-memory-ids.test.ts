import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readMemory, readSoul, writeSoul } from '../../src/main/soul-memory'

/**
 * Journal calls take a companion ID from the renderer and join it into a
 * path. Only a plain ID may get through: anything that could climb out of
 * <userData>/mechbay/companions is refused before the disk is touched.
 */

const BAD_IDS = ['../../outside', '..', '../../../outside', 'a/b', 'C:\\x', '', 'a'.repeat(65)]

let root: string
let userData: string

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
}

beforeEach(() => {
  // userData sits one level inside root, so an escape that climbs above
  // userData still lands somewhere this test can see.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mechbay-soul-ids-'))
  userData = path.join(root, 'userData')
  fs.mkdirSync(userData)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('soul-memory companion ID validation', () => {
  it.each(BAD_IDS)('refuses to write soul.md for companion ID %j', (companionId) => {
    const result = writeSoul(companionId, 'planted', userData)

    expect(result.ok).toBe(false)
    expect(filesUnder(root)).toEqual([])
  })

  it.each(BAD_IDS)('refuses to read soul.md or memory.md for companion ID %j', (companionId) => {
    // Plant the files the bad ID would reach if it were joined unchecked,
    // so a pass means "refused", not "nothing there to read".
    const reached = path.join(userData, 'mechbay', 'companions', companionId)
    if (reached.startsWith(root + path.sep)) {
      try {
        fs.mkdirSync(reached, { recursive: true })
        fs.writeFileSync(path.join(reached, 'soul.md'), 'outside soul')
        fs.writeFileSync(path.join(reached, 'memory.md'), 'outside memory')
      } catch {
        // Not a valid folder name on this OS (e.g. "C:\x" on Windows).
      }
    }

    expect(readSoul(companionId, userData).ok).toBe(false)
    expect(readMemory(companionId, userData).ok).toBe(false)
  })

  it('still reads and writes a real companion ID', () => {
    const companionId = '01JABCDEFGHJKMNPQRSTVWXYZ0'

    expect(writeSoul(companionId, '# Soul\nSteady.', userData)).toEqual({ ok: true })
    expect(readSoul(companionId, userData)).toEqual({ ok: true, content: '# Soul\nSteady.' })
    expect(
      fs.existsSync(path.join(userData, 'mechbay', 'companions', companionId, 'soul.md'))
    ).toBe(true)

    fs.writeFileSync(
      path.join(userData, 'mechbay', 'companions', companionId, 'memory.md'),
      '# Memory'
    )
    expect(readMemory(companionId, userData)).toEqual({ ok: true, content: '# Memory' })
  })
})
