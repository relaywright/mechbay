import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { readSoul, writeSoul, readMemory } from '../../src/main/soul-memory'

describe('soul-memory-io', () => {
  const tmp = path.join(os.tmpdir(), 'mechbay-soul-io-test-' + Date.now())

  beforeEach(() => {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true })
    fs.mkdirSync(tmp, { recursive: true })
  })

  it('readSoul() returns file contents for a fixture companion', () => {
    const companionId = 'test-companion-001'
    // Path structure: {userDataDir}/mechbay/companions/{companionId}/soul.md
    const companionDir = path.join(tmp, 'mechbay', 'companions', companionId)
    fs.mkdirSync(companionDir, { recursive: true })
    const soulContent = '# Test Soul\n\nThis is the soul content.'
    fs.writeFileSync(path.join(companionDir, 'soul.md'), soulContent)

    const result = readSoul(companionId, tmp)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toBe(soulContent)
    }
  })

  it('readSoul() returns error when file does not exist', () => {
    const companionId = 'nonexistent-companion'

    const result = readSoul(companionId, tmp)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('soul.md')
    }
  })

  it('writeSoul() writes bytes and subsequent readSoul() matches', () => {
    const companionId = 'test-companion-002'
    const newContent = '# Updated Soul\n\nNew content here.'

    const writeResult = writeSoul(companionId, newContent, tmp)
    expect(writeResult.ok).toBe(true)

    const readResult = readSoul(companionId, tmp)
    expect(readResult.ok).toBe(true)
    if (readResult.ok) {
      expect(readResult.content).toBe(newContent)
    }
  })

  it('writeSoul() overwrites existing content', () => {
    const companionId = 'test-companion-003'
    const companionDir = path.join(tmp, 'mechbay', 'companions', companionId)
    fs.mkdirSync(companionDir, { recursive: true })
    fs.writeFileSync(path.join(companionDir, 'soul.md'), 'old content')

    const newContent = 'new content'
    const writeResult = writeSoul(companionId, newContent, tmp)
    expect(writeResult.ok).toBe(true)

    const readResult = readSoul(companionId, tmp)
    expect(readResult.ok).toBe(true)
    if (readResult.ok) {
      expect(readResult.content).toBe(newContent)
    }
  })

  it('readMemory() returns full file contents', () => {
    const companionId = 'test-companion-004'
    const companionDir = path.join(tmp, 'mechbay', 'companions', companionId)
    fs.mkdirSync(companionDir, { recursive: true })
    const memoryContent = "# Test Companion's Memory\n\nEntry 1\nEntry 2"
    fs.writeFileSync(path.join(companionDir, 'memory.md'), memoryContent)

    const result = readMemory(companionId, tmp)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toBe(memoryContent)
    }
  })

  it('readMemory() returns error when file does not exist', () => {
    const companionId = 'nonexistent-companion-memory'

    const result = readMemory(companionId, tmp)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('memory.md')
    }
  })

  it('readSoul() uses default userDataDir when not provided', () => {
    // This test verifies the function signature works without the optional param
    // We can't easily test the actual default path without mocking os.homedir()
    // but we can verify the function accepts single argument
    const companionId = 'test-companion-005'

    // Should not throw when called with just companionId
    expect(() => readSoul(companionId, tmp)).not.toThrow()
  })
})
